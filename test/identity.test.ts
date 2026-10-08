import { describe, it, expect, beforeEach } from 'vitest';
import { createServer } from '../src/index';
import { PRODUCTION_INSTANCE } from './helpers/instance';
import { createSqliteD1, type SqliteD1 } from './helpers/sqlite-d1';

// The human identity seam (services/identity.ts), driven through /account.
// Production requests carry a stubbed Workers ExecutionContext whose
// `access.getIdentity()` returns a fixture, as Cloudflare Access would.

const app = createServer({});
const BASE = PRODUCTION_INSTANCE.PUBLIC_BASE_URL;

class MemoryStorage {
  objects = new Map<string, { body: ArrayBuffer; contentType: string }>();
  async get(key: string) {
    const o = this.objects.get(key);
    return o ? { body: o.body, metadata: { contentType: o.contentType, contentLength: o.body.byteLength, etag: '"e"' } } : null;
  }
  async put(key: string, body: ArrayBuffer, contentType: string) { this.objects.set(key, { body, contentType }); return '"e"'; }
  async delete(key: string) { this.objects.delete(key); }
  async head(key: string) {
    const o = this.objects.get(key);
    return o ? { contentType: o.contentType, contentLength: o.body.byteLength, etag: '"e"' } : null;
  }
  async list(prefix: string) {
    return { objects: [...this.objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, size: o.body.byteLength, etag: '"e"' })) };
  }
}

function accessCtx(identity: { email?: string } | undefined) {
  return {
    waitUntil() {},
    passThroughOnException() {},
    access: { aud: 'test-aud', getIdentity: async () => identity },
  } as any;
}

function productionEnv(extra: Record<string, unknown> = {}) {
  return { STORAGE: new MemoryStorage() as any, DB: createSqliteD1(), RSILO_DEV_MODE: 'false', ...PRODUCTION_INSTANCE, ...extra } as any;
}

describe('production identity (ctx.access)', () => {
  for (const email of ['owner@example.com', 'OWNER@Example.COM', '  Owner@example.com ']) {
    it(`admits the Owner signed in as "${email}"`, async () => {
      const res = await app.request(`${BASE}/account`, {}, productionEnv(), accessCtx({ email }));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('alice@rsilo.example');
      expect(html).toContain(email.trim());
    });
  }

  it('answers another email with a 403 page naming it and how to fix OWNER_EMAIL', async () => {
    const res = await app.request(`${BASE}/account/browse`, {}, productionEnv(), accessCtx({ email: 'mallory@example.com' }));
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain('mallory@example.com');
    expect(html).toContain('OWNER_EMAIL');
    expect(html).toContain('Cloudflare dashboard');
    expect(html).not.toContain('alice@rsilo.example');
  });

  it('answers an identity without an email with the 403 page', async () => {
    const res = await app.request(`${BASE}/account`, {}, productionEnv(), accessCtx({}));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('did not include an email');
  });

  it('shows the finish-setup page when ctx.access is absent', async () => {
    const res = await app.request(`${BASE}/account`, {}, productionEnv());
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain('Finish setting up RSilo');
    expect(html).toContain('Self-hosted');
    expect(html).toContain('<code>rsilo.example</code>');
    expect(html).toContain('<code>account</code>');
    expect(html).toContain('Allow');
    expect(html).not.toContain('class="problems"');
  });

  it('ignores a forged Cf-Access-Jwt-Assertion header and CF_Authorization cookie', async () => {
    const headers = { 'Cf-Access-Jwt-Assertion': 'eyJhbGciOiJub25lIn0.eyJlbWFpbCI6Im93bmVyQGV4YW1wbGUuY29tIn0.', Cookie: 'CF_Authorization=forged' };
    const res = await app.request(`${BASE}/account`, { headers }, productionEnv());
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('alice@rsilo.example');
  });

  it('lists missing config on the finish-setup page', async () => {
    const env = productionEnv();
    delete env.OWNER_EMAIL;
    const res = await app.request(`${BASE}/account`, {}, env, accessCtx({ email: 'owner@example.com' }));
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain('class="problems"');
    expect(html).toContain('OWNER_EMAIL is not set');
  });

  for (const path of ['/account', '/account/browse', '/account/client.js', '/account/download/documents/a.txt', '/account/tokens']) {
    it(`gates ${path}`, async () => {
      const res = await app.request(`${BASE}${path}`, {}, productionEnv());
      expect(res.status).toBe(503);
    });
  }

  it('shows the username-mismatch setup message as a page', async () => {
    const db = createSqliteD1();
    db.sqlite.exec("INSERT INTO users (id, username) VALUES ('u1', 'bob')");
    const res = await app.request(`${BASE}/account`, {}, productionEnv({ DB: db }), accessCtx({ email: 'owner@example.com' }));
    expect(res.status).toBe(503);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(await res.text()).toContain('Username mismatch');
  });
});

