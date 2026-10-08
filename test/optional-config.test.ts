import { describe, it, expect } from 'vitest';
import { createServer } from '../src/index';
import { createSqliteD1, usernames, type SqliteD1 } from './helpers/sqlite-d1';

// OWNER_EMAIL is the only required setting. ACCOUNT_USERNAME defaults to "me"
// and PUBLIC_BASE_URL to the request's own origin; a missing OWNER_EMAIL closes
// only the human surfaces, while storage, discovery and the token endpoint keep
// serving connected apps. All in production mode (RSILO_DEV_MODE=false).

const app = createServer({});
const HOST = 'rsilo.test-sub.workers.dev';
const ORIGIN = `https://${HOST}`;

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

/** Only OWNER_EMAIL set, as after a fresh `bun run setup` or Deploy button. */
function minimalEnv(extra: Record<string, unknown> = {}) {
  return {
    STORAGE: new MemoryStorage() as any,
    DB: createSqliteD1(),
    RSILO_DEV_MODE: 'false',
    STORAGE_LIMITER: { limit: async () => ({ success: true }) },
    OWNER_EMAIL: 'owner@example.com',
    ...extra,
  } as any;
}

/** The Account "me" with an app token (access "tok", refresh "ref"). */
function seedApp(db: SqliteD1, username = 'me') {
  db.sqlite.exec(`INSERT INTO users (id, username) VALUES ('u1', '${username}')`);
  db.sqlite.exec(`INSERT INTO oauth_clients (id, name, redirect_uris, user_id) VALUES ('https://app.example', 'app', '[]', '${username}')`);
  db.sqlite.exec(`INSERT INTO oauth_tokens (id, access_token, refresh_token, expires_at, scopes, user_id, client_id)
    VALUES ('t1', 'tok', 'ref', 9999999999, 'documents:rw', '${username}', 'https://app.example')`);
}

const q = (resource: string) => `resource=${encodeURIComponent(resource)}`;
const storageLink = (json: any) => json.links.find((l: any) => l.rel === 'http://tools.ietf.org/id/draft-dejong-remotestorage');

const ADD_OWNER_EMAIL = 'Workers &amp; Pages → rsilo → Settings → Variables and Secrets → Add → Type: Text, '
  + 'Variable name: OWNER_EMAIL, Value: your email → Deploy';
const EDIT_OWNER_EMAIL = 'Workers &amp; Pages → rsilo → Settings → Variables and Secrets → OWNER_EMAIL → Edit → Deploy';
const ACCESS_POLICY = 'Zero Trust → Access → Applications → RSilo app → Policies';

describe('PUBLIC_BASE_URL unset: the request origin is advertised', () => {
  it('WebFinger builds every URL from the request origin', async () => {
    const res = await app.request(`${ORIGIN}/.well-known/webfinger?${q(`acct:me@${HOST}`)}`, {}, minimalEnv());
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(storageLink(json).href).toBe(`${ORIGIN}/storage/me`);
    expect(storageLink(json).properties['http://tools.ietf.org/html/rfc6749#section-4.2']).toBe(`${ORIGIN}/account/oauth/authorize`);
  });

  it('ignores X-Forwarded-Host and X-Forwarded-Proto', async () => {
    const headers = { 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'http' };
    const res = await app.request(`${ORIGIN}/.well-known/webfinger?${q(`acct:me@${HOST}`)}`, { headers }, minimalEnv());
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain('evil.example');
    expect(text).not.toContain(`http://${HOST}`);

    const forged = await app.request(`${ORIGIN}/.well-known/webfinger?${q('acct:me@evil.example')}`, { headers }, minimalEnv());
    expect(forged.status).toBe(404);
  });

  it('/oauth/:user discovery and the legacy consent redirect use the request origin', async () => {
    const discovery = await (await app.request(`${ORIGIN}/oauth/me`, {}, minimalEnv())).json() as any;
    expect(discovery.www).toBe(ORIGIN);
    expect(discovery.auth).toBe(`${ORIGIN}/account/oauth/authorize`);
    expect(discovery.token_endpoint).toBe(`${ORIGIN}/oauth/me/token`);

    const redirect = await app.request(`${ORIGIN}/oauth/me/authorize?client_id=x`, {}, minimalEnv());
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('Location')).toBe(`${ORIGIN}/account/oauth/authorize?client_id=x`);
  });

  it('matches acct: and host-only resources against the request host; acct: may omit the port', async () => {
    const base = 'https://rs.example:8443';
    const env = minimalEnv();
    const status = async (resource: string) =>
      (await app.request(`${base}/.well-known/webfinger?${q(resource)}`, {}, env)).status;
    expect(await status('acct:me@rs.example:8443')).toBe(200);
    expect(await status('acct:me@rs.example')).toBe(200);
    expect(await status('https://rs.example:8443/')).toBe(200);
    expect(await status('acct:me@rs.example:9999')).toBe(404);
    expect(await status('https://rs.example')).toBe(404);
    expect(await status(`acct:me@${HOST}`)).toBe(404);
  });

  it('the CSRF Origin check compares against the request origin', async () => {
    const post = (origin: string) => app.request(`${ORIGIN}/account/quota`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
      body: 'quota_gb=1',
    }, minimalEnv(), accessCtx({ email: 'owner@example.com' }));
    expect((await post(ORIGIN)).status).toBe(302);
    expect((await post('https://evil.example')).status).toBe(403);
  });
});

