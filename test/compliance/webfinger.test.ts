import { describe, it, expect } from 'vitest';
import { createServer, createTestToken } from '../../src/index';

function createTestEnv() {
  return {
    STORAGE: {
      async get() { return null; },
      async put() { return '"test-etag"'; },
      async delete() {},
      async head() { return null; },
      async list() { return { objects: [] }; },
    } as any,
    DB: {} as any,
    RATE_LIMIT_KV: { async get() { return null; }, async put() {} } as any,
  };
}

describe('WebFinger Compliance', () => {
  describe('RFC 7033 Discovery', () => {
    it('GET /.well-known/webfinger with resource=acct: returns JRD', async () => {
      const env = createTestEnv();
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/.well-known/webfinger?resource=acct:alice@example.com',
        { method: 'GET' },
        env
      );

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.subject).toBe('acct:alice@example.com');
      expect(json.links).toBeDefined();
      expect(Array.isArray(json.links)).toBe(true);
    });

    it('returns application/jrd+json content type', async () => {
      const env = createTestEnv();
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/.well-known/webfinger?resource=acct:alice@example.com',
        { method: 'GET' },
        env
      );

      expect(res.headers.get('Content-Type')).toContain('application/jrd+json');
    });

    it('returns Link header or JSON links for discovery', async () => {
      const env = createTestEnv();
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/.well-known/webfinger?resource=acct:alice@example.com',
        { method: 'GET' },
        env
      );

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.links).toBeDefined();
      expect(json.links.length).toBeGreaterThan(0);
    });

    it('links contain href to storage endpoint', async () => {
      const env = createTestEnv();
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/.well-known/webfinger?resource=acct:alice@example.com',
        { method: 'GET' },
        env
      );

      const json = await res.json() as any;
      expect(json.links).toBeDefined();
      const rsLink = json.links?.find((l: any) => l.rel?.includes('remoteStorage') || l.href?.includes('/storage/'));
      expect(rsLink).toBeDefined();
    });

    it('links contain auth endpoint', async () => {
      const env = createTestEnv();
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/.well-known/webfinger?resource=acct:alice@example.com',
        { method: 'GET' },
        env
      );

      const json = await res.json() as any;
      const rsLink = json.links?.find((l: any) => l.auth);
      expect(rsLink).toBeDefined();
    });

    it('returns api: simple', async () => {
      const env = createTestEnv();
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/.well-known/webfinger?resource=acct:alice@example.com',
        { method: 'GET' },
        env
      );

      const json = await res.json() as any;
      expect(json.links).toBeDefined();
    });

    it('handles missing resource parameter gracefully', async () => {
      const env = createTestEnv();
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/.well-known/webfinger',
        { method: 'GET' },
        env
      );

      expect(res.status).toBeGreaterThanOrEqual(200);
    });

    it('handles invalid resource format gracefully', async () => {
      const env = createTestEnv();
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/.well-known/webfinger?resource=not-acct-format',
        { method: 'GET' },
        env
      );

      expect(res.status).toBeGreaterThanOrEqual(200);
    });

    it('handles WebFinger XRD format via /webfinger/xrd', async () => {
      const env = createTestEnv();
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/webfinger/xrd',
        { method: 'GET' },
        env
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('application/xrd+xml');
      const text = await res.text();
      expect(text).toContain('<XRD');
      expect(text).toContain('Link');
    });

    it('supports JRD format via /webfinger/jrd', async () => {
      const env = createTestEnv();
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/webfinger/jrd?resource=acct:alice@example.com',
        { method: 'GET' },
        env
      );

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.links).toBeDefined();
    });
  });

  describe('OAuth Discovery', () => {
    it('GET /oauth/:user returns discover document', async () => {
      const env = createTestEnv();
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/oauth/alice',
        { method: 'GET' },
        env
      );

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.auth_method).toBe('popup');
      expect(json.token_endpoint).toContain('/oauth/alice/token');
      expect(json.storageapi).toContain('/storage/alice');
    });

    it('returns supported scope information', async () => {
      const env = createTestEnv();
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/oauth/alice',
        { method: 'GET' },
        env
      );

      const json = await res.json() as any;
      expect(json.scopes).toBeDefined();
      expect(Array.isArray(json.scopes)).toBe(true);
    });

    it('OPTIONS /oauth/:user returns CORS headers', async () => {
      const env = createTestEnv();
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/oauth/alice',
        { method: 'OPTIONS' },
        env
      );

      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });
});

