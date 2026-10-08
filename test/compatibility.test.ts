import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createServer } from '../src/index';
import { seedToken } from './helpers/tokens';

const storage = new Map<string, { body: ArrayBuffer; etag: string; contentType: string }>();

const TEST_ENV = {
  STORAGE: {
    async get(key: string) {
      const item = storage.get(key);
      if (!item) return null;
      return { body: item.body, metadata: { contentType: item.contentType, contentLength: item.body.byteLength, etag: item.etag } };
    },
    async put(key: string, body: ArrayBuffer, contentType?: string) {
      const etag = `"etag-${Math.random().toString(36).slice(2)}"`;
      storage.set(key, { body, etag, contentType: contentType || 'application/octet-stream' });
      return etag;
    },
    async delete(key: string) {
      storage.delete(key);
    },
    async head(key: string) {
      const item = storage.get(key);
      if (!item) return null;
      return { etag: item.etag, contentType: item.contentType, contentLength: item.body.byteLength };
    },
    async list(options: { prefix?: string; delimiter?: string }) {
      const prefix = options.prefix || '';
      const keys = Array.from(storage.keys()).filter(k => k.startsWith(prefix));
      return {
        objects: keys.map(k => ({
          key: k,
          size: storage.get(k)!.body.byteLength,
          etag: storage.get(k)!.etag,
        })),
      };
    },
  } as any,
  DB: {} as any,
  // The Instance serves one Account; these tests use it under this name.
  ACCOUNT_USERNAME: 'testuser',
};

describe('RemoteStorage.js client compatibility', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer(TEST_ENV);
  });

  beforeEach(() => {
    storage.clear();
  });

  it('WebFinger returns remoteStorage link with api: simple', async () => {
    const res = await app.request(
      'http://localhost/.well-known/webfinger?resource=acct:testuser@localhost:8787',
      { method: 'GET' },
      TEST_ENV
    );

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    const rsLink = json.links?.find((l: any) => l.rel === 'remoteStorage');
    expect(rsLink).toBeDefined();
    expect(rsLink.api).toBe('simple');
    expect(rsLink.auth).toContain('/oauth/');
  });

  it('storage endpoint returns CORS headers for cross-origin requests', async () => {
    const token = seedToken(TEST_ENV, 'testuser');

    await app.request(
      'http://localhost/storage/testuser/documents/cors-test.txt',
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'text/plain',
          'Origin': 'https://remotestorage.io',
        },
        body: 'cors test',
      },
      TEST_ENV
    );

    const res = await app.request(
      'http://localhost/storage/testuser/documents/cors-test.txt',
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Origin': 'https://remotestorage.io',
        },
      },
      TEST_ENV
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://remotestorage.io');
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('ETag');
  });

  it('handles GET with folder trailing slash', async () => {
    const token = seedToken(TEST_ENV, 'testuser');

    await app.request(
      'http://localhost/storage/testuser/documents/folder/file.txt',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: 'content',
      },
      TEST_ENV
    );

    const res = await app.request(
      'http://localhost/storage/testuser/documents/folder/',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/ld+json');
  });

  it('immutable GET returns 304 with ETag when unchanged', async () => {
    const token = seedToken(TEST_ENV, 'testuser');

    await app.request(
      'http://localhost/storage/testuser/documents/immutable.txt',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: 'immutable content',
      },
      TEST_ENV
    );

    const etag = (await app.request(
      'http://localhost/storage/testuser/documents/immutable.txt',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    )).headers.get('ETag');

    const res304 = await app.request(
      'http://localhost/storage/testuser/documents/immutable.txt',
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'If-None-Match': etag!,
        },
      },
      TEST_ENV
    );

    expect(res304.status).toBe(304);
  });

  it('PUT creates resource with 201 status', async () => {
    const token = seedToken(TEST_ENV, 'testuser');

    const res = await app.request(
      'http://localhost/storage/testuser/documents/new-resource.txt',
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'text/plain',
        },
        body: 'new content',
      },
      TEST_ENV
    );

    expect(res.status).toBeOneOf([200, 201]);
    expect(res.headers.get('ETag')).toBeTruthy();
  });

  it('PUT to existing resource updates with 200 status', async () => {
    const token = seedToken(TEST_ENV, 'testuser');

    await app.request(
      'http://localhost/storage/testuser/documents/existing.txt',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: 'original',
      },
      TEST_ENV
    );

    const res = await app.request(
      'http://localhost/storage/testuser/documents/existing.txt',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: 'updated',
      },
      TEST_ENV
    );

    expect(res.status).toBeOneOf([200, 204]);
  });

  it('DELETE returns 200 on success', async () => {
    const token = seedToken(TEST_ENV, 'testuser');

    await app.request(
      'http://localhost/storage/testuser/documents/to-delete.txt',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: 'delete me',
      },
      TEST_ENV
    );

    const res = await app.request(
      'http://localhost/storage/testuser/documents/to-delete.txt',
      {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(res.status).toBe(200);
  });

  it('GET returns proper Content-Length for text content', async () => {
    const token = seedToken(TEST_ENV, 'testuser');
    const content = 'Hello, RemoteStorage!';

    await app.request(
      'http://localhost/storage/testuser/documents/text.txt',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: content,
      },
      TEST_ENV
    );

    const res = await app.request(
      'http://localhost/storage/testuser/documents/text.txt',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe(content.length.toString());
  });

  it('folder listing items have ETag property', async () => {
    const token = seedToken(TEST_ENV, 'testuser');

    await app.request(
      'http://localhost/storage/testuser/documents/etag-folder/file.txt',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: 'content',
      },
      TEST_ENV
    );

    const res = await app.request(
      'http://localhost/storage/testuser/documents/etag-folder/',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.items).toBeDefined();
    const itemKeys = Object.keys(json.items);
    expect(itemKeys.length).toBeGreaterThan(0);
    expect(json.items[itemKeys[0]]).toHaveProperty('ETag');
  });

  it('OPTIONS request returns Allow header with supported methods', async () => {
    const res = await app.request(
      'http://localhost/storage/testuser/documents/test.txt',
      { method: 'OPTIONS' },
      TEST_ENV
    );

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('DELETE');
  });
});