describe('PUBLIC_BASE_URL set: it wins over the request host', () => {
  it('advertises PUBLIC_BASE_URL whatever host the request came in on', async () => {
    const env = minimalEnv({ PUBLIC_BASE_URL: 'https://rs.example' });
    const res = await app.request(`${ORIGIN}/.well-known/webfinger?${q('acct:me@rs.example')}`, {}, env);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(storageLink(json).href).toBe('https://rs.example/storage/me');
    expect(JSON.stringify(json)).not.toContain(HOST);

    const ownHost = await app.request(`${ORIGIN}/.well-known/webfinger?${q(`acct:me@${HOST}`)}`, {}, env);
    expect(ownHost.status).toBe(404);
  });

  it('the CSRF Origin check compares against PUBLIC_BASE_URL', async () => {
    const env = minimalEnv({ PUBLIC_BASE_URL: 'https://rs.example' });
    const res = await app.request(`${ORIGIN}/account/quota`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN },
      body: 'quota_gb=1',
    }, env, accessCtx({ email: 'owner@example.com' }));
    expect(res.status).toBe(403);
  });
});

describe('ACCOUNT_USERNAME unset: the Account is "me"', () => {
  it('serves storage for me@<host> and creates the "me" row', async () => {
    const env = minimalEnv();
    const res = await app.request(`${ORIGIN}/storage/me/public/documents/x.txt`, {}, env);
    expect(res.status).toBe(404);
    expect(usernames(env.DB)).toEqual(['me']);

    const other = await app.request(`${ORIGIN}/.well-known/webfinger?${q(`acct:alice@${HOST}`)}`, {}, env);
    expect(other.status).toBe(404);
  });

  it('a blank ACCOUNT_USERNAME also means "me"', async () => {
    const res = await app.request(`${ORIGIN}/oauth/me`, {}, minimalEnv({ ACCOUNT_USERNAME: '  ' }));
    expect(res.status).toBe(200);
    expect((await res.json() as any).owner).toBe('me');
  });

  it('the dashboard shows the storage address me@<host>', async () => {
    const res = await app.request(`${ORIGIN}/account`, {}, minimalEnv(), accessCtx({ email: 'owner@example.com' }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`me@${HOST}`);
  });
});

describe('OWNER_EMAIL missing: only the human surfaces wait', () => {
  const noOwner = () => minimalEnv({ OWNER_EMAIL: undefined });

  it('/account shows finish-setup naming OWNER_EMAIL, with the visitor\'s Access email and the click path', async () => {
    const res = await app.request(`${ORIGIN}/account`, {}, noOwner(), accessCtx({ email: 'Visitor@Example.com' }));
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain('OWNER_EMAIL');
    expect(html).toContain("You're signed in through Cloudflare Access as <strong>Visitor@Example.com</strong>");
    expect(html).toContain('<code>Visitor@Example.com</code>');
    expect(html).toContain(ADD_OWNER_EMAIL);
    expect(html).toMatch(/keep syncing/);
    // Access is already in front of /account, so its steps are not repeated.
    expect(html).not.toContain('Self-hosted');
  });

  it('the consent page waits too', async () => {
    const consent = `${ORIGIN}/account/oauth/authorize?client_id=https%3A%2F%2Fapp.example&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&response_type=token&scope=documents%3Arw`;
    const res = await app.request(consent, {}, noOwner(), accessCtx({ email: 'visitor@example.com' }));
    expect(res.status).toBe(503);
  });

  it('without Access either, shows both sections, OWNER_EMAIL first', async () => {
    const res = await app.request(`${ORIGIN}/account`, {}, noOwner());
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).not.toContain('signed in through Cloudflare Access');
    expect(html.indexOf('Set your sign-in email')).toBeGreaterThan(-1);
    expect(html.indexOf('Self-hosted')).toBeGreaterThan(html.indexOf('Set your sign-in email'));
  });

  it('says "your Worker" on a host that is not workers.dev', async () => {
    const html = await (await app.request('https://rs.example/account', {}, noOwner(), accessCtx({ email: 'v@example.com' }))).text();
    expect(html).toContain('Workers &amp; Pages → your Worker → Settings → Variables and Secrets → Add');
  });

  it('storage with a valid token, WebFinger and the token endpoint keep working', async () => {
    const env = noOwner();
    seedApp(env.DB);

    const put = await app.request(`${ORIGIN}/storage/me/documents/a.txt`, {
      method: 'PUT', headers: { Authorization: 'Bearer tok', 'Content-Type': 'text/plain' }, body: 'hi',
    }, env);
    expect(put.status).toBe(201);
    const get = await app.request(`${ORIGIN}/storage/me/documents/a.txt`, { headers: { Authorization: 'Bearer tok' } }, env);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe('hi');

    const webfinger = await app.request(`${ORIGIN}/.well-known/webfinger?${q(`acct:me@${HOST}`)}`, {}, env);
    expect(webfinger.status).toBe(200);

    const token = await app.request(`${ORIGIN}/oauth/me/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=ref',
    }, env);
    expect(token.status).toBe(200);
    expect((await token.json() as any).access_token).toBeTruthy();
  });

  it('an invalid OWNER_EMAIL is described without echoing the value', async () => {
    const env = minimalEnv({ OWNER_EMAIL: 'not-an-email-zq9' });
    const res = await app.request(`${ORIGIN}/account`, {}, env, accessCtx({ email: 'visitor@example.com' }));
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain('OWNER_EMAIL must be an email address');
    expect(html).toContain(EDIT_OWNER_EMAIL);
    expect(html).not.toContain('zq9');

    const storage = await app.request(`${ORIGIN}/storage/me/public/documents/x.txt`, {}, env);
    expect(storage.status).toBe(404);
  });
});

describe('the 403 (wrong email) page', () => {
  it('shows the signed-in email and both places to update, never OWNER_EMAIL itself', async () => {
    const env = minimalEnv({ OWNER_EMAIL: 'configured-owner@example.com' });
    const res = await app.request(`${ORIGIN}/account`, {}, env, accessCtx({ email: 'new-me@example.com' }));
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain('<strong>new-me@example.com</strong>');
    expect(html).toContain(EDIT_OWNER_EMAIL);
    expect(html).toContain(ACCESS_POLICY);
    expect(html).not.toContain('configured-owner');
  });
});

describe('the dashboard sign-in section', () => {
  it('shows "Signed in as" and how to change the sign-in email', async () => {
    const res = await app.request(`${ORIGIN}/account`, {}, minimalEnv(), accessCtx({ email: 'owner@example.com' }));
    const html = await res.text();
    expect(html).toContain('Signed in as <strong>owner@example.com</strong>');
    expect(html).toContain('Change your sign-in email');
    expect(html).toContain(EDIT_OWNER_EMAIL);
    expect(html).toContain(ACCESS_POLICY);
  });
});

describe('username mismatch with the default "me"', () => {
  function oldInstance() {
    const env = minimalEnv();
    env.DB.sqlite.exec("INSERT INTO users (id, username) VALUES ('u1', 'jono-old')");
    return env;
  }

  it('the Owner sees the stored username and how to set ACCOUNT_USERNAME to it', async () => {
    const res = await app.request(`${ORIGIN}/account`, {}, oldInstance(), accessCtx({ email: 'owner@example.com' }));
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain('Username mismatch');
    expect(html).toContain('<code>jono-old</code>');
    expect(html).toContain('Workers &amp; Pages → rsilo → Settings → Variables and Secrets → Add → Type: Text, Variable name: ACCOUNT_USERNAME, Value: jono-old → Deploy');
  });

  it('public storage 503s without naming the stored username', async () => {
    const res = await app.request(`${ORIGIN}/storage/me/public/documents/x.txt`, {}, oldInstance());
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toContain('ACCOUNT_USERNAME');
    expect(text).not.toContain('jono-old');
  });

  it('a non-Owner never sees it', async () => {
    const res = await app.request(`${ORIGIN}/account`, {}, oldInstance(), accessCtx({ email: 'mallory@example.com' }));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('jono-old');
  });
});
