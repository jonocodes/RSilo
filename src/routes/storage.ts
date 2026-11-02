import { Hono } from 'hono';
import { storageAuth } from '../middleware/auth';
import { requireAccountRow, requireInstanceConfig } from '../middleware/instance';
import { buildKey, getStorage } from '../services/r2';
import { FOLDER_MIME_TYPE, normalizeETag, stripQuotes, createEmptyFolder } from '../protocol/constants';
import { decodeItemPath } from '../protocol/item-path';
import { contentRange, parseRange, type ByteRange } from '../protocol/range';
import type { Context, StorageInterface } from '../types';
import { deleteUserObject, putUserObject, QuotaExceededError, StorageAccountingError } from '../services/quota-storage';
import { PathConflictError, PreconditionFailedError } from '../services/storage-errors';
import { readFolderEtag, storeFolderEtag, type FolderEtagDatabase } from '../services/folder-etags';
import { isLocalDevelopment } from '../config';
import { enforceRateLimit, rateLimiterUnavailable, trustedClientIp } from '../services/rate-limit';
import { maxObjectSize, ObjectTooLargeError, readRequestBody } from '../services/object-size';

export const storageRouter = new Hono();

storageRouter.use('/*', async (c, next) => {
  const url = new URL(c.req.url);

  // Dot segments, raw or encoded. Names merely containing dots ("..a") are
  // fine; protocol/item-path.ts checks each name.
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.some(s => s === '..' || s.toLowerCase() === '%2e%2e')) {
    return c.text('Invalid path', 400);
  }

  const startIdx = segments[0] === 'storage' ? 1 : 0;
  const usernameFromPath = segments[startIdx];

  if (!usernameFromPath || usernameFromPath === '..') {
    return c.text('Invalid path', 400);
  }

  const unavailable = rateLimiterUnavailable(c, 'STORAGE_LIMITER');
  if (unavailable) return unavailable;

  await next();

  // Only failed authentication is counted: a valid token's damage is bounded
  // by its quota, while a sync legitimately fetches thousands of documents.
  // Keyed by IP alone so varying the username in the path does not reset it.
  if (c.res.status === 401) {
    const rateLimited = await enforceRateLimit(c, {
      limiter: 'STORAGE_LIMITER',
      key: `storage-auth:ip:${trustedClientIp(c)}`,
    });
    if (rateLimited) c.res = rateLimited;
  }
});

// Storage serves only the Account: any other username is refused before auth,
// so other users' legacy tokens stop working. The refusal is the protocol's
// 401/403 (what clients expect for a root their token does not cover), not a
// 404. It also needs the Account row (quota counter); in the username-mismatch
// state every storage request is refused with 503.
storageRouter.use('/*', requireInstanceConfig());
storageRouter.use('/:username/*', async (c, next) => {
  if (c.req.param('username') === c.get('instance').accountUsername) return next();
  return c.req.header('Authorization')
    ? c.text('Forbidden', 403, { 'WWW-Authenticate': 'Bearer realm="storage"' })
    : c.text('Unauthorized', 401, { 'WWW-Authenticate': 'Bearer realm="storage"' });
});
storageRouter.use('/*', requireAccountRow());

// Every storage request is authorized here, once (services/auth.ts authorize).
// Public documents are readable by anyone, but a public folder listing is a
// normal folder read: it needs `<module>:r` (`*:r` for `public/` itself).
storageRouter.use('/*', storageAuth());

storageRouter.get('/:username/public', async (c) => {
  return c.redirect('/storage/' + c.req.param('username') + '/public/', 301);
});

const getRoute = (c: Context) => handleStorageGet(c, c.req.param('username') || '', c.req.path);
// The same GET; registered on its own so the API docs list public reads.
storageRouter.get('/:username/public/*', getRoute);
storageRouter.get('/:username/*', getRoute);

storageRouter.put('/:username/*', async (c) => {
  const username = c.req.param('username') || '';
  const fullPath = c.req.path;
  return handleStoragePut(c, username, fullPath);
});

storageRouter.delete('/:username/*', async (c) => {
  const username = c.req.param('username') || '';
  const fullPath = c.req.path;
  return handleStorageDelete(c, username, fullPath);
});

// The decoded path below the user's storage root, or null if it is not made of
// valid item names. fullPath is the raw request path (see rawRequestPath).
function storagePath(fullPath: string, username: string): string | null {
  const prefix = `/storage/${encodeURIComponent(username)}/`;
  const raw = fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath.slice('/storage/'.length);
  return decodeItemPath(raw);
}

function httpDate(value?: string): string {
  const date = value ? new Date(value) : new Date();
  return isNaN(date.getTime()) ? new Date().toUTCString() : date.toUTCString();
}