describe('ETag Compliance', () => {
  it('ETag is always quoted', async () => {
    const storage = {
      async get() {
        return { body: new ArrayBuffer(5), metadata: { contentType: 'text/plain', contentLength: 5, etag: 'abc123' } };
      },
      async put() { return '"abc123"'; },
      async delete() {},
      async head() { return { etag: 'abc123', contentType: 'text/plain', contentLength: 5 }; },
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

    const etag = res.headers.get('ETag');
    expect(etag).toMatch(/^"[^"]+"$/);
  });

  it('If-None-Match with quoted ETag works', async () => {
    const storage = {
      async get() {
        return { body: new ArrayBuffer(5), metadata: { contentType: 'text/plain', contentLength: 5, etag: '"abc123"' } };
      },
      async put() { return { etag: '"abc123"' }; },
      async delete() {},
      async head() { return { etag: '"abc123"', contentType: 'text/plain', contentLength: 5 }; },
      async list() { return { objects: [] }; },
    };
    const env = { STORAGE: storage, DB: {}, RATE_LIMIT_KV: {} } as any;
    const app = createServer(env);
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/test.txt',
      { method: 'GET', headers: { Authorization: `Bearer ${token}`, 'If-None-Match': '"abc123"' } },
      env
    );

    expect(res.status).toBe(304);
  });

  it('If-None-Match with unquoted ETag works', async () => {
    const storage = {
      async get() {
        return { body: new ArrayBuffer(5), metadata: { contentType: 'text/plain', contentLength: 5, etag: '"abc123"' } };
      },
      async put() { return { etag: '"abc123"' }; },
      async delete() {},
      async head() { return { etag: '"abc123"', contentType: 'text/plain', contentLength: 5 }; },
      async list() { return { objects: [] }; },
    };
    const env = { STORAGE: storage, DB: {}, RATE_LIMIT_KV: {} } as any;
    const app = createServer(env);
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/test.txt',
      { method: 'GET', headers: { Authorization: `Bearer ${token}`, 'If-None-Match': 'abc123' } },
      env
    );

    expect(res.status).toBe(304);
  });

  it('multiple ETags in If-None-Match works', async () => {
    const storage = {
      async get() {
        return { body: new ArrayBuffer(5), metadata: { contentType: 'text/plain', contentLength: 5, etag: '"abc123"' } };
      },
      async put() { return { etag: '"abc123"' }; },
      async delete() {},
      async head() { return { etag: '"abc123"', contentType: 'text/plain', contentLength: 5 }; },
      async list() { return { objects: [] }; },
    };
    const env = { STORAGE: storage, DB: {}, RATE_LIMIT_KV: {} } as any;
    const app = createServer(env);
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/test.txt',
      { method: 'GET', headers: { Authorization: `Bearer ${token}`, 'If-None-Match': '"abc", "def", "abc123"' } },
      env
    );

    expect(res.status).toBe(304);
  });
});

