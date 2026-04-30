import { describe, it, expect } from 'vitest';
import { createServer, createTestToken } from '../../src/index';

function createTestEnv() {
  return {
    STORAGE: {
      async get() { return null; },
      async put() { return '"test"'; },
      async delete() {},
      async head() { return null; },
      async list() { return { objects: [] }; },
    } as any,
    DB: {} as any,
    RATE_LIMIT_KV: { async get() { return null; }, async put() {} } as any,
  };
}

describe('Authentication Edge Cases', () => {
  describe('Token Validation', () => {
    it('rejects expired token', async () => {
      const expiredPayload = {
        sub: 'alice',
        scopes: 'documents:rw',
        iat: Math.floor(Date.now() / 1000) - 86400 * 31,
        exp: Math.floor(Date.now() / 1000) - 86400,
      };
      const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
      const payload = btoa(JSON.stringify(expiredPayload));
      const expiredToken = `${header}.${payload}.`;

      const env = createTestEnv();
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/storage/alice/documents/test.txt',
        { method: 'GET', headers: { Authorization: `Bearer ${expiredToken}` } },
        env
      );

      expect(res.status).toBe(401);
    });

    it('rejects malformed JWT', async () => {
      const env = createTestEnv();
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/storage/alice/documents/test.txt',
        { method: 'GET', headers: { Authorization: 'Bearer not-a-jwt' } },
        env
      );

      expect(res.status).toBe(401);
    });

    it('rejects JWT with missing sub claim', async () => {
      const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
      const payload = btoa(JSON.stringify({ scopes: 'documents:rw', iat: Date.now(), exp: Date.now() + 86400 }));
      const tokenWithoutSub = `${header}.${payload}.`;

      const env = createTestEnv();
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/storage/alice/documents/test.txt',
        { method: 'GET', headers: { Authorization: `Bearer ${tokenWithoutSub}` } },
        env
      );

      expect(res.status).toBe(401);
    });

    it('rejects JWT with missing scopes claim', async () => {
      const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
      const payload = btoa(JSON.stringify({ sub: 'alice', iat: Date.now(), exp: Date.now() + 86400 }));
      const tokenWithoutScopes = `${header}.${payload}.`;

      const env = createTestEnv();
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/storage/alice/documents/test.txt',
        { method: 'GET', headers: { Authorization: `Bearer ${tokenWithoutScopes}` } },
        env
      );

      expect(res.status).toBe(401);
    });

    it('rejects Authorization header without Bearer prefix', async () => {
      const env = createTestEnv();
      const app = createServer(env);
      const token = createTestToken('alice');

      const res = await app.request(
        'http://localhost/storage/alice/documents/test.txt',
        { method: 'GET', headers: { Authorization: token } },
        env
      );

      expect(res.status).toBe(401);
    });

    it('accepts valid token with extra whitespace', async () => {
      const storage = {
        async get() { return { body: new TextEncoder().encode('test'), metadata: { contentType: 'text/plain', contentLength: 4, etag: '"test"' } }; },
        async put() { return '"test"'; },
        async delete() {},
        async head() { return { etag: '"test"', contentType: 'text/plain', contentLength: 4 }; },
        async list() { return { objects: [] }; },
      };
      const env = { STORAGE: storage, DB: {}, RATE_LIMIT_KV: {} } as any;
      const app = createServer(env);
      const token = createTestToken('alice');

      const res = await app.request(
        'http://localhost/storage/alice/documents/test.txt',
        { method: 'GET', headers: { Authorization: `Bearer  ${token}` } },
        env
      );

      expect(res.status).toBe(200);
    });
  });

  describe('Scope Edge Cases', () => {
    it('rejects token with empty scopes', async () => {
      const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
      const payload = btoa(JSON.stringify({ sub: 'alice', scopes: '', iat: Date.now(), exp: Date.now() + 86400 }));
      const emptyScopesToken = `${header}.${payload}.`;

      const env = createTestEnv();
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/storage/alice/documents/test.txt',
        { method: 'GET', headers: { Authorization: `Bearer ${emptyScopesToken}` } },
        env
      );

      expect(res.status).toBeOneOf([401, 403]);
    });

    it('token with documents:r cannot PUT to documents', async () => {
      const env = createTestEnv();
      const app = createServer(env);
      const token = createTestToken('alice', 'documents:r');

      const res = await app.request(
        'http://localhost/storage/alice/documents/test.txt',
        { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: 'content' },
        env
      );

      expect(res.status).toBe(403);
    });

    it('token with documents:rw cannot access pictures module', async () => {
      const env = createTestEnv();
      const app = createServer(env);
      const token = createTestToken('alice', 'documents:rw');

      const res = await app.request(
        'http://localhost/storage/alice/pictures/test.jpg',
        { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' }, body: new ArrayBuffer(10) },
        env
      );

      expect(res.status).toBe(403);
    });

    it('partial scope match is not enough (documents:rw vs documents:r required)', async () => {
      const env = createTestEnv();
      const app = createServer(env);
      const token = createTestToken('alice', 'documents:r');

      const res = await app.request(
        'http://localhost/storage/alice/documents/test.txt',
        { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: 'content' },
        env
      );

      expect(res.status).toBe(403);
    });
  });

  describe('User Matching', () => {
    it('token sub must match storage username', async () => {
      const env = createTestEnv();
      const app = createServer(env);
      const bobToken = createTestToken('bob');

      const res = await app.request(
        'http://localhost/storage/alice/documents/test.txt',
        { method: 'GET', headers: { Authorization: `Bearer ${bobToken}` } },
        env
      );

      expect(res.status).toBe(403);
    });

    it('token sub cannot be empty', async () => {
      const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
      const payload = btoa(JSON.stringify({ sub: '', scopes: 'documents:rw', iat: Date.now(), exp: Date.now() + 86400 }));
      const emptySubToken = `${header}.${payload}.`;

      const env = createTestEnv();
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/storage/alice/documents/test.txt',
        { method: 'GET', headers: { Authorization: `Bearer ${emptySubToken}` } },
        env
      );

      expect(res.status).toBe(401);
    });
  });
});

