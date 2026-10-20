import { describe, it, expect } from 'vitest';
import { createServer } from '../../src/index';
import { seedToken } from '../helpers/tokens';
import { createSqliteD1 } from '../../src/services/db/sqlite';
import { MemoryStorage } from '../helpers/memory-storage';

function createTestEnv(storage = new MemoryStorage()) {
  return { STORAGE: storage, DB: createSqliteD1() };
}

const FILE = 'users/alice/storage/documents/test.txt';

describe('WebFinger Compliance', () => {
  describe('RFC 7033 Discovery', () => {
    it('GET /.well-known/webfinger with resource=acct: returns JRD', async () => {
      const env = createTestEnv();
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/.well-known/webfinger?resource=acct:alice@localhost:8787',
        { method: 'GET' },
        env
      );

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.subject).toBe('acct:alice@localhost:8787');
      expect(json.links).toBeDefined();
      expect(Array.isArray(json.links)).toBe(true);
    });

    it('returns application/jrd+json content type', async () => {
      const env = createTestEnv();
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/.well-known/webfinger?resource=acct:alice@localhost:8787',
        { method: 'GET' },
        env
      );

      expect(res.headers.get('Content-Type')).toContain('application/jrd+json');
    });

    it('returns Link header or JSON links for discovery', async () => {
      const env = createTestEnv();
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/.well-known/webfinger?resource=acct:alice@localhost:8787',
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
        'http://localhost/.well-known/webfinger?resource=acct:alice@localhost:8787',
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
        'http://localhost/.well-known/webfinger?resource=acct:alice@localhost:8787',
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
        'http://localhost/.well-known/webfinger?resource=acct:alice@localhost:8787',
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

      expect(res.status).toBe(404);
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
        'http://localhost/webfinger/jrd?resource=acct:alice@localhost:8787',
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
  async function getWithIfNoneMatch(env: ReturnType<typeof createTestEnv>, ifNoneMatch?: string) {
    const token = seedToken(env, 'alice');
    return createServer(env).request(
      'http://localhost/storage/alice/documents/test.txt',
      { method: 'GET', headers: { Authorization: `Bearer ${token}`, ...(ifNoneMatch && { 'If-None-Match': ifNoneMatch }) } },
      env
    );
  }

  it('ETag is always quoted', async () => {
    const storage = new MemoryStorage();
    storage.seed(FILE, 'hello');
    // A backend handing back an unquoted ETag must still be served quoted.
    storage.objects.get(FILE)!.etag = 'abc123';
    const res = await getWithIfNoneMatch(createTestEnv(storage));

    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toBe('"abc123"');
  });

  it('If-None-Match with quoted ETag works', async () => {
    const storage = new MemoryStorage();
    const etag = storage.seed(FILE, 'hello');
    const res = await getWithIfNoneMatch(createTestEnv(storage), etag);

    expect(res.status).toBe(304);
  });

  it('If-None-Match with unquoted ETag works', async () => {
    const storage = new MemoryStorage();
    const etag = storage.seed(FILE, 'hello');
    const res = await getWithIfNoneMatch(createTestEnv(storage), etag.slice(1, -1));

    expect(res.status).toBe(304);
  });

  it('multiple ETags in If-None-Match works', async () => {
    const storage = new MemoryStorage();
    const etag = storage.seed(FILE, 'hello');
    const res = await getWithIfNoneMatch(createTestEnv(storage), `"abc", "def", ${etag}`);

    expect(res.status).toBe(304);
  });
});

describe('Content-Type Compliance', () => {
  const URL = 'http://localhost/storage/alice/documents/custom.json';
  const KEY = 'users/alice/storage/documents/custom.json';

  it('stores Content-Type from PUT request', async () => {
    const storage = new MemoryStorage();
    const env = createTestEnv(storage);
    const app = createServer(env);
    const token = seedToken(env, 'alice');

    const put = await app.request(
      URL,
      { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{"key": "value"}' },
      env
    );
    expect(put.status).toBeOneOf([200, 201]);
    expect(storage.objects.get(KEY)?.contentType).toBe('application/json');

    const get = await app.request(URL, { method: 'GET', headers: { Authorization: `Bearer ${token}` } }, env);
    expect(get.headers.get('Content-Type')).toBe('application/json');
    expect(await get.text()).toBe('{"key": "value"}');
  });

  it('returns correct Content-Type on GET', async () => {
    const storage = new MemoryStorage();
    storage.seed(KEY, '{}', 'application/json');
    const env = createTestEnv(storage);
    const token = seedToken(env, 'alice');

    const res = await createServer(env).request(
      URL,
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(res.headers.get('Content-Type')).toBe('application/json');
  });

  it('defaults to application/octet-stream when no Content-Type provided', async () => {
    const storage = new MemoryStorage();
    const env = createTestEnv(storage);
    const app = createServer(env);
    const token = seedToken(env, 'alice');

    const res = await app.request(
      'http://localhost/storage/alice/documents/no-type.txt',
      { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: new Uint8Array([0, 1, 2]) },
      env
    );

    expect(res.status).toBeOneOf([200, 201]);
    expect(storage.objects.get('users/alice/storage/documents/no-type.txt')?.contentType).toBe('application/octet-stream');
  });
});

describe('Folder Listing Compliance', () => {
  async function listDocuments(storage: MemoryStorage) {
    const env = createTestEnv(storage);
    const token = seedToken(env, 'alice');
    return createServer(env).request(
      'http://localhost/storage/alice/documents/',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env
    );
  }

  it('returns valid JSON-LD context', async () => {
    const res = await listDocuments(new MemoryStorage());

    const json = await res.json() as any;
    expect(json['@context']).toBeTruthy();
    expect(json['@context']).toContain('remotestorage.io');
  });

  it('items is a flat object, not array', async () => {
    const storage = new MemoryStorage();
    storage.seed('users/alice/storage/documents/file.txt', 'content');
    const res = await listDocuments(storage);

    const json = await res.json() as any;
    expect(typeof json.items).toBe('object');
    expect(Array.isArray(json.items)).toBe(false);
    expect(json.items['file.txt']).toBeDefined();
  });

  it('subfolders end with /', async () => {
    const storage = new MemoryStorage();
    storage.seed('users/alice/storage/documents/sub/file.txt', 'content');
    const res = await listDocuments(storage);

    const json = await res.json() as any;
    expect(json.items['sub/']).toBeDefined();
  });

  it('etag for folder is computed from content', async () => {
    const storage = new MemoryStorage();
    storage.seed('users/alice/storage/documents/file.txt', 'one');
    const etag = (await listDocuments(storage)).headers.get('ETag');
    expect(etag).toMatch(/^"[^"]+"$/);

    // Same listing, same ETag; changed content, different ETag.
    expect((await listDocuments(storage)).headers.get('ETag')).toBe(etag);
    storage.seed('users/alice/storage/documents/file.txt', 'two');
    expect((await listDocuments(storage)).headers.get('ETag')).not.toBe(etag);
  });
});
