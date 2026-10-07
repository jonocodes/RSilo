import { Hono } from 'hono';
import { authMiddleware, requireScope } from '../middleware/auth';
import { buildKey, getStorage } from '../services/r2';
import { isValidPath, normalizeETag, stripQuotes, createEmptyFolder } from '../protocol/constants';
import type { TokenPayload } from '../services/auth';
import type { StorageInterface } from '../types';
import { deleteUserObject, putUserObject, QuotaExceededError, StorageAccountingError } from '../services/quota-storage';
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

storageRouter.use('/*', authMiddleware());

storageRouter.get('/:username/public', async (c) => {
  return c.redirect('/storage/' + c.req.param('username') + '/public/', 301);
});

storageRouter.get('/:username/public/*', async (c) => {
  const username = c.req.param('username') || '';
  const fullPath = c.req.path;
  return handlePublicStorageGet(c, username, fullPath);
});

storageRouter.get('/:username/*', requireScope('r'), async (c) => {
  const username = c.req.param('username') || '';
  const fullPath = c.req.path;
  return handleStorageGet(c, username, fullPath);
});

storageRouter.put('/:username/*', requireScope('rw'), async (c) => {
  const username = c.req.param('username') || '';
  const fullPath = c.req.path;
  return handleStoragePut(c, username, fullPath);
});