describe('Path Validation Edge Cases', () => {
  it('rejects path with null byte', async () => {
    const env = createTestEnv();
    const app = createServer(env);
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/file\u0000.txt',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(res.status).toBe(400);
  });

  it('rejects path with control characters', async () => {
    const env = createTestEnv();
    const app = createServer(env);
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/file\x1b.txt',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(res.status).toBeOneOf([400, 404]);
  });

  it('rejects path with encoded forward slash in module name', async () => {
    const env = createTestEnv();
    const app = createServer(env);
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents%2Fsubdir/file.txt',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(res.status).toBeOneOf([400, 403, 404]);
  });

  it('handles path with dot segment appropriately', async () => {
    const env = createTestEnv();
    const app = createServer(env);
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/.hidden/file.txt',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(res.status).toBeOneOf([200, 400, 403, 404]);
  });

  it('rejects extremely long path', async () => {
    const env = createTestEnv();
    const app = createServer(env);
    const token = createTestToken('alice');
    const longPath = 'a'.repeat(500);

    const res = await app.request(
      `http://localhost/storage/alice/documents/${longPath}`,
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(res.status).toBeOneOf([400, 403, 404, 414]);
  });

  it('accepts valid path with hyphen and underscore', async () => {
    const storage = {
      async get() { return null; },
      async put() { return '"test"'; },
      async delete() {},
      async head() { return null; },
      async list() { return { objects: [] }; },
    };
    const env = { STORAGE: storage, DB: {}, RATE_LIMIT_KV: {} } as any;
    const app = createServer(env);
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/my-file_v2.txt',
      { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: 'content' },
      env
    );

    expect(res.status).toBeOneOf([200, 201]);
  });
});