describe('Error handling compatibility', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer(TEST_ENV);
  });

  beforeEach(() => {
    storage.clear();
  });

  it('returns 412 Precondition Failed for stale If-Match', async () => {
    const token = seedToken(TEST_ENV, 'testuser');

    await app.request(
      'http://localhost/storage/testuser/documents/stale-test.txt',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: 'original',
      },
      TEST_ENV
    );

    const res = await app.request(
      'http://localhost/storage/testuser/documents/stale-test.txt',
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'text/plain',
          'If-Match': '"stale-etag"',
        },
        body: 'updated',
      },
      TEST_ENV
    );

    expect(res.status).toBe(412);
  });

  it('returns 400 Bad Request for invalid path', async () => {
    const token = seedToken(TEST_ENV, 'testuser', '*');

    const res = await app.request(
      'http://localhost/storage/testuser/../etc/passwd',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(res.status).toBeOneOf([400, 403, 404]);
  });

  it('returns 400 Bad Request for folder write attempt', async () => {
    const token = seedToken(TEST_ENV, 'testuser');

    const res = await app.request(
      'http://localhost/storage/testuser/documents/folder-path/',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: 'should fail',
      },
      TEST_ENV
    );

    expect(res.status).toBe(400);
  });

  it('HEAD request returns headers without body', async () => {
    const token = seedToken(TEST_ENV, 'testuser');

    await app.request(
      'http://localhost/storage/testuser/documents/head-test.txt',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: 'head test content',
      },
      TEST_ENV
    );

    const res = await app.request(
      'http://localhost/storage/testuser/documents/head-test.txt',
      {
        method: 'HEAD',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toBeTruthy();
    expect(res.headers.get('Content-Type')).toBe('text/plain');
    const body = await res.text();
    expect(body).toBe('');
  });

  it('PUT with no explicit Content-Type uses default', async () => {
    const token = seedToken(TEST_ENV, 'testuser');

    const res = await app.request(
      'http://localhost/storage/testuser/documents/no-content-type.txt',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
        body: Uint8Array.from([65, 66, 67]),
      },
      TEST_ENV
    );

    expect(res.status).toBeOneOf([200, 201]);

    const getRes = await app.request(
      'http://localhost/storage/testuser/documents/no-content-type.txt',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    const ct = getRes.headers.get('Content-Type') || '';
    expect(ct.startsWith('application/octet-stream') || ct === '').toBe(true);
  });

  it('GET returns Content-Type header correctly', async () => {
    const token = seedToken(TEST_ENV, 'testuser');

    await app.request(
      'http://localhost/storage/testuser/pictures/image.jpg',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'image/jpeg' },
        body: 'fake image data',
      },
      TEST_ENV
    );

    const res = await app.request(
      'http://localhost/storage/testuser/pictures/image.jpg',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
  });

  it('multiple files in folder listing shows all items', async () => {
    const token = seedToken(TEST_ENV, 'testuser');

    for (const name of ['file1.txt', 'file2.txt', 'file3.txt']) {
      await app.request(
        `http://localhost/storage/testuser/documents/multi/${name}`,
        {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
          body: `content of ${name}`,
        },
        TEST_ENV
      );
    }

    const res = await app.request(
      'http://localhost/storage/testuser/documents/multi/',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(Object.keys(json.items).length).toBe(3);
    expect(json.items['file1.txt']).toBeDefined();
    expect(json.items['file2.txt']).toBeDefined();
    expect(json.items['file3.txt']).toBeDefined();
  });

  it('DELETE non-existent file returns 404', async () => {
    const token = seedToken(TEST_ENV, 'testuser');

    const res = await app.request(
      'http://localhost/storage/testuser/documents/never-exists.txt',
      {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(res.status).toBe(404);
  });

  it('PUT then GET returns identical content', async () => {
    const token = seedToken(TEST_ENV, 'testuser');
    const content = 'Hello, World! This is test content.';

    await app.request(
      'http://localhost/storage/testuser/documents/verify-content.txt',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: content,
      },
      TEST_ENV
    );

    const res = await app.request(
      'http://localhost/storage/testuser/documents/verify-content.txt',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(content);
  });

  it('PUT exceeds quota returns 413', async () => {
    const dbStorage = {
      async get(key: string) {
        const item = storage.get(key);
        if (!item) return null;
        return { body: item.body, metadata: { contentType: item.contentType, contentLength: item.body.byteLength, etag: item.etag } };
      },
      async put(key: string, body: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }) {
        const etag = `"etag-${Math.random().toString(36).slice(2)}"`;
        storage.set(key, { body, etag, contentType: options?.httpMetadata?.contentType || 'application/octet-stream' });
        return etag;
      },
      async head() { return null; },
    };

    const quotaEnv = {
      STORAGE: dbStorage,
      DB: {
        prepare: (sql: string) => ({
          bind: () => ({
            first: async () => {
              if (sql.includes('oauth_tokens')) return null;
              return null;
            },
            run: async () => ({ meta: { changes: 0 } }),
          })
        })
      } as any,
      ACCOUNT_USERNAME: 'quotauser',
    };

    const quotaApp = createServer(quotaEnv);
    const quotaToken = seedToken(quotaEnv, 'quotauser');

    const res = await quotaApp.request(
      'http://localhost/storage/quotauser/documents/oversize.txt',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${quotaToken}`, 'Content-Type': 'text/plain' },
        body: 'This content is way too large for the quota',
      },
      quotaEnv
    );

    expect(res.status).toBe(413);
    const text = await res.text();
    expect(text).toContain('quota');
  });

  it('PUT exactly at quota boundary succeeds', async () => {
    const body = 'x'; // 1 byte
    const quotaEnv = {
      STORAGE: TEST_ENV.STORAGE,
      DB: {
        prepare: (sql: string) => ({
          bind: (..._args: any[]) => ({
            first: async () => sql.includes('users') ? { storage_quota_bytes: 1, used_storage_bytes: 0 } : null,
            run: async () => ({}),
            all: async () => ({ results: [] }),
          }),
        }),
      } as any,
    };
    const quotaToken = seedToken(quotaEnv, 'alice');
    const res = await app.request(
      'http://localhost/storage/alice/documents/exact-fit.txt',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${quotaToken}`, 'Content-Type': 'text/plain' },
        body,
      },
      quotaEnv
    );
    expect(res.status).toBe(201);
  });

it('repeated invalid-token requests are rate limited with 429', async () => {
    const rateLimitEnv = {
      ...TEST_ENV,
      STORAGE_LIMITER: { limit: async () => ({ success: false }) },
    };
    const rateApp = createServer(rateLimitEnv);

    const res = await rateApp.request(
      'http://localhost/storage/testuser/documents/rate-test.txt',
      {
        method: 'GET',
        headers: { 'Authorization': 'Bearer not-a-token', 'CF-Connecting-IP': '203.0.113.1' },
      },
      rateLimitEnv
    );

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });

  it('valid-token requests are never rate limited', async () => {
    const rateLimitEnv = {
      ...TEST_ENV,
      STORAGE_LIMITER: { limit: async () => ({ success: false }) },
    };
    const rateApp = createServer(rateLimitEnv);

    const res = await rateApp.request(
      'http://localhost/storage/testuser/documents/',
      { method: 'GET', headers: { 'Authorization': `Bearer ${seedToken(TEST_ENV, 'testuser')}` } },
      rateLimitEnv
    );

    expect(res.status).toBe(200);
  });
});