import { describe, it, expect, beforeAll } from 'vitest';
import { createServer } from '../src/index';
import { seedToken } from './helpers/tokens';
import { createSqliteD1 } from '../src/services/db/sqlite';
import { MemoryStorage } from './helpers/memory-storage';

const TEST_ENV = {
  STORAGE: new MemoryStorage(),
  DB: createSqliteD1(),
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

  // A bare `*` used to grant full read-write; it is not a valid scope, so it
  // grants nothing. The root scope is `*:r` or `*:rw`.
  it('bare * scope grants nothing', async () => {
    const bareToken = seedToken(TEST_ENV, 'alice', '*');
    const res = await app.request(
      'http://localhost/storage/alice/documents/bare-wildcard',
      { method: 'GET', headers: { 'Authorization': `Bearer ${bareToken}` } },
      TEST_ENV
    );
    expect(res.status).toBe(403);
  });

  it('a module scope cannot write root-level documents or public/ itself; *:rw can', async () => {
    const fooToken = seedToken(TEST_ENV, 'alice', 'foo:rw');
    const rootToken = seedToken(TEST_ENV, 'alice', '*:rw');
    const put = (path: string, token: string) => app.request(
      `http://localhost/storage/alice/${path}`,
      { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: 'x' },
      TEST_ENV
    );

    for (const path of ['foo', 'public/foo']) {
      const res = await put(path, fooToken);
      expect(res.status, path).toBe(403);
      expect(res.headers.get('WWW-Authenticate')).toContain('scope="*:rw"');
      expect((await put(path, rootToken)).status, path).toBeOneOf([200, 201]);
    }
    // Past the scope check: refused only because the documents foo and public/foo now exist.
    expect((await put('foo/bar', fooToken)).status).toBe(409);
    expect((await put('public/foo/bar', fooToken)).status).toBe(409);
  });

  it('a read level that only starts with r grants nothing', async () => {
    const token = seedToken(TEST_ENV, 'alice', 'documents:read');
    const res = await app.request(
      'http://localhost/storage/alice/documents/read-test',
      { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } },
      TEST_ENV
    );
    expect(res.status).toBe(403);
  });

  it('wildcard scope *:rw can access any module', async () => {
    const adminToken = seedToken(TEST_ENV, 'alice', '*:rw');

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