describe('Content Negotiation', () => {
  it('returns JSON for folder listing request', async () => {
    const storage = {
      async get() { return null; },
      async put() { return '"test"'; },
      async delete() {},
      async head() { return null; },
      async list() { return { objects: [] }; },
    };
    const env = { STORAGE: storage, DB: {}, RATE_LIMIT_KV: {} } as any;
    const app = createServer(env);
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(res.headers.get('Content-Type')).toContain('application/ld+json');
  });

  it('returns proper charset in Content-Type', async () => {
    const storage = {
      async get() {
        return { body: new TextEncoder().encode('hello'), metadata: { contentType: 'text/plain', contentLength: 5, etag: '"test"' } };
      },
      async put() { return '"test"'; },
      async delete() {},
      async head() { return { etag: '"test"', contentType: 'text/plain', contentLength: 5 }; },
      async list() { return { objects: [] }; },
    };
    const env = { STORAGE: storage, DB: {}, RATE_LIMIT_KV: {} } as any;
    const app = createServer(env);
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/test.txt',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env
    );

    const ct = res.headers.get('Content-Type') || '';
    expect(ct).toContain('text/plain');
  });

  it('preserves binary Content-Type', async () => {
    const storage = {
      async get() {
        return { body: new ArrayBuffer(10), metadata: { contentType: 'application/octet-stream', contentLength: 10, etag: '"binary"' } };
      },
      async put() { return '"binary"'; },
      async delete() {},
      async head() { return { etag: '"binary"', contentType: 'application/octet-stream', contentLength: 10 }; },
      async list() { return { objects: [] }; },
    };
    const env = { STORAGE: storage, DB: {}, RATE_LIMIT_KV: {} } as any;
    const app = createServer(env);
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/data.bin',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
  });
});

describe('Response Headers', () => {
  it('Cache-Control: no-cache on storage responses', async () => {
    const storage = {
      async get() {
        return { body: new ArrayBuffer(5), metadata: { contentType: 'text/plain', contentLength: 5, etag: '"test"' } };
      },
      async put() { return '"test"'; },
      async delete() {},
      async head() { return { etag: '"test"', contentType: 'text/plain', contentLength: 5 }; },
      async list() { return { objects: [] }; },
    };
    const env = { STORAGE: storage, DB: {}, RATE_LIMIT_KV: {} } as any;
    const app = createServer(env);
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/test.txt',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(res.headers.get('Cache-Control')).toBe('no-cache');
  });

  it('Cache-Control: no-cache on folder listing', async () => {
    const storage = {
      async get() { return null; },
      async put() { return '"test"'; },
      async delete() {},
      async head() { return null; },
      async list() { return { objects: [] }; },
    };
    const env = { STORAGE: storage, DB: {}, RATE_LIMIT_KV: {} } as any;
    const app = createServer(env);
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(res.headers.get('Cache-Control')).toBe('no-cache');
  });

  it('exposes ETag in Access-Control-Expose-Headers', async () => {
    const storage = {
      async get() {
        return { body: new ArrayBuffer(5), metadata: { contentType: 'text/plain', contentLength: 5, etag: '"test"' } };
      },
      async put() { return '"test"'; },
      async delete() {},
      async head() { return { etag: '"test"', contentType: 'text/plain', contentLength: 5 }; },
      async list() { return { objects: [] }; },
    };
    const env = { STORAGE: storage, DB: {}, RATE_LIMIT_KV: {} } as any;
    const app = createServer(env);
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/test.txt',
      { method: 'GET', headers: { Authorization: `Bearer ${token}`, Origin: 'https://example.com' } },
      env
    );

    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('ETag');
  });
});

describe('HTTP Method Handling', () => {
  it('PATCH is not supported (returns 404)', async () => {
    const env = createTestEnv();
    const app = createServer(env);
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/test.txt',
      { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: 'content' },
      env
    );

    expect(res.status).toBe(404);
  });

  it('OPTIONS works for preflight', async () => {
    const env = createTestEnv();
    const app = createServer(env);

    const res = await app.request(
      'http://localhost/storage/alice/documents/test.txt',
      { method: 'OPTIONS' },
      env
    );

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toBeDefined();
  });
});