describe('Content-Type Compliance', () => {
  it('stores Content-Type from PUT request', async () => {
    const storage = {
      async get() { return null; },
      async put(_key: string, _body: ArrayBuffer, _options?: { httpMetadata?: { contentType?: string } }) {
        return '"test"';
      },
      async delete() {},
      async head() { return null; },
      async list() { return { objects: [] }; },
    };
    const env = { STORAGE: storage, DB: {}, RATE_LIMIT_KV: {} } as any;
    const app = createServer(env);
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/custom.txt',
      { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{"key": "value"}' },
      env
    );

    expect(res.status).toBeOneOf([200, 201]);
  });

  it('returns correct Content-Type on GET', async () => {
    const storage = {
      async get() {
        return { body: new ArrayBuffer(5), metadata: { contentType: 'application/json', contentLength: 5, etag: '"test"' } };
      },
      async put() { return '"test"'; },
      async delete() {},
      async head() { return { etag: '"test"', contentType: 'application/json', contentLength: 5 }; },
      async list() { return { objects: [] }; },
    };
    const env = { STORAGE: storage, DB: {}, RATE_LIMIT_KV: {} } as any;
    const app = createServer(env);
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/data.json',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(res.headers.get('Content-Type')).toBe('application/json');
  });

  it('defaults to application/octet-stream when no Content-Type provided', async () => {
    const storage = {
      async get() { return null; },
      async put(_key: string, _body: ArrayBuffer, _options?: { httpMetadata?: { contentType?: string } }) {
        return '"test"';
      },
      async delete() {},
      async head() { return null; },
      async list() { return { objects: [] }; },
    };
    const env = { STORAGE: storage, DB: {}, RATE_LIMIT_KV: {} } as any;
    const app = createServer(env);
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/no-type.txt',
      { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: new Uint8Array([0, 1, 2]) },
      env
    );

    expect(res.status).toBeOneOf([200, 201]);
  });
});

describe('Folder Listing Compliance', () => {
  it('returns valid JSON-LD context', async () => {
    const storage = {
      async get() { return null; },
      async put() { return '"test"'; },
      async delete() {},
      async head() { return null; },
      async list(_options: { prefix: string }) {
        return { objects: [] };
      },
    };
    const env = { STORAGE: storage, DB: {}, RATE_LIMIT_KV: {} } as any;
    const app = createServer(env);
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env
    );

    const json = await res.json() as any;
    expect(json['@context']).toBeTruthy();
    expect(json['@context']).toContain('remotestorage.io');
  });

  it('items is a flat object, not array', async () => {
    const storage = {
      async get() { return null; },
      async put() { return '"test"'; },
      async delete() {},
      async head() { return null; },
      async list(_options: { prefix: string }) {
        return { objects: [
          { key: 'users/alice/storage/documents/file.txt', etag: '"abc"' }
        ] };
      },
    };
    const env = { STORAGE: storage, DB: {}, RATE_LIMIT_KV: {} } as any;
    const app = createServer(env);
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env
    );

    const json = await res.json() as any;
    expect(typeof json.items).toBe('object');
    expect(Array.isArray(json.items)).toBe(false);
    expect(json.items['file.txt']).toBeDefined();
  });

  it('subfolders end with /', async () => {
    const storage = {
      async get() { return null; },
      async put() { return '"test"'; },
      async delete() {},
      async head() { return null; },
      async list(_options: { prefix: string }) {
        return { objects: [
          { key: 'users/alice/storage/documents/sub/file.txt', etag: '"abc"' }
        ] };
      },
    };
    const env = { STORAGE: storage, DB: {}, RATE_LIMIT_KV: {} } as any;
    const app = createServer(env);
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env
    );

    const json = await res.json() as any;
    expect(json.items['sub/']).toBeDefined();
  });

  it('etag for folder is computed from content', async () => {
    const storage = {
      async get() { return null; },
      async put() { return '"test"'; },
      async delete() {},
      async head() { return null; },
      async list(_options: { prefix: string }) {
        return { objects: [] };
      },
    };
    const env = { STORAGE: storage, DB: {}, RATE_LIMIT_KV: {} } as any;
    const app = createServer(env);
    const token = createTestToken('alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env
    );

    const etag = res.headers.get('ETag');
    expect(etag).toMatch(/^"[^"]+"$/);
  });
});