describe('development identity guard', () => {
  const devEnv = (extra: Record<string, unknown> = {}) => ({
    STORAGE: new MemoryStorage() as any, DB: createSqliteD1(), RSILO_DEV_MODE: 'true', ...extra,
  } as any);

  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    it(`signs in the dev identity on ${host}`, async () => {
      const res = await app.request(`http://${host}:8787/account`, {}, devEnv());
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('alice@example.com');
    });
  }

  it('is unreachable on a non-local host, even with RSILO_DEV_MODE=true', async () => {
    const res = await app.request('https://rsilo.example/account', {
      headers: { 'Cf-Access-Jwt-Assertion': 'forged' },
    }, devEnv());
    expect(res.status).toBe(503);
  });

  it('never overrides an Access identity, even on localhost with RSILO_DEV_MODE=true', async () => {
    const res = await app.request('http://localhost/account', {}, devEnv(), accessCtx({ email: 'mallory@example.com' }));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('mallory@example.com');
  });

  it('is unreachable when RSILO_DEV_MODE is not "true"', async () => {
    const res = await app.request('http://localhost/account', {}, devEnv({ RSILO_DEV_MODE: 'false', ...PRODUCTION_INSTANCE }));
    expect(res.status).toBe(503);
  });

  it('uses RSILO_DEV_EMAIL, which must still match OWNER_EMAIL', async () => {
    const res = await app.request('http://localhost/account', {}, devEnv({ RSILO_DEV_EMAIL: 'someone@example.com' }));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('someone@example.com');
  });
});

// Dev identity on localhost; PUBLIC_BASE_URL defaults to http://localhost:8787.
describe('CSRF on /account', () => {
  let db: SqliteD1;
  let storage: MemoryStorage;
  let env: any;

  beforeEach(() => {
    db = createSqliteD1();
    storage = new MemoryStorage();
    env = { STORAGE: storage as any, DB: db };
    storage.objects.set('users/alice/storage/documents/a.txt', { body: new TextEncoder().encode('a').buffer as ArrayBuffer, contentType: 'text/plain' });
  });

  function post(path: string, headers: Record<string, string>, body?: BodyInit) {
    return app.request(`http://localhost${path}`, { method: 'POST', headers, body }, env);
  }

  const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
  const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

  for (const [name, headers] of [
    ['Sec-Fetch-Site: cross-site', { 'Sec-Fetch-Site': 'cross-site' }],
    ['Sec-Fetch-Site: same-site', { 'Sec-Fetch-Site': 'same-site' }],
    ['a foreign Origin', { Origin: 'https://evil.example' }],
    ['no Sec-Fetch-Site or Origin', {}],
  ] as const) {
    it(`refuses a delete with ${name}`, async () => {
      const res = await post('/account/delete/documents/a.txt', headers);
      expect(res.status).toBe(403);
      expect(storage.objects.has('users/alice/storage/documents/a.txt')).toBe(true);
    });

    it(`refuses an app revocation with ${name}`, async () => {
      db.sqlite.exec("INSERT INTO users (id, username) VALUES ('u1', 'alice')");
      db.sqlite.exec("INSERT INTO oauth_clients (id, name, redirect_uris, user_id) VALUES ('https://app.example', 'x', '[]', 'alice')");
      db.sqlite.exec("INSERT INTO oauth_tokens (id, access_token, expires_at, scopes, user_id, client_id) VALUES ('t1', 'tok', 9999999999, 'documents:rw', 'alice', 'https://app.example')");
      const res = await post('/account/apps/revoke', { ...FORM, ...headers }, form({ client_id: 'https://app.example' }));
      expect(res.status).toBe(403);
      expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM oauth_tokens').get()).toEqual({ n: 1 });
    });

    it(`refuses a quota change with ${name}`, async () => {
      const res = await post('/account/quota', { ...FORM, ...headers }, form({ quota_gb: '1' }));
      expect(res.status).toBe(403);
    });

    it(`refuses an upload and a save with ${name}`, async () => {
      const upload = new FormData();
      upload.append('files', new File(['x'], 'x.txt', { type: 'text/plain' }));
      expect((await post('/account/upload/documents', headers, upload)).status).toBe(403);
      const save = new FormData();
      save.append('content', 'changed');
      expect((await post('/account/save/documents/a.txt', headers, save)).status).toBe(403);
      expect(storage.objects.has('users/alice/storage/documents/x.txt')).toBe(false);
    });
  }

  it('accepts Sec-Fetch-Site: same-origin', async () => {
    const res = await post('/account/delete/documents/a.txt', { 'Sec-Fetch-Site': 'same-origin' });
    expect(res.status).toBe(302);
    expect(storage.objects.has('users/alice/storage/documents/a.txt')).toBe(false);
  });

  it('accepts an Origin equal to PUBLIC_BASE_URL when Sec-Fetch-Site is absent', async () => {
    const res = await post('/account/delete/documents/a.txt', { Origin: 'http://localhost:8787' });
    expect(res.status).toBe(302);
  });

  it('does not let a matching Origin override a cross-site Sec-Fetch-Site', async () => {
    const res = await post('/account/delete/documents/a.txt', { 'Sec-Fetch-Site': 'cross-site', Origin: 'http://localhost:8787' });
    expect(res.status).toBe(403);
  });

  it('does not check GET requests', async () => {
    const res = await app.request('http://localhost/account/browse', { headers: { 'Sec-Fetch-Site': 'cross-site' } }, env);
    expect(res.status).toBe(200);
  });
});

