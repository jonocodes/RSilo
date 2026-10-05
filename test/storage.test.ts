import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createServer, createTestToken } from '../src/index';

const storage = new Map<string, { body: ArrayBuffer; etag: string; contentType: string }>();

const TEST_ENV = {
  STORAGE: {
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
};

describe('PUT + GET storage', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer(TEST_ENV);
  });

  beforeEach(() => {
    storage.clear();
  });

  it('PUT a document and GET it back', async () => {
    const token = createTestToken('alice');
    const body = 'hello remote storage';

    const putRes = await app.request(
      'http://localhost/storage/alice/documents/test.txt',
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'text/plain',
          'Content-Length': body.length.toString(),
        },
        body,
      },
      TEST_ENV
    );

    expect([200, 201, 204]).toContain(putRes.status);

    const getRes = await app.request(
      'http://localhost/storage/alice/documents/test.txt',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe(body);
  });

  it('GET returns ETag header', async () => {
    const token = createTestToken('alice');

    await app.request(
      'http://localhost/storage/alice/documents/etag-test',
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'text/plain',
        },
        body: 'etag content',
      },
      TEST_ENV
    );

    const getRes = await app.request(
      'http://localhost/storage/alice/documents/etag-test',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(getRes.status).toBe(200);
    const etag = getRes.headers.get('ETag');
    expect(etag).toBeTruthy();
    expect(etag).toMatch(/^"[^"]+"$/);
  });

  it('GET missing document returns 404', async () => {
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/does-not-exist',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(res.status).toBe(404);
  });

  it('PUT without auth returns 401', async () => {
    const res = await app.request(
      'http://localhost/storage/alice/documents/test.txt',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: 'test',
      },
      TEST_ENV
    );

    expect(res.status).toBe(401);
  });

  it('OPTIONS returns CORS headers', async () => {
    const res = await app.request(
      'http://localhost/storage/alice/documents/test.txt',
      { method: 'OPTIONS' },
      TEST_ENV
    );

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });
});

describe('DELETE storage', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer(TEST_ENV);
  });

  beforeEach(() => {
    storage.clear();
  });

  it('DELETE removes file', async () => {
    const token = createTestToken('alice');

    await app.request(
      'http://localhost/storage/alice/documents/to-delete',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: 'delete me',
      },
      TEST_ENV
    );

    const delRes = await app.request(
      'http://localhost/storage/alice/documents/to-delete',
      {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(delRes.status).toBe(200);

    const getRes = await app.request(
      'http://localhost/storage/alice/documents/to-delete',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(getRes.status).toBe(404);
  });

  it('DELETE missing file returns 404', async () => {
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/never-existed',
      {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(res.status).toBe(404);
  });

  it('DELETE returns ETag header', async () => {
    const token = createTestToken('alice');

    await app.request(
      'http://localhost/storage/alice/documents/delete-with-etag',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: 'content',
      },
      TEST_ENV
    );

    const delRes = await app.request(
      'http://localhost/storage/alice/documents/delete-with-etag',
      {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(delRes.status).toBe(200);
    const etag = delRes.headers.get('ETag');
    expect(etag).toMatch(/^"[^"]+"$/);
  });
});

describe('HEAD storage', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer(TEST_ENV);
  });

  beforeEach(() => {
    storage.clear();
  });

  it('HEAD returns headers without body', async () => {
    const token = createTestToken('alice');

    await app.request(
      'http://localhost/storage/alice/documents/head-test',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: 'head content',
      },
      TEST_ENV
    );

    const headRes = await app.request(
      'http://localhost/storage/alice/documents/head-test',
      {
        method: 'HEAD',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(headRes.status).toBe(200);
    expect(headRes.headers.get('ETag')).toBeTruthy();
    expect(headRes.headers.get('Content-Length')).toBe('12');
    expect(headRes.headers.get('Content-Type')).toBeTruthy();
  });

  it('HEAD missing file returns 404', async () => {
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/never-existed',
      {
        method: 'HEAD',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(res.status).toBe(404);
  });
});

describe('Folder listing', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer(TEST_ENV);
  });

  beforeEach(() => {
    storage.clear();
  });

  it('GET folder listing returns JSON with items', async () => {
    const token = createTestToken('alice');

    await app.request(
      'http://localhost/storage/alice/documents/folder-test/file1.txt',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: 'file1',
      },
      TEST_ENV
    );

    await app.request(
      'http://localhost/storage/alice/documents/folder-test/file2.txt',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: 'file2',
      },
      TEST_ENV
    );

    const getRes = await app.request(
      'http://localhost/storage/alice/documents/folder-test/',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('Content-Type')).toContain('application/ld+json');

    const json = await getRes.json();
    expect(json['@context']).toBe('http://remotestorage.io/spec/folder-description');
    expect(json.items).toBeDefined();
    expect(Object.keys(json.items).length).toBeGreaterThanOrEqual(2);
  });

  it('GET folder listing includes direct children only', async () => {
    const token = createTestToken('alice');

    await app.request(
      'http://localhost/storage/alice/documents/nested-test/level1/level2/file.txt',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: 'deep file',
      },
      TEST_ENV
    );

    const getRes = await app.request(
      'http://localhost/storage/alice/documents/nested-test/',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(getRes.status).toBe(200);
    const json = await getRes.json();
    expect(json.items).toBeDefined();
    const itemKeys = Object.keys(json.items);
    expect(itemKeys).toContain('level1/');
  });

  it('GET empty folder listing returns empty items', async () => {
    const token = createTestToken('alice');

    const getRes = await app.request(
      'http://localhost/storage/alice/documents/empty-folder/',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(getRes.status).toBe(200);
    const json = await getRes.json();
    expect(json.items).toEqual({});
  });
});