storageRouter.delete('/:username/*', requireScope('rw'), async (c) => {
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

async function handlePublicStorageGet(c: any, username: string, fullPath: string): Promise<Response> {
  const path = extractStoragePath(fullPath, username);
  const storage = getStorage(c);

  if (path === '' || path.endsWith('/')) {
    const payload = c.get('tokenPayload') as TokenPayload | undefined;
    if (!payload || payload.sub !== username) {
      return c.text('Unauthorized', 401, { 'WWW-Authenticate': 'Bearer realm="storage"' });
    }
    return handleFolderGet(c, storage, username, path);
  }

  if (!isValidPath(path)) {
    return c.text('Invalid path', 400);
  }

  const key = buildKey(username, path);

  const result = await storage.get(key);
  if (!result) {
    return c.text('Not Found', 404);
  }

  const etag = normalizeETag(result.metadata.etag);

  const ifNoneMatch = c.req.header('If-None-Match');
  if (ifNoneMatch && etag) {
    const requestedEtags = ifNoneMatch.split(',').map((e: string) => stripQuotes(e.trim()));
    if (requestedEtags.includes(stripQuotes(etag))) {
      return new Response(null, { status: 304 });
    }
  }

  return new Response(result.body, {
    status: 200,
    headers: {
      'Content-Type': result.metadata.contentType,
      'Content-Length': result.metadata.contentLength.toString(),
      'ETag': etag || '',
      'Cache-Control': 'no-cache',
      'Content-Encoding': 'identity',
      'Last-Modified': httpDate(result.metadata.lastModified),
    },
  });
}

async function handleStorageGet(c: any, username: string, fullPath: string): Promise<Response> {
  const path = extractStoragePath(fullPath, username);

  const payload = c.get('tokenPayload') as TokenPayload | undefined;
  if (!payload || payload.sub !== username) {
    return c.text('Forbidden', 403, { 'WWW-Authenticate': 'Bearer realm="storage"' });
  }

  if (!isValidPath(path)) {
    return c.text('Invalid path', 400);
  }

  const isFolderRequest = path === '' || path.endsWith('/');
  const key = buildKey(username, path);

  const storage = getStorage(c);

  if (isFolderRequest) {
    return handleFolderGet(c, storage, username, path);
  }

  const result = await storage.get(key);
  if (!result) {
    return c.text('Not Found', 404);
  }

  const etag = normalizeETag(result.metadata.etag);

  const ifNoneMatch = c.req.header('If-None-Match');
  if (ifNoneMatch && etag) {
    const requestedEtags = ifNoneMatch.split(',').map((e: string) => stripQuotes(e.trim()));
    if (requestedEtags.includes(stripQuotes(etag))) {
      return new Response(null, { status: 304 });
    }
  }

  return new Response(result.body, {
    status: 200,
    headers: {
      'Content-Type': result.metadata.contentType,
      'Content-Length': result.metadata.contentLength.toString(),
      'ETag': etag || '',
      'Cache-Control': 'no-cache',
      'Content-Encoding': 'identity',
      'Last-Modified': httpDate(result.metadata.lastModified),
    },
  });
}

async function handleFolderGet(c: any, storage: StorageInterface, username: string, path: string): Promise<Response> {
  const folderPath = path === '' || path.endsWith('/') ? path : path + '/';
  const folderKey = buildKey(username, folderPath);

  const { objects } = await storage.list(folderKey);

  const items: Record<string, any> = {};
  const folderChildren: Record<string, string[]> = {};

  for (const obj of objects) {
    const relativePath = obj.key.slice(folderKey.length);
    if (!relativePath) continue;
    const isFolder = relativePath.endsWith('/');
    const segments = relativePath.split('/').filter(Boolean);
    if (!isFolder && segments.length === 1) {
      items[segments[0]] = {
        ETag: stripQuotes(obj.etag),
        'Content-Type': obj.contentType || 'application/octet-stream',
        'Content-Length': obj.size,
        'Last-Modified': httpDate(obj.lastModified),
      };
    } else {
      const folderName = segments[0] + '/';
      (folderChildren[folderName] ||= []).push(`${relativePath}:${obj.etag}`);
      if (!items[folderName]) items[folderName] = { ETag: '' };
    }
  }

  for (const [folderName, children] of Object.entries(folderChildren)) {
    items[folderName].ETag = await shortHash(children.sort().join('\n'));
  }

  const folder = createEmptyFolder();
  folder.items = items;

  const folderJson = JSON.stringify(folder);
  const etag = `"${await shortHash(folderJson)}"`;

  const ifNoneMatch = c.req.header('If-None-Match');
  if (ifNoneMatch) {
    const requestedEtags = ifNoneMatch.split(',').map((e: string) => stripQuotes(e.trim()));
    if (requestedEtags.includes(stripQuotes(etag))) {
      return new Response(null, { status: 304, headers: { 'ETag': etag, 'Cache-Control': 'no-cache' } });
    }
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

  const payload = c.get('tokenPayload') as TokenPayload | undefined;
  if (!payload || payload.sub !== username) {
    return c.text('Forbidden', 403, { 'WWW-Authenticate': 'Bearer realm="storage"' });
  }

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
  const existing = await storage.head(key);
  const currentEtag = existing ? normalizeETag(existing.etag) : null;

  const ifNoneMatch = c.req.header('If-None-Match');
  if (ifNoneMatch === '*' && currentEtag) {
    return c.text('Precondition Failed', 412);
  }

  const ifMatch = c.req.header('If-Match');
  if (ifMatch) {
    if (!currentEtag) {
      return c.text('Precondition Failed', 412);
    }
    if (ifMatch !== '*' && stripQuotes(ifMatch) !== stripQuotes(currentEtag)) {
      return c.text('Precondition Failed', 412);
    }
  }

  const contentType = c.req.header('Content-Type') || 'application/octet-stream';
  let newEtag: string;
  try {
    newEtag = await putUserObject({
      storage,
      db: (c.env as any).DB,
      allowUnaccounted: isLocalDevelopment(c.env),
      username,
      key,
      body,
      contentType,
      existing,
    });
  } catch (error) {
    if (error instanceof QuotaExceededError) return c.text('Storage quota exceeded', 413);
    if (error instanceof StorageAccountingError) return c.text(error.message, 503);
    throw error;
  }

  return c.text('', existing ? 200 : 201, {
    'ETag': normalizeETag(newEtag) || '',
  });
}

async function handleStorageDelete(c: any, username: string, fullPath: string): Promise<Response> {
  const path = extractStoragePath(fullPath, username);

  const payload = c.get('tokenPayload') as TokenPayload | undefined;
  if (!payload || payload.sub !== username) {
    return c.text('Forbidden', 403, { 'WWW-Authenticate': 'Bearer realm="storage"' });
  }

  if (!isValidPath(path)) {
    return c.text('Invalid path', 400);
  }

  if (path.endsWith('/')) {
    return c.text("can't delete folder directly", 400);
  }

  const key = buildKey(username, path);
  const storage = getStorage(c);

  const existing = await storage.head(key);

  const ifMatch = c.req.header('If-Match');
  if (ifMatch) {
    if (!existing) {
      return c.text('Precondition Failed', 412);
    }
    const currentEtag = normalizeETag(existing.etag) || '';
    if (ifMatch !== '*' && stripQuotes(ifMatch) !== stripQuotes(currentEtag)) {
      return c.text('Precondition Failed', 412);
    }
  }

  if (!existing) {
    return c.text('Not Found', 404);
  }

  try {
    await deleteUserObject({
      storage,
      db: (c.env as any).DB,
      allowUnaccounted: isLocalDevelopment(c.env),
      username,
      key,
      existing,
    });
  } catch (error) {
    if (error instanceof StorageAccountingError) return c.text(error.message, 503);
    throw error;
  }

  return new Response(null, { status: 200, headers: { 'ETag': normalizeETag(existing.etag) || '' } });
}