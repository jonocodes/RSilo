import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createServer } from '../src/index';
import { seedToken } from './helpers/tokens';
import { createSqliteD1 } from '../src/services/db/sqlite';
import { MemoryStorage } from './helpers/memory-storage';

const storage = new MemoryStorage();

const TEST_ENV = {
  STORAGE: storage,
  DB: createSqliteD1(),
};

describe('PUT + GET storage', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer(TEST_ENV);
  });

  beforeEach(() => {
    storage.objects.clear();
  });

  it('PUT a document and GET it back', async () => {
    const token = seedToken(TEST_ENV, 'alice');
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

    expect(putRes.status).toBe(201);

    const getRes = await app.request(
      'http://localhost/storage/alice/documents/test.txt',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('Content-Type')).toContain('text/plain');
    expect(await getRes.text()).toBe(body);
  });

  it('GET returns ETag header', async () => {
    const token = seedToken(TEST_ENV, 'alice');

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
    const token = seedToken(TEST_ENV, 'alice');

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

describe('Object size limits', () => {
  it('rejects an oversized upload before storing it', async () => {
    const app = createServer(TEST_ENV);
    const token = seedToken(TEST_ENV, 'alice');
    const env = { ...TEST_ENV, MAX_OBJECT_SIZE_BYTES: '4' };
    const res = await app.request('http://localhost/storage/alice/documents/large.txt', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/plain',
        'Content-Length': '5',
      },
      body: '12345',
    }, env);

    expect(res.status).toBe(413);
    expect(storage.objects.has('users/alice/storage/documents/large.txt')).toBe(false);
  });
});

describe('DELETE storage', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer(TEST_ENV);
  });

  beforeEach(() => {
    storage.objects.clear();
  });

  it('DELETE removes file', async () => {
    const token = seedToken(TEST_ENV, 'alice');

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
    const token = seedToken(TEST_ENV, 'alice');

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
    const token = seedToken(TEST_ENV, 'alice');

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
    storage.objects.clear();
  });

  it('HEAD returns headers without body', async () => {
    const token = seedToken(TEST_ENV, 'alice');

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
    const token = seedToken(TEST_ENV, 'alice');

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
    storage.objects.clear();
  });

  it('GET folder listing returns JSON with items', async () => {
    const token = seedToken(TEST_ENV, 'alice');

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

    const json = await getRes.json() as any;
    expect(json['@context']).toBe('http://remotestorage.io/spec/folder-description');
    expect(json.items).toBeDefined();
    expect(Object.keys(json.items).length).toBeGreaterThanOrEqual(2);
  });

  it('GET folder listing includes direct children only', async () => {
    const token = seedToken(TEST_ENV, 'alice');

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
    const json = await getRes.json() as any;
    expect(json.items).toBeDefined();
    const itemKeys = Object.keys(json.items);
    expect(itemKeys).toContain('level1/');
  });

  it('GET empty folder listing returns empty items', async () => {
    const token = seedToken(TEST_ENV, 'alice');

    const getRes = await app.request(
      'http://localhost/storage/alice/documents/empty-folder/',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(getRes.status).toBe(200);
    const json = await getRes.json() as any;
    expect(json.items).toEqual({});
  });

  it("a subfolder's ETag in its parent listing is the ETag it serves, until a descendant changes", async () => {
    const token = seedToken(TEST_ENV, 'alice');
    const put = (body: string) => app.request(
      'http://localhost/storage/alice/documents/a/b/c',
      { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' }, body },
      TEST_ENV
    );
    const get = (path: string, headers: Record<string, string> = {}) => app.request(
      `http://localhost/storage/alice/documents/${path}`,
      { method: 'GET', headers: { 'Authorization': `Bearer ${token}`, ...headers } },
      TEST_ENV
    );
    const listedETag = async () => ((await (await get('a/')).json()) as any).items['b/'].ETag as string;

    await put('one');
    const listed = await listedETag();
    const served = (await get('a/b/')).headers.get('ETag');
    expect(served).toBe(`"${listed}"`);
    expect((await get('a/b/', { 'If-None-Match': served! })).status).toBe(304);

    await put('two');
    const relisted = await listedETag();
    expect(relisted).not.toBe(listed);
    expect((await get('a/b/')).headers.get('ETag')).toBe(`"${relisted}"`);
    expect((await get('a/b/', { 'If-None-Match': served! })).status).toBe(200);
  });
});

