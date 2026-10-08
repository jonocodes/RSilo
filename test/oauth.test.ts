import { describe, it, expect, beforeAll } from 'vitest';
import { createServer } from '../src/index';
import { seedToken } from './helpers/tokens';
import { PRODUCTION_INSTANCE } from './helpers/instance';

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

describe('OAuth endpoints', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer(TEST_ENV);
  });

it('GET /oauth/:user returns OAuth discover info', async () => {
    const res = await app.request(
      'http://localhost/oauth/alice',
      { method: 'GET' },
      TEST_ENV
    );

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.auth_method).toBe('popup');
    expect(json.owner).toBe('alice');
    expect(json.auth).toContain('/oauth/alice/authorize');
    expect(json.token_endpoint).toContain('/oauth/alice/token');
    expect(json.storageapi).toContain('/storage/alice');
  });

  it('advertises HTTPS endpoints from an HTTPS PUBLIC_BASE_URL', async () => {
    const env = { ...TEST_ENV, PUBLIC_BASE_URL: 'https://storage.example' };
    const res = await app.request('http://localhost/oauth/alice', { method: 'GET' }, env);
    const json = await res.json() as any;
    expect(json.auth).toBe('https://storage.example/oauth/alice/authorize');
    expect(json.token_endpoint).toBe('https://storage.example/oauth/alice/token');
    expect(json.storageapi).toBe('https://storage.example/storage/alice');
  });

  it('ignores X-Forwarded-Proto, so a request cannot downgrade the advertised scheme', async () => {
    const env = { ...TEST_ENV, PUBLIC_BASE_URL: 'https://storage.example' };
    const res = await app.request('http://storage.example/oauth/alice', {
      method: 'GET',
      headers: { 'X-Forwarded-Proto': 'http' },
    }, env);
    const json = await res.json() as any;
    expect(json.auth).toMatch(/^https:\/\//);
  });

  it('POST /oauth/:user/token with authorization_code returns access_token', async () => {
    const codeData = {
      client_id: 'test-client',
      user_id: 'alice',
      redirect_uri: 'https://example.com/callback',
      scope: 'documents:rw',
      expires_at: Math.floor(Date.now() / 1000) + 600,
    };

    const oauthEnv = {
      ...TEST_ENV,
      DB: {
        prepare: (sql: string) => ({
          bind: (..._args: any[]) => ({
            first: async () => sql.includes('oauth_codes') ? codeData : null,
            run: async () => {},
          }),
        }),
      } as any,
    };

    const res = await app.request(
      'http://localhost/oauth/alice/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: 'test-auth-code',
          redirect_uri: 'https://example.com/callback',
          client_id: 'test-client',
        }),
      },
      oauthEnv
    );

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.access_token).toBeDefined();
    expect(json.refresh_token).toBeDefined();
    expect(json.token_type).toBe('Bearer');
    expect(json.expires_in).toBe(3600);
    expect(json.scope).toBe('documents:rw');
  });

  it('POST /oauth/:user/token with refresh_token returns new access_token', async () => {
    const tokenStore = new Map<string, any>();
    tokenStore.set('test-refresh-token', {
      id: 'token-id',
      access_token: 'old-access-token',
      refresh_token: 'test-refresh-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      scopes: 'documents:rw',
      user_id: 'alice',
      client_id: 'test-client',
    });

    const oauthEnv = {
      ...TEST_ENV,
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => tokenStore.get('test-refresh-token'),
          }),
        }),
      },
    };

    const res = await app.request(
      'http://localhost/oauth/alice/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: 'test-refresh-token',
          client_id: 'test-client',
        }),
      },
      oauthEnv
    );

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.access_token).toBeDefined();
    expect(json.refresh_token).toBeDefined();
    expect(json.token_type).toBe('Bearer');
    expect(json.expires_in).toBe(3600);
  });

  it('POST /oauth/:user/token with invalid code returns 400', async () => {
    const oauthEnv = {
      ...TEST_ENV,
      OAUTH_CODES: new Map(),
    };

    const res = await app.request(
      'http://localhost/oauth/alice/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: 'invalid-code',
          redirect_uri: 'https://example.com/callback',
          client_id: 'test-client',
        }),
      },
      oauthEnv
    );

    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.error).toBe('invalid_grant');
  });

  it('GET /oauth/:user/authorize without required params returns invalid_request', async () => {
    const res = await app.request(
      'http://localhost/oauth/alice/authorize',
      { method: 'GET' },
      TEST_ENV
    );

    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.error).toBeOneOf(['invalid_request', 'unsupported_response_type']);
  });

  it('POST /oauth/:user/token with unsupported grant_type returns 400', async () => {
    const res = await app.request(
      'http://localhost/oauth/alice/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'password',
          client_id: 'test-client',
        }),
      },
      TEST_ENV
    );

    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.error).toBe('unsupported_grant_type');
  });

  it('OPTIONS /oauth/:user returns CORS headers', async () => {
    const res = await app.request(
      'http://localhost/oauth/alice',
      { method: 'OPTIONS' },
      TEST_ENV
    );

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
  });

  it('OPTIONS /oauth/:user/token returns CORS headers', async () => {
    const res = await app.request(
      'http://localhost/oauth/alice/token',
      {
        method: 'OPTIONS',
        headers: { 'Access-Control-Request-Method': 'POST' },
      },
      TEST_ENV
    );

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  it('OAuth endpoint works with dev token for storage', async () => {
    const token = seedToken(TEST_ENV, 'alice');

    const res = await app.request(
      'http://localhost/oauth/alice',
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      },
      TEST_ENV
    );

    expect(res.status).toBe(200);
  });

  it('POST /oauth/:user/token with expired code returns invalid_grant', async () => {
    const oauthEnv = {
      ...TEST_ENV,
      DB: {
        prepare: (_sql: string) => ({
          bind: (..._args: any[]) => ({
            first: async () => null,
            run: async () => {},
          }),
        }),
      } as any,
    };

    const res = await app.request(
      'http://localhost/oauth/alice/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: 'expired-code',
          redirect_uri: 'https://example.com/callback',
          client_id: 'test-client',
        }),
      },
      oauthEnv
    );

    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.error).toBe('invalid_grant');
  });

  it('POST /oauth/:user/token with redirect_uri mismatch returns invalid_grant', async () => {
    const codeData = {
      client_id: 'test-client',
      user_id: 'alice',
      redirect_uri: 'https://example.com/callback',
      scope: 'documents:rw',
      expires_at: Math.floor(Date.now() / 1000) + 600,
    };

    const oauthEnv = {
      ...TEST_ENV,
      DB: {
        prepare: (sql: string) => ({
          bind: (..._args: any[]) => ({
            first: async () => sql.includes('oauth_codes') ? codeData : null,
            run: async () => {},
          }),
        }),
      } as any,
    };

    const res = await app.request(
      'http://localhost/oauth/alice/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: 'test-code',
          redirect_uri: 'https://evil.com/callback',
          client_id: 'test-client',
        }),
      },
      oauthEnv
    );

    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.error).toBe('invalid_grant');
  });

  it('POST /oauth/:user/token deletes code after use (prevents reuse)', async () => {
    const codes = new Map<string, any>();
    codes.set('one-time-code', {
      client_id: 'test-client',
      user_id: 'alice',
      redirect_uri: 'https://example.com/callback',
      scope: 'documents:rw',
      expires_at: Math.floor(Date.now() / 1000) + 600,
    });

    const oauthEnv = {
      ...TEST_ENV,
      DB: {
        prepare: (sql: string) => ({
          bind: (codeVal: string, ..._rest: any[]) => ({
            first: async () => sql.includes('oauth_codes') ? codes.get(codeVal) ?? null : null,
            run: async () => {
              if (sql.includes('DELETE FROM oauth_codes')) codes.delete(codeVal);
            },
          }),
        }),
      } as any,
    };

    const body = JSON.stringify({
      grant_type: 'authorization_code',
      code: 'one-time-code',
      redirect_uri: 'https://example.com/callback',
      client_id: 'test-client',
    });

    const first = await app.request('http://localhost/oauth/alice/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }, oauthEnv);
    expect(first.status).toBe(200);

    const second = await app.request('http://localhost/oauth/alice/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }, oauthEnv);
    expect(second.status).toBe(400);
    const json = await second.json() as any;
    expect(json.error).toBe('invalid_grant');
  });
});

