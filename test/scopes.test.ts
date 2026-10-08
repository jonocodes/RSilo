import { describe, it, expect, beforeAll } from 'vitest';
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

describe('Scope-based access control', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer(TEST_ENV);
  });

  it('read-only token can GET but not PUT', async () => {
    const readOnlyToken = seedToken(TEST_ENV, 'alice', 'documents:r');

    const getRes = await app.request(
      'http://localhost/storage/alice/documents/read-test',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${readOnlyToken}` },
      },
      TEST_ENV
    );

    expect(getRes.status).toBeOneOf([200, 404]);

    const putRes = await app.request(
      'http://localhost/storage/alice/documents/read-test',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${readOnlyToken}`, 'Content-Type': 'text/plain' },
        body: 'should fail',
      },
      TEST_ENV
    );

    expect(putRes.status).toBe(403);
  });

  it('read-write token can PUT and GET', async () => {
    const rwToken = seedToken(TEST_ENV, 'alice', 'documents:rw');

    const putRes = await app.request(
      'http://localhost/storage/alice/documents/rw-test',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${rwToken}`, 'Content-Type': 'text/plain' },
        body: 'read-write content',
      },
      TEST_ENV
    );

    expect(putRes.status).toBeOneOf([200, 201]);

    const getRes = await app.request(
      'http://localhost/storage/alice/documents/rw-test',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${rwToken}` },
      },
      TEST_ENV
    );

    expect(getRes.status).toBe(200);
  });

  it('token for documents scope cannot access pictures module', async () => {
    const docToken = seedToken(TEST_ENV, 'alice', 'documents:rw');

    const getRes = await app.request(
      'http://localhost/storage/alice/pictures/some-file.jpg',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${docToken}` },
      },
      TEST_ENV
    );

    expect(getRes.status).toBe(403);
  });

  it('wildcard scope can access any module', async () => {
    const adminToken = seedToken(TEST_ENV, 'alice', '*');

    const putRes1 = await app.request(
      'http://localhost/storage/alice/documents/wildcard-test',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'text/plain' },
        body: 'documents content',
      },
      TEST_ENV
    );

    expect(putRes1.status).toBeOneOf([200, 201]);

    const putRes2 = await app.request(
      'http://localhost/storage/alice/pictures/wildcard-test',
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'image/jpeg' },
        body: 'pictures content',
      },
      TEST_ENV
    );

    expect(putRes2.status).toBeOneOf([200, 201]);
  });
});

describe('Token validation', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer(TEST_ENV);
  });

  it('invalid token format returns 401', async () => {
    const res = await app.request(
      'http://localhost/storage/alice/documents/test',
      {
        method: 'GET',
        headers: { 'Authorization': 'Bearer not-a-valid-token' },
      },
      TEST_ENV
    );

    expect(res.status).toBe(401);
  });

  it('expired token returns 401', async () => {
    const expired = seedToken(TEST_ENV, 'alice', 'documents:rw pictures:rw', {
      expiresAt: Math.floor(Date.now() / 1000) - 3600,
    });

    const res = await app.request(
      'http://localhost/storage/alice/documents/test',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${expired}` },
      },
      TEST_ENV
    );

    expect(res.status).toBe(401);
  });

  it('missing Authorization header returns 401', async () => {
    const res = await app.request(
      'http://localhost/storage/alice/documents/test',
      {
        method: 'GET',
      },
      TEST_ENV
    );

    expect(res.status).toBe(401);
  });
});