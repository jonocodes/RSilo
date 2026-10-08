import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createServer } from '../src/index';
import { seedToken } from './helpers/tokens';

const storage = new Map<string, { body: ArrayBuffer; etag: string; contentType: string; lastModified?: string }>();

const TEST_ENV = {
  STORAGE: {
    async get(key: string) {
      const item = storage.get(key);
      if (!item) return null;
      return { body: item.body, metadata: { contentType: item.contentType, contentLength: item.body.byteLength, etag: item.etag, lastModified: item.lastModified } };
    },
    async put(key: string, body: ArrayBuffer, contentType?: string) {
      const etag = `"etag-${Math.random().toString(36).slice(2)}"`;
      storage.set(key, { body, etag, contentType: contentType || 'application/octet-stream', lastModified: new Date().toISOString() });
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

describe('WebFinger endpoint', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer(TEST_ENV);
  });

  beforeEach(() => {
    storage.clear();
  });

  it('GET /.well-known/webfinger returns JRD with storage href', async () => {
    const res = await app.request(
      'http://localhost/.well-known/webfinger?resource=acct:alice@localhost:8787',
      { method: 'GET' },
      TEST_ENV
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/jrd+json');

    const json = await res.json() as any;
    expect(json.subject).toBe('acct:alice@localhost:8787');
    const storageLink = json.links?.find((l: any) => l.rel === 'http://tools.ietf.org/id/draft-dejong-remotestorage');
    expect(storageLink).toBeDefined();
    expect(storageLink.href).toContain('/storage/alice');
    expect(storageLink.type).toBe('draft-dejong-remotestorage-22');
  });

  it('WebFinger returns correct auth endpoint URL', async () => {
    const res = await app.request(
      'http://localhost/.well-known/webfinger?resource=acct:alice@localhost:8787',
      { method: 'GET' },
      TEST_ENV
    );

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    const storageLink = json.links?.find((l: any) => l.rel === 'http://tools.ietf.org/id/draft-dejong-remotestorage');
    expect(storageLink.properties).toBeDefined();
    expect(storageLink.properties['http://tools.ietf.org/html/rfc6749#section-4.2']).toBe('http://localhost:8787/account/oauth/authorize');
  });

  it('WebFinger returns 404 for a user other than the Account', async () => {
    const res = await app.request(
      'http://localhost/.well-known/webfinger?resource=acct:bob@localhost:8787',
      { method: 'GET' },
      TEST_ENV
    );

    expect(res.status).toBe(404);
  });
});

describe('OAuth endpoints', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer(TEST_ENV);
  });

  beforeEach(() => {
    storage.clear();
  });

  it('GET /oauth/:user returns auth page or redirect (or error if not implemented)', async () => {
    const res = await app.request(
      'http://localhost/oauth/alice',
      { method: 'GET' },
      TEST_ENV
    );

    expect(res.status).toBeOneOf([200, 302, 303, 404, 501]);
  });
});

describe('Content-Type preservation', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer(TEST_ENV);
  });

  beforeEach(() => {
    storage.clear();
  });

  it('PUT stores and GET returns correct Content-Type', async () => {
    const token = seedToken(TEST_ENV, 'alice');

    await app.request(
      'http://localhost/storage/alice/documents/custom-type',
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: '{"key":"value"}',
      },
      TEST_ENV
    );

    const getRes = await app.request(
      'http://localhost/storage/alice/documents/custom-type',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('Content-Type')).toContain('application/json');
    expect(await getRes.text()).toBe('{"key":"value"}');
  });
});

describe('host-meta and server info', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer(TEST_ENV);
  });

  it('GET /.well-known/host-meta returns valid XRD XML', async () => {
    const res = await app.request('http://localhost/.well-known/host-meta', { method: 'GET' }, TEST_ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/xrd+xml');
    const text = await res.text();
    expect(text).toContain('<?xml');
    expect(text).toContain('<XRD');
    expect(text).toContain('</XRD>');
    expect(text).toContain('lrdd');
    expect(text).toContain('/webfinger/jrd');
  });

  it('GET / returns HTML server info page', async () => {
    const res = await app.request('http://localhost/', { method: 'GET' }, TEST_ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('RemoteStorage');
  });

  it('GET / names RSilo and links to account, API reference and source', async () => {
    const res = await app.request('http://localhost/', { method: 'GET' }, TEST_ENV);
    const html = await res.text();
    expect(html).toContain('<title>RSilo</title>');
    expect(html).toMatch(/<h1>RSilo<\/h1>/);
    expect(html).toContain('href="/account"');
    expect(html).toContain('href="/api"');
    expect(html).toContain('href="https://github.com/jonocodes/RSilo"');
  });

  it('GET /health returns ok', async () => {
    const res = await app.request('http://localhost/health', { method: 'GET' }, TEST_ENV);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.status).toBe('ok');
  });
});

describe('ETag behavior', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer(TEST_ENV);
  });

  beforeEach(() => {
    storage.clear();
  });

  it('PUT creates new ETag', async () => {
    const token = seedToken(TEST_ENV, 'alice');

    const putRes = await app.request(
      'http://localhost/storage/alice/documents/etag-create',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: 'content',
      },
      TEST_ENV
    );

    expect(putRes.status).toBeOneOf([200, 201]);
    const etag = putRes.headers.get('ETag');
    expect(etag).toMatch(/^"[^"]+"$/);
  });

  it('PUT updates ETag when content changes', async () => {
    const token = seedToken(TEST_ENV, 'alice');

    const putRes1 = await app.request(
      'http://localhost/storage/alice/documents/etag-update',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: 'original',
      },
      TEST_ENV
    );

    expect(putRes1.status).toBeOneOf([200, 201]);
    const etag1 = putRes1.headers.get('ETag');

    await app.request(
      'http://localhost/storage/alice/documents/etag-update',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: 'updated',
      },
      TEST_ENV
    );

    const etag2 = (await app.request(
      'http://localhost/storage/alice/documents/etag-update',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    )).headers.get('ETag');

    expect(etag1).not.toBe(etag2);
  });
});