describe('Path validation', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer(TEST_ENV);
  });

  it('path with double dots returns 400 or 404', async () => {
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/../../../etc/passwd',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(res.status).toBeOneOf([400, 404]);
  });

  it('path with null byte returns 400', async () => {
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/file\u0000name',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(res.status).toBe(400);
  });

  it('PUT to folder path returns 400', async () => {
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/folder-path/',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: 'should fail',
      },
      TEST_ENV
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/folder/i);
  });

  it('DELETE folder path returns 400', async () => {
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/folder-path/',
      {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(res.status).toBe(400);
  });
});

describe('If-Match / If-None-Match', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer(TEST_ENV);
  });

  it('PUT with correct If-Match succeeds', async () => {
    const token = createTestToken('alice');

    const putRes = await app.request(
      'http://localhost/storage/alice/documents/if-match-test',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: 'original',
      },
      TEST_ENV
    );

    const etag = putRes.headers.get('ETag');
    expect(etag).toBeTruthy();

    const putRes2 = await app.request(
      'http://localhost/storage/alice/documents/if-match-test',
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'text/plain',
          'If-Match': etag,
        },
        body: 'updated',
      },
      TEST_ENV
    );

    expect(putRes2.status).toBeOneOf([200, 204]);
  });

  it('PUT with stale If-Match returns 412', async () => {
    const token = createTestToken('alice');

    await app.request(
      'http://localhost/storage/alice/documents/stale-if-match',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: 'original',
      },
      TEST_ENV
    );

    const putRes2 = await app.request(
      'http://localhost/storage/alice/documents/stale-if-match',
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

    expect(putRes2.status).toBe(412);
  });

  it('PUT with If-None-Match:* on existing file returns 412', async () => {
    const token = createTestToken('alice');

    await app.request(
      'http://localhost/storage/alice/documents/existing-file',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: 'original',
      },
      TEST_ENV
    );

    const putRes = await app.request(
      'http://localhost/storage/alice/documents/existing-file',
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'text/plain',
          'If-None-Match': '*',
        },
        body: 'should fail',
      },
      TEST_ENV
    );

    expect(putRes.status).toBe(412);
  });

  it('GET with If-None-Match returns 304 when matching', async () => {
    const token = createTestToken('alice');

    await app.request(
      'http://localhost/storage/alice/documents/304-test',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: 'content',
      },
      TEST_ENV
    );

    const etag = (await app.request(
      'http://localhost/storage/alice/documents/304-test',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    )).headers.get('ETag');

    const getRes = await app.request(
      'http://localhost/storage/alice/documents/304-test',
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'If-None-Match': etag,
        },
      },
      TEST_ENV
    );

    expect(getRes.status).toBe(304);
  });
});

