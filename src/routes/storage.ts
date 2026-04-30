import { Hono } from 'hono';
import { authMiddleware, requireScope } from '../middleware/auth';
import { buildKey } from '../services/r2';
import { isValidPath, normalizeETag, stripQuotes, createEmptyFolder } from '../protocol/constants';
import type { TokenPayload } from '../services/auth';
import type { LocalStorage } from '../services/local-storage';

type StorageInterface = {
  get(key: string): Promise<{ body: ArrayBuffer; metadata: { contentType: string; contentLength: number; etag: string; lastModified?: string } } | null>;
  put(key: string, body: ArrayBuffer, contentType: string): Promise<string>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<{ contentType: string; contentLength: number; etag: string; lastModified?: string } | null>;
  list(prefix: string): Promise<{ key: string; size: number; etag: string }[]>;
};

function getStorage(c: any): StorageInterface {
  return c.env.STORAGE as StorageInterface;
}

type Params = { username: string };

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

  const kv = c.env.RATE_LIMIT_KV;
  if (kv && typeof kv.get === 'function') {
    const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';
    const identifier = `ip:${ip}`;

    const now = Date.now();
    const windowMs = 60000;
    const maxRequests = 100;
    const key = `ratelimit:${identifier}`;

    const current = await kv.get(key, 'json') as { count: number; windowStart: number } | null;

    if (current && current.windowStart > now - windowMs && current.count >= maxRequests) {
      return c.text('Rate limit exceeded', 429, {
        'Retry-After': Math.ceil((current.windowStart + windowMs - now) / 1000).toString(),
        'X-RateLimit-Limit': maxRequests.toString(),
        'X-RateLimit-Remaining': '0',
      });
    }

    const newCount = current && current.windowStart > now - windowMs ? current.count + 1 : 1;
    const windowStart = current && current.windowStart > now - windowMs ? current.windowStart : now;
    await kv.put(key, JSON.stringify({ count: newCount, windowStart }), { expirationTtl: Math.ceil(windowMs / 1000) });
  }

  await next();
});

storageRouter.use('/*', authMiddleware());

storageRouter.get('/:username/public/*', async (c) => {
  const username = c.req.param('username') || '';
  const fullPath = c.req.path;
  return handlePublicStorageGet(c, username, fullPath);
});

storageRouter.get('/:username/public', async (c) => {
  return c.redirect('/storage/' + c.req.param('username') + '/public/', 301);
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

storageRouter.options('/*', (c) => {
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

async function handlePublicStorageGet(c: any, username: string, fullPath: string): Promise<Response> {
  const path = extractStoragePath(fullPath, username);

  if (path.endsWith('/')) {
    return c.text('Unauthorized', 401, { 'WWW-Authenticate': 'Bearer realm="storage"' });
  }

  if (!isValidPath(path)) {
    return c.text('Invalid path', 400);
  }

  const key = buildKey(username, path);
  const storage = getStorage(c);

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
      'Cache-Control': 'public, no-cache',
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

  const isFolderRequest = path.endsWith('/');
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
    },
  });
}

async function handleFolderGet(c: any, storage: StorageInterface, username: string, path: string): Promise<Response> {
  const folderPath = path.endsWith('/') ? path : path + '/';
  const folderKey = buildKey(username, folderPath);

  const objects = await storage.list(folderKey);
  const allObjects = 'objects' in objects ? objects.objects : objects;

  const items: Record<string, { ETag: string }> = {};
  const seenFolders = new Set<string>();

  for (const obj of allObjects) {
    const relativePath = obj.key.slice(folderKey.length);
    const segments = relativePath.split('/').filter(Boolean);
    if (segments.length === 1) {
      items[segments[0]] = { ETag: obj.etag };
    } else if (segments.length > 1) {
      const folderName = segments[0] + '/';
      if (!seenFolders.has(folderName)) {
        seenFolders.add(folderName);
        items[folderName] = { ETag: '' };
      }
    }
  }

  const folder = createEmptyFolder();
  folder.items = items;

  const folderJson = JSON.stringify(folder);
  const hash = folderJson.split('').reduce((a: number, b: string) => a + b.charCodeAt(0), 0);
  const etag = `"${hash.toString(16)}"`;

  return new Response(folderJson, {
    status: 200,
    headers: {
      'Content-Type': 'application/ld+json; charset=utf-8',
      'ETag': etag,
      'Cache-Control': 'no-cache',
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

  const key = buildKey(username, path);
  const storage = getStorage(c);

  const body = await c.req.arrayBuffer();
  const bodySize = body.byteLength;

  const db = c.env.DB as any;
  if (db && typeof db.prepare === 'function') {
    const userResult = await db.prepare(
      'SELECT storage_quota_bytes, used_storage_bytes FROM users WHERE username = ?'
    ).bind(username).first<{ storage_quota_bytes: number; used_storage_bytes: number }>();

    if (userResult) {
      const availableQuota = userResult.storage_quota_bytes - userResult.used_storage_bytes;
      if (bodySize > availableQuota) {
        return c.text('Storage quota exceeded', 413);
      }
    }
  }

  const existing = await storage.head(key);
  const currentEtag = existing ? normalizeETag(existing.etag) : null;

  const ifNoneMatch = c.req.header('If-None-Match');
  if (ifNoneMatch === '*' && currentEtag) {
    return c.text('Precondition Failed', 412);
  }

  const ifMatch = c.req.header('If-Match');
  if (ifMatch && currentEtag && stripQuotes(ifMatch) !== stripQuotes(currentEtag)) {
    return c.text('Precondition Failed', 412);
  }

  const contentType = c.req.header('Content-Type') || 'application/octet-stream';
  const newEtag = await storage.put(key, body, contentType);

  if (db && typeof db.prepare === 'function') {
    await db.prepare(
      'UPDATE users SET used_storage_bytes = used_storage_bytes + ? WHERE username = ?'
    ).bind(bodySize, username).run();
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
  if (!existing) {
    return c.text('Not Found', 404);
  }

  await storage.delete(key);

  return new Response(null, { status: 204, headers: { 'ETag': normalizeETag(existing.etag) || '' } });
}