describe('Path validation', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer(TEST_ENV);
  });

  it('path with double dots returns 400 or 404', async () => {
    const token = seedToken(TEST_ENV, 'alice');

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
    const token = seedToken(TEST_ENV, 'alice');

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
    const token = seedToken(TEST_ENV, 'alice');

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
    const token = seedToken(TEST_ENV, 'alice');

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
    const token = seedToken(TEST_ENV, 'alice');

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
          'If-Match': etag!,
        },
        body: 'updated',
      },
      TEST_ENV
    );

    expect(putRes2.status).toBeOneOf([200, 204]);
  });

  it('PUT with stale If-Match returns 412', async () => {
    const token = seedToken(TEST_ENV, 'alice');

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
    const token = seedToken(TEST_ENV, 'alice');

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
    const token = seedToken(TEST_ENV, 'alice');

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
          'If-None-Match': etag!,
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
    const token = seedToken(TEST_ENV, 'alice', 'documents:rw');
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
    // A root-level name, so it needs the root scope, as public/ itself does.
    const token = seedToken(TEST_ENV, 'alice', '*:r');
    const res = await app.request(
      'http://localhost/storage/alice/public',
      { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } },
      TEST_ENV
    );
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/storage/alice/public/');
  });

  it('serves public and private documents sandboxed and unsniffable, still readable cross-origin', async () => {
    const token = seedToken(TEST_ENV, 'alice', 'documents:rw');
    const origin = 'https://app.example';
    for (const path of ['public/documents/page.html', 'documents/page.html']) {
      await app.request(
        `http://localhost/storage/alice/${path}`,
        { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/html' }, body: '<script>alert(1)</script>' },
        TEST_ENV
      );
      const headers: Record<string, string> = { 'Origin': origin };
      if (!path.startsWith('public/')) headers['Authorization'] = `Bearer ${token}`;
      const res = await app.request(`http://localhost/storage/alice/${path}`, { method: 'GET', headers }, TEST_ENV);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Security-Policy')).toBe('sandbox');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Cross-Origin-Resource-Policy')).toBeNull();
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      expect(res.headers.get('Access-Control-Expose-Headers')).toBe('ETag, Content-Length, Content-Type');
    }
  });
});

describe('Public folder listings', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(async () => {
    app = createServer(TEST_ENV);
    storage.objects.clear();
    const token = seedToken(TEST_ENV, 'alice', 'documents:rw');
    await app.request(
      'http://localhost/storage/alice/public/documents/shared.txt',
      { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: 'shared' },
      TEST_ENV
    );
  });

  const get = (path: string, scopes: string) => app.request(
    `http://localhost/storage/alice/${path}`,
    { method: 'GET', headers: { 'Authorization': `Bearer ${seedToken(TEST_ENV, 'alice', scopes)}` } },
    TEST_ENV
  );

  it("needs the module's read scope, like a private listing", async () => {
    const otherModule = await get('public/documents/', 'pictures:r');
    expect(otherModule.status).toBe(403);
    expect(otherModule.headers.get('WWW-Authenticate')).toContain('scope="documents:r"');

    const sameModule = await get('public/documents/', 'documents:r');
    expect(sameModule.status).toBe(200);
    expect(Object.keys((await sameModule.json() as any).items)).toEqual(['shared.txt']);
  });

  it('needs the root scope for public/ itself', async () => {
    expect((await get('public/', 'documents:r')).status).toBe(403);
    expect((await get('public/', '*:r')).status).toBe(200);
  });

  it('leaves public documents readable whatever the token covers', async () => {
    expect((await get('public/documents/shared.txt', 'pictures:r')).status).toBe(200);
  });

  it('only treats /storage/<user>/public/ as public, not a public/ folder deeper in a module', async () => {
    const res = await app.request(
      'http://localhost/storage/alice/documents/public/x.txt',
      { method: 'GET', headers: { 'Authorization': 'Bearer not-a-token' } },
      TEST_ENV
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('error="invalid_token"');
  });
});

