import { describe, it, expect } from 'vitest';
import { createServer } from '../src/index';
import { PRODUCTION_INSTANCE } from './helpers/instance';
import { createSqliteD1 } from './helpers/sqlite-d1';

// OAuth consent lives under the Owner-gated /account prefix (ADR-0004, #18):
// GET renders it from the query string alone, POST approves or denies. The
// legacy /oauth/:user/authorize URL only redirects there; the token endpoint
// stays ungated. Dev-mode requests to localhost are signed in as the dev
// identity (the Owner, unless RSILO_DEV_EMAIL says otherwise).

const app = createServer({});
const DEV_BASE = 'http://localhost:8787';
const CONSENT_URL = 'http://localhost/account/oauth/authorize';
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const SAME_ORIGIN = { ...FORM, 'Sec-Fetch-Site': 'same-origin' };

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

function devEnv(extra: Record<string, unknown> = {}) {
  return { STORAGE: new MemoryStorage() as any, DB: createSqliteD1(), ...extra } as any;
}

function count(env: any, table: string): number {
  return Number((env.DB.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n);
}

const REQUEST = {
  client_id: 'https://app.example',
  redirect_uri: 'https://app.example/cb',
  response_type: 'code',
  scope: 'documents:rw pictures:r',
  state: 's=1&t=2',
};

function query(params: Record<string, string> = {}): string {
  return new URLSearchParams({ ...REQUEST, ...params }).toString();
}

function form(params: Record<string, string> = {}): string {
  return new URLSearchParams({ ...REQUEST, action: 'approve', ...params }).toString();
}

function post(env: any, body: string, headers: Record<string, string> = SAME_ORIGIN, url = CONSENT_URL, ctx?: any) {
  return app.request(url, { method: 'POST', headers, body }, env, ctx);
}

describe('consent page (GET /account/oauth/authorize)', () => {
  it('renders the app origin host, the requested Modules and the redirect target', async () => {
    const res = await app.request(`${CONSENT_URL}?${query()}`, {}, devEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('app.example');
    expect(html).toContain('documents');
    expect(html).toContain('pictures');
    expect(html).toContain('read and write');
    expect(html).toContain('read only');
    expect(html).toContain('https://app.example/cb');
    expect(html).not.toContain('type="password"');
  });

  it('posts back to the same path with every parameter as a hidden field', async () => {
    const res = await app.request(`${CONSENT_URL}?${query()}`, {}, devEnv());
    const html = await res.text();
    expect(html).toContain('action="/account/oauth/authorize"');
    expect(html).not.toContain('/oauth/alice/authorize');
    expect(html).toContain('name="client_id" value="https://app.example"');
    expect(html).toContain('name="redirect_uri" value="https://app.example/cb"');
    expect(html).toContain('name="response_type" value="code"');
    expect(html).toContain('name="scope" value="documents:rw pictures:r"');
    expect(html).toContain('name="state" value="s=1&amp;t=2"');
    expect(html).toContain('name="action" value="approve"');
    expect(html).toContain('name="action" value="deny"');
  });

  it('escapes HTML in the parameters', async () => {
    const res = await app.request(`${CONSENT_URL}?${query({ state: '"><script>x</script>' })}`, {}, devEnv());
    const html = await res.text();
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('carries the /account security headers, with form-action widened to the app origin only', async () => {
    const res = await app.request(`${CONSENT_URL}?${query()}`, {}, devEnv());
    const csp = res.headers.get('Content-Security-Policy') || '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'self' https://app.example");
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('keeps form-action \'self\' on the rest of /account', async () => {
    const res = await app.request('http://localhost/account', {}, devEnv());
    expect(res.headers.get('Content-Security-Policy')).toContain("form-action 'self';");
  });

  it('defaults a missing scope to documents:rw', async () => {
    const params = new URLSearchParams(REQUEST);
    params.delete('scope');
    const res = await app.request(`${CONSENT_URL}?${params}`, {}, devEnv());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('name="scope" value="documents:rw"');
  });

  it('requires client_id and redirect_uri', async () => {
    const res = await app.request(CONSENT_URL, {}, devEnv());
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('invalid_request');
  });

  it('rejects an unsupported response_type', async () => {
    const res = await app.request(`${CONSENT_URL}?${query({ response_type: 'id_token' })}`, {}, devEnv());
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('unsupported_response_type');
  });

  it('answers a non-Owner identity with the 403 page from the /account gate', async () => {
    const res = await app.request(`${CONSENT_URL}?${query()}`, {}, devEnv({ RSILO_DEV_EMAIL: 'mallory@example.com' }));
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain('mallory@example.com');
    expect(html).not.toContain('name="action"');
  });
});

describe('redirect_uri origin check (protocol §10)', () => {
  const BAD: [string, Record<string, string>][] = [
    ['a redirect_uri on another origin', { redirect_uri: 'https://evil.example/cb' }],
    ['a redirect_uri on another port', { redirect_uri: 'https://app.example:8443/cb' }],
    ['a redirect_uri on another scheme', { redirect_uri: 'http://app.example/cb' }],
    ['a javascript: redirect_uri', { redirect_uri: 'javascript:alert(1)' }],
    ['a data: redirect_uri', { redirect_uri: 'data:text/html,hi' }],
    ['a custom-scheme redirect_uri', { client_id: 'myapp://app', redirect_uri: 'myapp://app/cb' }],
    ['a non-URL redirect_uri', { redirect_uri: 'not-a-url' }],
    ['a non-URL client_id', { client_id: 'test-client' }],
    ['an ftp: client_id', { client_id: 'ftp://app.example', redirect_uri: 'ftp://app.example/cb' }],
  ];

  for (const [name, params] of BAD) {
    it(`GET with ${name} is a 400 with no redirect`, async () => {
      const res = await app.request(`${CONSENT_URL}?${query(params)}`, {}, devEnv());
      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBeNull();
      expect(res.headers.get('Content-Type')).toContain('text/plain');
      expect(await res.text()).toContain('invalid_request');
    });

    it(`POST approve with ${name} is a 400 that issues nothing`, async () => {
      const env = devEnv();
      for (const responseType of ['code', 'token']) {
        const res = await post(env, form({ ...params, response_type: responseType }));
        expect(res.status).toBe(400);
        expect(res.headers.get('Location')).toBeNull();
      }
      expect(count(env, 'oauth_codes')).toBe(0);
      expect(count(env, 'oauth_tokens')).toBe(0);
      expect(count(env, 'oauth_clients')).toBe(0);
    });

    it(`POST deny with ${name} is a 400 with no redirect`, async () => {
      const res = await post(devEnv(), form({ ...params, action: 'deny' }));
      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBeNull();
    });
  }

  it('accepts a redirect_uri on the client_id origin with a different path and query', async () => {
    const res = await app.request(`${CONSENT_URL}?${query({ client_id: 'https://app.example/some/page', redirect_uri: 'https://APP.example:443/x?y=1' })}`, {}, devEnv());
    expect(res.status).toBe(200);
  });
});

describe('approve and deny (POST /account/oauth/authorize)', () => {
  it('code flow: approve redirects with a code that the ungated token endpoint exchanges for a working token', async () => {
    const env = devEnv();
    const approve = await post(env, form());
    expect(approve.status).toBe(302);
    const location = new URL(approve.headers.get('Location')!);
    expect(location.origin + location.pathname).toBe('https://app.example/cb');
    expect(location.searchParams.get('state')).toBe('s=1&t=2');
    const code = location.searchParams.get('code');
    expect(code).toBeTruthy();

    const token = await app.request('http://localhost/oauth/alice/token', {
      method: 'POST',
      headers: FORM,
      body: new URLSearchParams({ grant_type: 'authorization_code', code: code!, redirect_uri: REQUEST.redirect_uri }).toString(),
    }, env);
    expect(token.status).toBe(200);
    const json = await token.json() as any;
    expect(json.scope).toBe('documents:rw pictures:r');

    const put = await app.request('http://localhost/storage/alice/documents/a.txt', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${json.access_token}`, 'Content-Type': 'text/plain' },
      body: 'hi',
    }, env);
    expect(put.status).toBeOneOf([200, 201]);
  });

  it('implicit flow: approve redirects with the token in the fragment, and it works on storage', async () => {
    const env = devEnv();
    const approve = await post(env, form({ response_type: 'token' }));
    expect(approve.status).toBe(302);
    const location = new URL(approve.headers.get('Location')!);
    expect(location.origin + location.pathname).toBe('https://app.example/cb');
    expect(location.search).toBe('');
    const fragment = new URLSearchParams(location.hash.slice(1));
    expect(fragment.get('token_type')).toBe('Bearer');
    expect(fragment.get('state')).toBe('s=1&t=2');
    const accessToken = fragment.get('access_token');
    expect(accessToken).toBeTruthy();

    const put = await app.request('http://localhost/storage/alice/documents/b.txt', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'text/plain' },
      body: 'hi',
    }, env);
    expect(put.status).toBeOneOf([200, 201]);
    expect(count(env, 'oauth_clients')).toBe(1);
  });

  it('deny redirects to the app with access_denied and the state, issuing nothing', async () => {
    const env = devEnv();
    const res = await post(env, form({ action: 'deny' }));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('Location')!);
    expect(location.origin).toBe('https://app.example');
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('s=1&t=2');
    expect(count(env, 'oauth_codes')).toBe(0);
    expect(count(env, 'oauth_tokens')).toBe(0);
  });

  it('rejects an unknown action', async () => {
    const res = await post(devEnv(), form({ action: 'maybe' }));
    expect(res.status).toBe(400);
    expect(res.headers.get('Location')).toBeNull();
  });

  it('accepts an Origin equal to PUBLIC_BASE_URL when Sec-Fetch-Site is absent', async () => {
    const res = await post(devEnv(), form(), { ...FORM, Origin: DEV_BASE });
    expect(res.status).toBe(302);
  });

  for (const [name, headers] of [
    ['Sec-Fetch-Site: cross-site', { 'Sec-Fetch-Site': 'cross-site' }],
    ['Sec-Fetch-Site: same-site', { 'Sec-Fetch-Site': 'same-site' }],
    ['a foreign Origin', { Origin: 'https://evil.example' }],
    ['neither header', {}],
  ] as const) {
    it(`refuses approve with ${name} (403) and issues nothing`, async () => {
      const env = devEnv();
      const res = await post(env, form(), { ...FORM, ...headers });
      expect(res.status).toBe(403);
      expect(res.headers.get('Location')).toBeNull();
      expect(count(env, 'oauth_codes')).toBe(0);
    });
  }

  it('refuses a cross-site deny too', async () => {
    const res = await post(devEnv(), form({ action: 'deny' }), { ...FORM, 'Sec-Fetch-Site': 'cross-site' });
    expect(res.status).toBe(403);
    expect(res.headers.get('Location')).toBeNull();
  });

  it('answers a non-Owner identity with 403 and issues nothing', async () => {
    const env = devEnv({ RSILO_DEV_EMAIL: 'mallory@example.com' });
    const res = await post(env, form());
    expect(res.status).toBe(403);
    expect(res.headers.get('Location')).toBeNull();
    expect(count(env, 'oauth_codes')).toBe(0);
  });
});

describe('consent in production (Cloudflare Access)', () => {
  const BASE = PRODUCTION_INSTANCE.PUBLIC_BASE_URL;

  function productionEnv() {
    return devEnv({ RSILO_DEV_MODE: 'false', ...PRODUCTION_INSTANCE });
  }

  function accessCtx(email: string) {
    return { waitUntil() {}, passThroughOnException() {}, access: { aud: 'aud', getIdentity: async () => ({ email }) } } as any;
  }

  it('the Owner\'s Access identity approves', async () => {
    const res = await post(productionEnv(), form(), SAME_ORIGIN, `${BASE}/account/oauth/authorize`, accessCtx('Owner@Example.com'));
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('code=');
  });

  it('another Access identity gets the 403 page', async () => {
    const env = productionEnv();
    const res = await post(env, form(), SAME_ORIGIN, `${BASE}/account/oauth/authorize`, accessCtx('mallory@example.com'));
    expect(res.status).toBe(403);
    expect(count(env, 'oauth_codes')).toBe(0);
  });

  it('without Access the gate shows the finish-setup page and issues nothing', async () => {
    const env = productionEnv();
    const res = await post(env, form(), { ...SAME_ORIGIN, 'Cf-Access-Jwt-Assertion': 'forged.jwt.value' }, `${BASE}/account/oauth/authorize`);
    expect(res.status).toBe(503);
    expect(res.headers.get('Location')).toBeNull();
    expect(count(env, 'oauth_codes')).toBe(0);
  });
});

describe('legacy consent URL (/oauth/:user/authorize)', () => {
  // Encoded redirect_uri with its own query, a literal +, %20, and a state
  // carrying encoded = and &: none of it may be decoded or re-encoded. (A raw
  // ' is not used: the WHATWG URL parser, in browsers and in the runtime,
  // already sends it as %27, so it never reaches the Worker unencoded.)
  const TRICKY = 'client_id=https%3A%2F%2Fapp.example&redirect_uri=https%3A%2F%2Fapp.example%2Fcb%3Fx%3D1%26y%3D2'
    + '&response_type=token&scope=documents:rw+pictures%3Ar%20music:rw&state=a%3Db%26c%3Dd+e%20f~*()!%27';

  it('GET redirects to the consent page with the query string byte-for-byte', async () => {
    const res = await app.request(`http://localhost/oauth/alice/authorize?${TRICKY}`, {}, devEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`${DEV_BASE}/account/oauth/authorize?${TRICKY}`);
  });

  it('GET builds the target from PUBLIC_BASE_URL, not Host', async () => {
    const res = await app.request(`http://evil.example/oauth/alice/authorize?${TRICKY}`, {}, devEnv({ PUBLIC_BASE_URL: 'https://rs.example' }));
    expect(res.headers.get('Location')).toBe(`https://rs.example/account/oauth/authorize?${TRICKY}`);
  });

  it('GET without a query string redirects without one', async () => {
    const res = await app.request('http://localhost/oauth/alice/authorize', {}, devEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`${DEV_BASE}/account/oauth/authorize`);
  });

  it('the redirected request renders the same consent', async () => {
    const legacy = await app.request(`http://localhost/oauth/alice/authorize?${query()}`, {}, devEnv());
    const target = new URL(legacy.headers.get('Location')!);
    const res = await app.request(`http://localhost${target.pathname}${target.search}`, {}, devEnv());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('name="state" value="s=1&amp;t=2"');
  });

  it('GET for another username is a 404', async () => {
    const res = await app.request(`http://localhost/oauth/bob/authorize?${query()}`, {}, devEnv());
    expect(res.status).toBe(404);
    expect(res.headers.get('Location')).toBeNull();
  });

  it('POST is a 405 (consent is no longer submitted here) and issues nothing', async () => {
    const env = devEnv();
    const res = await post(env, form(), SAME_ORIGIN, 'http://localhost/oauth/alice/authorize');
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, OPTIONS');
    expect(res.headers.get('Location')).toBeNull();
    expect(count(env, 'oauth_codes')).toBe(0);
  });

  it('POST for another username is a 404', async () => {
    const res = await post(devEnv(), form(), SAME_ORIGIN, 'http://localhost/oauth/bob/authorize');
    expect(res.status).toBe(404);
  });
});

describe('discovery advertises the consent page under /account', () => {
  const RESOURCE = 'acct:alice@localhost:8787';
  const AUTH = `${DEV_BASE}/account/oauth/authorize`;

  it('WebFinger (rfc6749#section-4.2 property and remoteStorage auth link)', async () => {
    const res = await app.request(`http://localhost/.well-known/webfinger?resource=${encodeURIComponent(RESOURCE)}`, {}, devEnv());
    const json = await res.json() as any;
    const storage = json.links.find((l: any) => l.rel === 'http://tools.ietf.org/id/draft-dejong-remotestorage');
    expect(storage.properties['http://tools.ietf.org/html/rfc6749#section-4.2']).toBe(AUTH);
    expect(json.links.find((l: any) => l.rel === 'remoteStorage').auth).toBe(AUTH);
  });

  it('/webfinger/jrd', async () => {
    const res = await app.request(`http://localhost/webfinger/jrd?resource=${encodeURIComponent(RESOURCE)}`, {}, devEnv());
    expect((await res.json() as any).links[0].auth).toBe(AUTH);
  });

  it('/webfinger/xrd', async () => {
    const res = await app.request(`http://localhost/webfinger/xrd?resource=${encodeURIComponent(RESOURCE)}`, {}, devEnv());
    expect(await res.text()).toContain(`href="${AUTH}"`);
  });

  it('/oauth/:user discovery JSON, with the token endpoint unchanged', async () => {
    const res = await app.request('http://localhost/oauth/alice', {}, devEnv());
    const json = await res.json() as any;
    expect(json.auth).toBe(AUTH);
    expect(json.token_endpoint).toBe(`${DEV_BASE}/oauth/alice/token`);
  });
});