describe('OAuth consent flow', () => {
  let app: ReturnType<typeof createServer>;
  // Same-origin form posts from the consent page (CSRF check), and a
  // non-local production request with no Cloudflare Access identity.
  const SAME_ORIGIN = { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin' };
  const PRODUCTION = { RSILO_DEV_MODE: 'false', ...PRODUCTION_INSTANCE };

  const validClient = {
    id: 'test-client',
    name: 'Test App',
    redirect_uris: 'https://example.com/callback',
    user_id: 'alice',
  };

  function makeDb(userRow: any = null) {
    return {
      prepare: (sql: string) => ({
        bind: (..._args: any[]) => ({
          first: async () => {
            if (sql.includes('oauth_clients')) return validClient;
            if (sql.includes('users')) return userRow;
            return null;
          },
          run: async () => ({}),
        }),
        first: async () => null,
        run: async () => ({}),
        all: async () => ({ results: [] }),
      }),
    } as any;
  }

  function recordingDb(table: string, inserts: any[]) {
    return {
      prepare: (sql: string) => ({
        bind: (...args: any[]) => ({
          first: async () => null,
          run: async () => { if (sql.includes(`INSERT INTO ${table}`)) inserts.push(args); },
        }),
      }),
    } as any;
  }

  function approveBody(extra: Record<string, string> = {}) {
    return new URLSearchParams({
      action: 'approve',
      client_id: 'test-client',
      redirect_uri: 'https://example.com/callback',
      response_type: 'code',
      scope: 'documents:rw',
      state: 'xyz',
      ...extra,
    }).toString();
  }

  beforeAll(async () => {
    app = createServer(TEST_ENV);
  });

  it('GET /oauth/:user/authorize renders the consent form, with no password step', async () => {
    const env = { STORAGE: {} as any, DB: makeDb() };
    const res = await app.request(
      'http://localhost/oauth/alice/authorize?client_id=test-client&redirect_uri=https://example.com/callback&response_type=code&scope=documents:rw',
      { method: 'GET' },
      env
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Authorize Access');
    expect(html).toContain('alice');
    expect(html).toContain('documents:rw');
    expect(html).toContain('name="action" value="approve"');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('session_token');
  });

  it('POST approve as the Owner redirects with code', async () => {
    const codeInserts: any[] = [];
    const env = { STORAGE: {} as any, DB: recordingDb('oauth_codes', codeInserts) };
    const res = await app.request(
      'http://localhost/oauth/alice/authorize',
      { method: 'POST', headers: SAME_ORIGIN, body: approveBody() },
      env
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('Location') || '';
    expect(location).toContain('https://example.com/callback');
    expect(location).toContain('code=');
    expect(location).toContain('state=xyz');
    expect(codeInserts.length).toBe(1);
  });

  it('POST approve with an Origin equal to PUBLIC_BASE_URL is accepted when Sec-Fetch-Site is absent', async () => {
    const env = { STORAGE: {} as any, DB: recordingDb('oauth_codes', []) };
    const res = await app.request(
      'http://localhost/oauth/alice/authorize',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost:8787' }, body: approveBody() },
      env
    );
    expect(res.status).toBe(302);
  });

  for (const [name, headers] of [
    ['Sec-Fetch-Site: cross-site', { 'Sec-Fetch-Site': 'cross-site' }],
    ['Sec-Fetch-Site: same-site', { 'Sec-Fetch-Site': 'same-site' }],
    ['a foreign Origin', { Origin: 'https://evil.example' }],
    ['neither header', {}],
  ] as const) {
    it(`POST approve with ${name} is refused with 403 and issues nothing`, async () => {
      const codeInserts: any[] = [];
      const env = { STORAGE: {} as any, DB: recordingDb('oauth_codes', codeInserts) };
      const res = await app.request(
        'http://localhost/oauth/alice/authorize',
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: approveBody() },
        env
      );
      expect(res.status).toBe(403);
      expect(res.headers.get('Location')).toBeNull();
      expect(codeInserts).toHaveLength(0);
    });
  }

  it('POST approve without an Owner identity returns 401 (production, no Cloudflare Access)', async () => {
    const codeInserts: any[] = [];
    const env = { STORAGE: {} as any, DB: recordingDb('oauth_codes', codeInserts), ...PRODUCTION };
    const res = await app.request(
      'https://rsilo.example/oauth/alice/authorize',
      {
        method: 'POST',
        headers: { ...SAME_ORIGIN, 'Cf-Access-Jwt-Assertion': 'forged.jwt.value' },
        body: approveBody(),
      },
      env
    );
    expect(res.status).toBe(401);
    expect(codeInserts).toHaveLength(0);
  });

  it('POST approve with an Access identity other than OWNER_EMAIL returns 401', async () => {
    const env = { STORAGE: {} as any, DB: recordingDb('oauth_codes', []), ...PRODUCTION };
    const ctx = {
      waitUntil() {},
      passThroughOnException() {},
      access: { aud: 'aud', getIdentity: async () => ({ email: 'mallory@example.com' }) },
    } as any;
    const res = await app.request(
      'https://rsilo.example/oauth/alice/authorize',
      { method: 'POST', headers: SAME_ORIGIN, body: approveBody() },
      env,
      ctx
    );
    expect(res.status).toBe(401);
  });

  it('POST approve with the Owner\'s Access identity redirects with code (production)', async () => {
    const env = { STORAGE: {} as any, DB: recordingDb('oauth_codes', []), ...PRODUCTION };
    const ctx = {
      waitUntil() {},
      passThroughOnException() {},
      access: { aud: 'aud', getIdentity: async () => ({ email: 'Owner@Example.com' }) },
    } as any;
    const res = await app.request(
      'https://rsilo.example/oauth/alice/authorize',
      { method: 'POST', headers: SAME_ORIGIN, body: approveBody() },
      env,
      ctx
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('code=');
  });

  it('POST deny redirects with access_denied', async () => {
    const env = { STORAGE: {} as any, DB: makeDb() };
    const body = new URLSearchParams({
      action: 'deny',
      redirect_uri: 'https://example.com/callback',
      state: 'xyz',
    });
    const res = await app.request(
      'http://localhost/oauth/alice/authorize',
      { method: 'POST', headers: SAME_ORIGIN, body: body.toString() },
      env
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('Location') || '';
    expect(location).toContain('error=access_denied');
    expect(location).toContain('state=xyz');
  });

  it('POST approve with response_type=token redirects with access_token in hash', async () => {
    const tokenInserts: any[] = [];
    const env = { STORAGE: {} as any, DB: recordingDb('oauth_tokens', tokenInserts) };
    const res = await app.request(
      'http://localhost/oauth/alice/authorize',
      { method: 'POST', headers: SAME_ORIGIN, body: approveBody({ response_type: 'token', state: 'abc' }) },
      env
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('Location') || '';
    expect(location).toContain('https://example.com/callback');
    expect(location).toContain('access_token=');
    expect(location).toContain('token_type=Bearer');
    expect(location).toContain('state=abc');
    expect(tokenInserts.length).toBe(1);
  });

  it('GET /authorize with unsupported response_type returns 400', async () => {
    const env = { STORAGE: {} as any, DB: makeDb() };
    const res = await app.request(
      'http://localhost/oauth/alice/authorize?client_id=test-client&redirect_uri=https://example.com/callback&response_type=invalid',
      { method: 'GET' },
      env
    );
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.error).toBe('unsupported_response_type');
  });

  it('GET /authorize auto-accepts an unknown client_id (no pre-registration)', async () => {
    const noClientDb = {
      prepare: (_sql: string) => ({
        bind: (..._args: any[]) => ({ first: async () => null, run: async () => ({}) }),
      }),
    } as any;
    const env = { STORAGE: {} as any, DB: noClientDb };
    const res = await app.request(
      'http://localhost/oauth/alice/authorize?client_id=unknown&redirect_uri=https://example.com/callback&response_type=code',
      { method: 'GET' },
      env
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(await res.text()).toContain('unknown');
  });

  it('GET /authorize with an invalid redirect_uri returns 400', async () => {
    const env = { STORAGE: {} as any, DB: makeDb() };
    const res = await app.request(
      'http://localhost/oauth/alice/authorize?client_id=test-client&redirect_uri=not-a-url&response_type=code',
      { method: 'GET' },
      env
    );
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.error).toBe('invalid_request');
  });

  it('POST /token with refresh_token=missing returns invalid_grant', async () => {
    const emptyDb = {
      prepare: () => ({ bind: (..._: any[]) => ({ first: async () => null, run: async () => ({}) }) }),
    } as any;
    const env = { ...TEST_ENV, DB: emptyDb };
    const res = await app.request(
      'http://localhost/oauth/alice/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'no-such-token', client_id: 'x' }),
      },
      env
    );
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.error).toBe('invalid_grant');
  });

  it('POST /token with authorization_code via form-urlencoded works', async () => {
    const codeData = {
      client_id: 'test-client',
      user_id: 'alice',
      redirect_uri: 'https://example.com/callback',
      scope: 'documents:rw',
      expires_at: Math.floor(Date.now() / 1000) + 600,
    };
    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: any[]) => ({
          first: async () => sql.includes('oauth_codes') ? codeData : null,
          run: async () => {},
        }),
      }),
    } as any;
    const env = { ...TEST_ENV, DB: db };
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'test-code',
      redirect_uri: 'https://example.com/callback',
      client_id: 'test-client',
    });
    const res = await app.request(
      'http://localhost/oauth/alice/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      },
      env
    );
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.access_token).toBeDefined();
    expect(json.token_type).toBe('Bearer');
  });
});