describe('DB-backed OAuth token auth', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer(TEST_ENV);
  });

  beforeEach(() => {
    storage.objects.clear();
  });

  it('accepts a valid DB-backed OAuth token for storage access', async () => {
    const dbEnv = {
      STORAGE: TEST_ENV.STORAGE,
      DB: createSqliteD1(),
    };
    const dbToken = seedToken(dbEnv, 'alice', 'documents:rw');

    const putRes = await app.request(
      'http://localhost/storage/alice/documents/db-token-test.txt',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${dbToken}`, 'Content-Type': 'text/plain' },
        body: 'hello',
      },
      dbEnv
    );
    expect(putRes.status).toBe(201);
  });

  it('rejects an expired DB-backed OAuth token', async () => {
    const dbEnv = {
      STORAGE: TEST_ENV.STORAGE,
      DB: createSqliteD1(),
    };
    const expiredToken = seedToken(dbEnv, 'alice', 'documents:rw', { expiresAt: Math.floor(Date.now() / 1000) - 1 });

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

  beforeEach(() => {
    storage.objects.clear();
  });

  beforeAll(() => {
    app = createServer(TEST_ENV);
  });

  it('PUT increments used_storage_bytes in DB', async () => {
    const dbEnv = {
      STORAGE: TEST_ENV.STORAGE,
      DB: createSqliteD1(),
    };
    const token = seedToken(dbEnv, 'alice');

    const body = 'hello storage';
    const res = await app.request('http://localhost/storage/alice/documents/track.txt', {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body,
    }, dbEnv);

    expect(res.status).toBeOneOf([200, 201]);
    const row = dbEnv.DB.sqlite.prepare('SELECT used_storage_bytes AS used FROM users WHERE username = ?').get('alice') as any;
    expect(row.used).toBe(new TextEncoder().encode(body).byteLength);
  });

  it('DELETE decrements used_storage_bytes in DB', async () => {
    const fileBody = new TextEncoder().encode('to be deleted');
    storage.seed('users/alice/storage/documents/todelete.txt', fileBody);

    const dbEnv = {
      STORAGE: TEST_ENV.STORAGE,
      DB: createSqliteD1(),
    };
    const token = seedToken(dbEnv, 'alice');
    dbEnv.DB.sqlite.prepare('UPDATE users SET used_storage_bytes = ? WHERE username = ?').run(fileBody.byteLength, 'alice');

    await app.request('http://localhost/storage/alice/documents/todelete.txt', {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    }, dbEnv);

    const row = dbEnv.DB.sqlite.prepare('SELECT used_storage_bytes AS used FROM users WHERE username = ?').get('alice') as any;
    expect(row.used).toBe(0);
  });

  it('answers 503 and leaves storage alone when usage cannot be recorded', async () => {
    const db = createSqliteD1();
    const dbEnv = {
      STORAGE: TEST_ENV.STORAGE,
      // Token checks work; the accounting UPDATE fails, as on a D1 outage mid-request.
      DB: { ...db, prepare: (sql: string) => {
        if (sql.startsWith('UPDATE users SET used_storage_bytes')) throw new Error('D1 unavailable');
        return db.prepare(sql);
      } },
    };
    const token = seedToken(dbEnv, 'alice');
    const url = 'http://localhost/storage/alice/documents/unaccounted.txt';

    const put = await app.request(url, { method: 'PUT', headers: { 'Authorization': `Bearer ${token}` }, body: 'x' }, dbEnv);
    expect(put.status).toBe(503);
    expect(storage.objects.size).toBe(0);

    storage.seed('users/alice/storage/documents/unaccounted.txt', 'x');
    const del = await app.request(url, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } }, dbEnv);
    expect(del.status).toBe(503);
    expect(storage.objects.has('users/alice/storage/documents/unaccounted.txt')).toBe(true);
  });
});