describe('Public storage', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer(TEST_ENV);
  });

  it('GET public file without auth returns 200', async () => {
    const token = createTestToken('alice', 'documents:rw');
    await app.request(
      'http://localhost/storage/alice/public/documents/public-file.txt',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: 'public content',
      },
      TEST_ENV
    );

    const getRes = await app.request(
      'http://localhost/storage/alice/public/documents/public-file.txt',
      { method: 'GET' },
      TEST_ENV
    );

    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe('public content');
    expect(getRes.headers.get('Cache-Control')).toBe('no-cache');
  });

  it('GET public folder without auth returns 401', async () => {
    const getRes = await app.request(
      'http://localhost/storage/alice/public/documents/',
      { method: 'GET' },
      TEST_ENV
    );

    expect(getRes.status).toBe(401);
  });

  it('GET public file that does not exist returns 404', async () => {
    const getRes = await app.request(
      'http://localhost/storage/alice/public/documents/nonexistent.txt',
      { method: 'GET' },
      TEST_ENV
    );

    expect(getRes.status).toBe(404);
  });

  it('GET /storage/:user/public (no trailing slash) with auth redirects to /public/', async () => {
    const token = createTestToken('alice', 'public:rw');
    const res = await app.request(
      'http://localhost/storage/alice/public',
      { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } },
      TEST_ENV
    );
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/storage/alice/public/');
  });
});

describe('DB-backed OAuth token auth', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer(TEST_ENV);
  });

  beforeEach(() => {
    storage.clear();
  });

  it('accepts a valid DB-backed OAuth token for storage access', async () => {
    const dbToken = 'real-oauth-access-token';
    const dbEnv = {
      STORAGE: TEST_ENV.STORAGE,
      DB: {
        prepare: (sql: string) => ({
          bind: (..._args: any[]) => ({
            first: async () => {
              if (sql.includes('oauth_tokens')) {
                return {
                  access_token: dbToken,
                  user_id: 'alice',
                  scopes: 'documents:rw',
                  expires_at: Math.floor(Date.now() / 1000) + 3600,
                  created_at: Math.floor(Date.now() / 1000),
                };
              }
              return null;
            },
            run: async () => ({}),
            all: async () => ({ results: [] }),
          }),
        }),
      } as any,
    };

    const putRes = await app.request(
      'http://localhost/storage/alice/documents/db-token-test.txt',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${dbToken}`, 'Content-Type': 'text/plain' },
        body: 'hello',
      },
      dbEnv
    );
    expect([200, 201]).toContain(putRes.status);
  });

  it('rejects an expired DB-backed OAuth token', async () => {
    const expiredToken = 'expired-oauth-token';
    const dbEnv = {
      STORAGE: TEST_ENV.STORAGE,
      DB: {
        prepare: () => ({
          bind: (..._args: any[]) => ({
            first: async () => null,
            run: async () => ({}),
          }),
        }),
      } as any,
    };

    const res = await app.request(
      'http://localhost/storage/alice/documents/test.txt',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${expiredToken}` },
      },
      dbEnv
    );
    expect(res.status).toBe(401);
  });
});

describe('Storage quota — tracking', () => {
  let app: ReturnType<typeof createServer>;
  const token = createTestToken('alice');

  beforeEach(() => {
    storage.clear();
  });

  beforeAll(() => {
    app = createServer(TEST_ENV);
  });

  it('PUT increments used_storage_bytes in DB', async () => {
    let updatedBytes: number | null = null;
    const dbEnv = {
      STORAGE: TEST_ENV.STORAGE,
      DB: {
        prepare: (sql: string) => ({
          bind: (...args: any[]) => ({
            first: async () => sql.includes('users') ? { storage_quota_bytes: 1000000, used_storage_bytes: 0 } : null,
            run: async () => {
              if (sql.includes('used_storage_bytes') && sql.includes('UPDATE')) {
                updatedBytes = args[0];
              }
            },
            all: async () => ({ results: [] }),
          }),
        }),
      } as any,
    };

    const body = 'hello storage';
    await app.request('http://localhost/storage/alice/documents/track.txt', {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body,
    }, dbEnv);

    expect(updatedBytes).toBe(new TextEncoder().encode(body).byteLength);
  });

  it('DELETE decrements used_storage_bytes in DB', async () => {
    const fileBody = new TextEncoder().encode('to be deleted');
    storage.set('users/alice/storage/documents/todelete.txt', {
      body: fileBody.buffer,
      etag: '"xyz"',
      contentType: 'text/plain',
    });

    let decrementArg: number | null = null;
    const dbEnv = {
      STORAGE: TEST_ENV.STORAGE,
      DB: {
        prepare: (sql: string) => ({
          bind: (...args: any[]) => ({
            first: async () => null,
            run: async () => {
              if (sql.includes('used_storage_bytes') && sql.includes('UPDATE')) {
                decrementArg = args[0];
              }
            },
            all: async () => ({ results: [] }),
          }),
        }),
      } as any,
    };

    await app.request('http://localhost/storage/alice/documents/todelete.txt', {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    }, dbEnv);

    expect(decrementArg).toBe(fileBody.byteLength);
  });
});