describe('dashboard settings and app revocation', () => {
  const SAME_ORIGIN = { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin' };
  let db: SqliteD1;
  let storage: MemoryStorage;
  let env: any;

  beforeEach(() => {
    db = createSqliteD1();
    storage = new MemoryStorage();
    env = { STORAGE: storage as any, DB: db };
  });

  function upload(bytes: number, name: string) {
    const body = new FormData();
    body.append('files', new File(['x'.repeat(bytes)], name, { type: 'text/plain' }));
    return app.request('http://localhost/account/upload/documents', { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin' }, body }, env);
  }

  function setQuota(quotaGb: string) {
    return app.request('http://localhost/account/quota', {
      method: 'POST', headers: SAME_ORIGIN, body: new URLSearchParams({ quota_gb: quotaGb }).toString(),
    }, env);
  }

  it('changes the quota that writes are enforced against', async () => {
    expect((await upload(2000, 'first.txt')).status).toBe(302);

    // ~1 KiB: below current usage, which is allowed and blocks further writes.
    const res = await setQuota('0.000001');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/account');
    expect(db.sqlite.prepare('SELECT storage_quota_bytes AS q FROM users').get()).toEqual({ q: 1074 });

    expect((await upload(10, 'second.txt')).status).toBe(413);
    expect(storage.objects.has('users/alice/storage/documents/second.txt')).toBe(false);

    const dashboard = await (await app.request('http://localhost/account', {}, env)).text();
    expect(dashboard).toContain('2.0 KB of 1.0 KB used');

    expect((await setQuota('1')).status).toBe(302);
    expect((await upload(10, 'second.txt')).status).toBe(302);
  });

  for (const bad of ['', 'abc', '-1', 'Infinity']) {
    it(`rejects quota_gb=${JSON.stringify(bad)}`, async () => {
      expect((await setQuota(bad)).status).toBe(400);
    });
  }

  it('revoking an app deletes all of its tokens, codes and client row, and its tokens stop working', async () => {
    const tokenEnv = { ...env, STORAGE: storage as any };
    db.sqlite.exec("INSERT INTO users (id, username) VALUES ('u1', 'alice')");
    db.sqlite.exec("INSERT INTO oauth_clients (id, name, redirect_uris, user_id) VALUES ('https://app.example', 'x', '[]', 'alice')");
    db.sqlite.exec("INSERT INTO oauth_clients (id, name, redirect_uris, user_id) VALUES ('https://other.example', 'y', '[]', 'alice')");
    db.sqlite.exec(`INSERT INTO oauth_tokens (id, access_token, refresh_token, expires_at, scopes, user_id, client_id) VALUES
      ('t1', 'app-token-1', 'refresh-1', 9999999999, 'documents:rw', 'alice', 'https://app.example'),
      ('t2', 'app-token-2', NULL, 9999999999, 'pictures:r', 'alice', 'https://app.example'),
      ('t3', 'other-token', NULL, 9999999999, 'documents:rw', 'alice', 'https://other.example')`);
    db.sqlite.exec("INSERT INTO oauth_codes (code, client_id, user_id, redirect_uri, scope, expires_at) VALUES ('c1', 'https://app.example', 'alice', 'https://app.example/cb', 'documents:rw', 9999999999)");

    const get = (token: string, path: string) => app.request(`http://localhost/storage/alice/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    }, tokenEnv);
    expect((await get('app-token-1', 'documents/x')).status).toBe(404);

    const res = await app.request('http://localhost/account/apps/revoke', {
      method: 'POST', headers: SAME_ORIGIN, body: new URLSearchParams({ client_id: 'https://app.example' }).toString(),
    }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/account');

    expect((await get('app-token-1', 'documents/x')).status).toBe(401);
    expect((await get('app-token-2', 'pictures/x')).status).toBe(401);
    expect((await get('other-token', 'documents/x')).status).toBe(404);
    expect(db.sqlite.prepare("SELECT id FROM oauth_clients ORDER BY id").all()).toEqual([{ id: 'https://other.example' }]);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM oauth_codes').get()).toEqual({ n: 0 });

    const refresh = await app.request('http://localhost/oauth/alice/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'refresh-1' }),
    }, env);
    expect(refresh.status).toBe(400);
  });
});