async function shortHash(input: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

// A folder's version: a hash of every document below it, as its path relative
// to the folder plus its ETag. The parent's listing entry for a folder and the
// folder's own GET hash the same inputs, so they agree and clients get a 304
// until a descendant changes.
function folderVersion(documents: { path: string; etag: string }[]): Promise<string> {
  return shortHash(documents.map(d => `${d.path}:${stripQuotes(d.etag)}`).sort().join('\n'));
}

// Documents are app-supplied but served from the account origin: a browser
// opening one must not run it there, nor sniff a more dangerous type.
const DOCUMENT_HEADERS = {
  'Content-Security-Policy': 'sandbox',
  'X-Content-Type-Options': 'nosniff',
};

async function handleStorageGet(c: any, username: string, fullPath: string): Promise<Response> {
  const path = storagePath(fullPath, username);

  if (path === null) {
    return c.text('Invalid path', 400);
  }

  const isFolderRequest = path === '' || path.endsWith('/');
  const key = buildKey(username, path);

  const storage = getStorage(c);

  if (isFolderRequest) {
    return handleFolderGet(c, storage, username, path);
  }

  // HEAD, a conditional GET and a range are answered from metadata first,
  // without downloading the body. A conditional GET whose ETag no longer
  // matches then takes a second call, the GET below; a range needs the size.
  const isHead = c.req.method === 'HEAD';
  const rangeHeader = isHead ? undefined : c.req.header('Range');
  if (isHead || c.req.header('If-None-Match') || rangeHeader) {
    const metadata = await storage.head(key);
    if (!metadata) return c.text('Not Found', 404);
    const etag = normalizeETag(metadata.etag) || '';
    if (ifNoneMatchIncludes(c, etag)) {
      return new Response(null, { status: 304, headers: { 'ETag': etag, 'Cache-Control': 'no-cache' } });
    }
    if (isHead) return new Response(null, { status: 200, headers: documentHeaders(metadata) });
    if (rangeHeader) {
      const range = parseRange(rangeHeader, metadata.contentLength);
      if (range === 'unsatisfiable') {
        return c.text('Range Not Satisfiable', 416, { 'Content-Range': `bytes */${metadata.contentLength}` });
      }
      if (range) return serveRange(c, storage, key, range, metadata.contentLength);
    }
  }

  const result = await storage.get(key);
  if (!result) {
    return c.text('Not Found', 404);
  }
  return new Response(result.body, { status: 200, headers: documentHeaders(result.metadata) });
}

// A single byte range of a document of `size` bytes (protocol/range.ts).
async function serveRange(c: Context, storage: StorageInterface, key: string, range: ByteRange, size: number): Promise<Response> {
  const result = await storage.get(key, { range });
  if (!result) return c.text('Not Found', 404);
  let body = result.body;
  if (body instanceof ArrayBuffer && body.byteLength !== range.length) {
    // the storage backend returned the whole object
    body = body.slice(range.offset, range.offset + range.length);
  }
  return new Response(body, {
    status: 206,
    headers: {
      ...documentHeaders(result.metadata),
      'Content-Length': range.length.toString(),
      'Content-Range': contentRange(range, size),
    },
  });
}

function documentHeaders(metadata: { contentType: string; contentLength: number; etag: string; lastModified?: string }): Record<string, string> {
  return {
    'Content-Type': metadata.contentType,
    'Content-Length': metadata.contentLength.toString(),
    'ETag': normalizeETag(metadata.etag) || '',
    'Cache-Control': 'no-cache',
    'Content-Encoding': 'identity',
    'Last-Modified': httpDate(metadata.lastModified),
    'Accept-Ranges': 'bytes',
    ...DOCUMENT_HEADERS,
  };
}

function ifNoneMatchIncludes(c: Context, etag: string): boolean {
  const ifNoneMatch = c.req.header('If-None-Match');
  if (!ifNoneMatch || !etag) return false;
  return ifNoneMatch.split(',').map((e) => stripQuotes(e.trim())).includes(stripQuotes(etag));
}

// The folder ETag cache (services/folder-etags.ts, a D1 table). Computing a
// folder's ETag lists its whole subtree, and clients re-check each folder they
// sync every few seconds, so the ETag is memoized per folder:
// - Every write and delete (quota-storage.ts) bumps the version of each folder
//   above the document, which invalidates their cached ETags.
// - A GET or HEAD with a valid cached ETag answers 304, or a HEAD's headers,
//   from that one row, without listing. A 200 still lists, for the body.
// - Otherwise the folder is listed as before and its ETag cached against the
//   version read before listing (compare-and-set), so a write that lands
//   mid-listing leaves nothing cached.
// The cached value is the same content-derived folderVersion(), so it keeps
// agreeing with the parent's listing entry. Subfolder ETags in a listing are
// not cached: a client only GETs a subfolder whose ETag changed, which needs
// the body, so a listing for it is made either way. Changes made to the bucket
// directly show after FOLDER_ETAG_MAX_AGE_SECONDS at most.
async function handleFolderGet(c: any, storage: StorageInterface, username: string, path: string): Promise<Response> {
  const folderPath = path === '' || path.endsWith('/') ? path : path + '/';
  const folderKey = buildKey(username, folderPath);

  // Storage auth already requires the DB; a cache failure only costs a listing.
  const db: FolderEtagDatabase | undefined = c.env?.DB;
  const cached = db ? await readFolderEtag(db, username, folderPath).catch(logCacheFailure) : undefined;
  if (cached?.etag) {
    const etag = `"${cached.etag}"`;
    if (ifNoneMatchIncludes(c, etag)) return notModified(etag);
    if (c.req.method === 'HEAD') return new Response(null, { status: 200, headers: folderHeaders(etag) });
  }

  const { objects } = await storage.list(folderKey);

  const items: Record<string, any> = {};
  // Directory markers (keys ending in `/`, which some S3 tools create) are not
  // documents, so they never count towards a folder's version.
  const documents: { path: string; etag: string }[] = [];
  const subfolderDocuments: Record<string, { path: string; etag: string }[]> = {};

  for (const obj of objects) {
    const relativePath = obj.key.slice(folderKey.length);
    if (!relativePath) continue;
    const isFolder = relativePath.endsWith('/');
    const segments = relativePath.split('/').filter(Boolean);
    if (!isFolder) documents.push({ path: relativePath, etag: obj.etag });
    if (!isFolder && segments.length === 1) {
      items[segments[0]] = {
        ETag: stripQuotes(obj.etag),
        'Content-Type': obj.contentType || 'application/octet-stream',
        'Content-Length': obj.size,
        'Last-Modified': httpDate(obj.lastModified),
      };
    } else {
      const folderName = segments[0] + '/';
      const children = (subfolderDocuments[folderName] ||= []);
      if (!isFolder) children.push({ path: relativePath.slice(folderName.length), etag: obj.etag });
      if (!items[folderName]) items[folderName] = { ETag: '' };
    }
  }

  for (const [folderName, children] of Object.entries(subfolderDocuments)) {
    items[folderName].ETag = await folderVersion(children);
  }

  const folder = createEmptyFolder();
  folder.items = items;

  const folderJson = JSON.stringify(folder);
  const version = await folderVersion(documents);
  const etag = `"${version}"`;
  if (db && cached) await storeFolderEtag(db, username, folderPath, cached.version, version).catch(logCacheFailure);

  if (ifNoneMatchIncludes(c, etag)) return notModified(etag);
  return new Response(folderJson, { status: 200, headers: folderHeaders(etag) });
}

function notModified(etag: string): Response {
  return new Response(null, { status: 304, headers: { 'ETag': etag, 'Cache-Control': 'no-cache' } });
}

function folderHeaders(etag: string): Record<string, string> {
  return {
    'Content-Type': FOLDER_MIME_TYPE,
    'ETag': etag,
    'Cache-Control': 'no-cache',
    'Content-Encoding': 'identity',
  };
}

function logCacheFailure(error: unknown): undefined {
  console.error('Folder ETag cache unavailable', error);
  return undefined;
}

async function handleStoragePut(c: any, username: string, fullPath: string): Promise<Response> {
  const path = storagePath(fullPath, username);

  if (path === null) {
    return c.text('Invalid path', 400);
  }

  if (path.endsWith('/')) {
    return c.text("can't write to folder", 400);
  }

  if (c.req.header('Content-Range')) {
    return c.text('Content-Range is not supported', 400);
  }

  const key = buildKey(username, path);
  const storage = getStorage(c);

  let body: ArrayBuffer;
  try {
    body = await readRequestBody(c.req.raw, maxObjectSize(c.env));
  } catch (error) {
    if (error instanceof ObjectTooLargeError) return c.text(error.message, 413);
    throw error;
  }

  try {
    const { etag, created } = await putUserObject({
      storage,
      db: (c.env as any).DB,
      allowUnaccounted: isLocalDevelopment(c.env),
      username,
      key,
      body,
      contentType: c.req.header('Content-Type') || 'application/octet-stream',
      condition: { ifMatch: c.req.header('If-Match'), ifNoneMatch: c.req.header('If-None-Match') },
    });
    return c.text('', created ? 201 : 200, { 'ETag': normalizeETag(etag) || '' });
  } catch (error) {
    return writeErrorResponse(c, error);
  }
}

async function handleStorageDelete(c: any, username: string, fullPath: string): Promise<Response> {
  const path = storagePath(fullPath, username);

  if (path === null) {
    return c.text('Invalid path', 400);
  }

  if (path.endsWith('/')) {
    return c.text("can't delete folder directly", 400);
  }

  try {
    const etag = await deleteUserObject({
      storage: getStorage(c),
      db: (c.env as any).DB,
      allowUnaccounted: isLocalDevelopment(c.env),
      username,
      key: buildKey(username, path),
      ifMatch: c.req.header('If-Match'),
    });
    if (etag === null) return c.text('Not Found', 404);
    return new Response(null, { status: 200, headers: { 'ETag': normalizeETag(etag) || '' } });
  } catch (error) {
    return writeErrorResponse(c, error);
  }
}

// The protocol's answers for a write that storage refused (the account UI
// uses them too). Anything else is rethrown.
export function writeErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof PreconditionFailedError) return c.text('Precondition Failed', 412);
  if (error instanceof PathConflictError) return c.text(error.message, 409);
  if (error instanceof QuotaExceededError) return c.text('Storage quota exceeded', 507);
  if (error instanceof StorageAccountingError) return c.text(error.message, 503);
  throw error;
}
