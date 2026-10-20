import { Hono } from 'hono';
import { storageAuth } from '../middleware/auth';
import { requireAccountRow, requireInstanceConfig } from '../middleware/instance';
import { buildKey, getStorage } from '../services/r2';
import { isValidPath, normalizeETag, stripQuotes, createEmptyFolder } from '../protocol/constants';
import type { Context, StorageInterface } from '../types';
import { deleteUserObject, putUserObject, QuotaExceededError, StorageAccountingError } from '../services/quota-storage';
import { PathConflictError, PreconditionFailedError } from '../services/storage-errors';
import { isLocalDevelopment } from '../config';
import { enforceRateLimit, rateLimiterUnavailable, trustedClientIp } from '../services/rate-limit';
import { maxObjectSize, ObjectTooLargeError, readRequestBody } from '../services/object-size';

export const storageRouter = new Hono();

storageRouter.use('/*', async (c, next) => {
  const url = new URL(c.req.url);

  if (url.pathname.includes('/../') || url.pathname.includes('/..')) {
    return c.text('Invalid path', 400);
  }

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.some(s => s === '..')) {
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

storageRouter.options('/*', () => {
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-Match, If-None-Match, Origin, X-Requested-With');
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Max-Age', '86400');
  headers.set('Access-Control-Expose-Headers', 'ETag');
  return new Response('', { status: 204, headers });
});

function extractStoragePath(fullPath: string, username: string): string {
  const prefix = `/storage/${username}/`;
  return fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath.slice('/storage/'.length);
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
  const path = extractStoragePath(fullPath, username);

  if (!isValidPath(path)) {
    return c.text('Invalid path', 400);
  }

  const isFolderRequest = path === '' || path.endsWith('/');
  const key = buildKey(username, path);

  const storage = getStorage(c);

  if (isFolderRequest) {
    return handleFolderGet(c, storage, username, path);
  }

  // HEAD and a conditional GET are answered from metadata, without
  // downloading the body. A conditional GET whose ETag no longer matches then
  // takes a second call, the GET below.
  const isHead = c.req.method === 'HEAD';
  if (isHead || c.req.header('If-None-Match')) {
    const metadata = await storage.head(key);
    if (!metadata) return c.text('Not Found', 404);
    const etag = normalizeETag(metadata.etag) || '';
    if (ifNoneMatchIncludes(c, etag)) {
      return new Response(null, { status: 304, headers: { 'ETag': etag, 'Cache-Control': 'no-cache' } });
    }
    if (isHead) return new Response(null, { status: 200, headers: documentHeaders(metadata) });
  }

  const result = await storage.get(key);
  if (!result) {
    return c.text('Not Found', 404);
  }
  return new Response(result.body, { status: 200, headers: documentHeaders(result.metadata) });
}

function documentHeaders(metadata: { contentType: string; contentLength: number; etag: string; lastModified?: string }): Record<string, string> {
  return {
    'Content-Type': metadata.contentType,
    'Content-Length': metadata.contentLength.toString(),
    'ETag': normalizeETag(metadata.etag) || '',
    'Cache-Control': 'no-cache',
    'Content-Encoding': 'identity',
    'Last-Modified': httpDate(metadata.lastModified),
    ...DOCUMENT_HEADERS,
  };
}

function ifNoneMatchIncludes(c: Context, etag: string): boolean {
  const ifNoneMatch = c.req.header('If-None-Match');
  if (!ifNoneMatch || !etag) return false;
  return ifNoneMatch.split(',').map((e) => stripQuotes(e.trim())).includes(stripQuotes(etag));
}

async function handleFolderGet(c: any, storage: StorageInterface, username: string, path: string): Promise<Response> {
  const folderPath = path === '' || path.endsWith('/') ? path : path + '/';
  const folderKey = buildKey(username, folderPath);

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
  const etag = `"${await folderVersion(documents)}"`;

  if (ifNoneMatchIncludes(c, etag)) {
    return new Response(null, { status: 304, headers: { 'ETag': etag, 'Cache-Control': 'no-cache' } });
  }

  return new Response(folderJson, {
    status: 200,
    headers: {
      'Content-Type': 'application/ld+json; charset=utf-8',
      'ETag': etag,
      'Cache-Control': 'no-cache',
      'Content-Encoding': 'identity',
    },
  });
}

async function handleStoragePut(c: any, username: string, fullPath: string): Promise<Response> {
  const path = extractStoragePath(fullPath, username);

  if (!isValidPath(path)) {
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
  const path = extractStoragePath(fullPath, username);

  if (!isValidPath(path)) {
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
