import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createServer, createTestToken } from '../src/index';
import { hashPassword, signSessionToken } from '../src/services/auth';

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
      { method: 'OPTIONS' },
      TEST_ENV
    );

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('OPTIONS');
  });

  it('OAuth endpoint works with dev token for storage', async () => {
    const token = createTestToken('alice');

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
});

describe('OAuth login flow', () => {
  let app: ReturnType<typeof createServer>;
  let passwordHash: string;
  const SESSION_SECRET = 'test-session-secret';

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

  beforeAll(async () => {
    passwordHash = await hashPassword('correctpassword');
    app = createServer(TEST_ENV);
  });

  it('GET /oauth/:user/authorize returns HTML login form', async () => {
    const env = { STORAGE: {} as any, DB: makeDb(), SESSION_SECRET };
    const res = await app.request(
      'http://localhost/oauth/alice/authorize?client_id=test-client&redirect_uri=https://example.com/callback&response_type=code&scope=documents:rw',
      { method: 'GET' },
      env
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Sign in');
    expect(html).toContain('alice');
    expect(html).toContain('type="password"');
  });

  it('POST login with correct password shows consent screen', async () => {
    const env = { STORAGE: {} as any, DB: makeDb({ username: 'alice', password_hash: passwordHash }), SESSION_SECRET };
    const body = new URLSearchParams({
      action: 'login',
      password: 'correctpassword',
      client_id: 'test-client',
      redirect_uri: 'https://example.com/callback',
      response_type: 'code',
      scope: 'documents:rw',
      state: 'xyz',
    });
    const res = await app.request(
      'http://localhost/oauth/alice/authorize',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() },
      env
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Authorize Access');
    expect(html).toContain('documents:rw');
    expect(html).toContain('session_token');
  });

  it('POST login with wrong password returns 401 login form', async () => {
    const env = { STORAGE: {} as any, DB: makeDb({ username: 'alice', password_hash: passwordHash }), SESSION_SECRET };
    const body = new URLSearchParams({
      action: 'login',
      password: 'wrongpassword',
      client_id: 'test-client',
      redirect_uri: 'https://example.com/callback',
      response_type: 'code',
      scope: 'documents:rw',
      state: '',
    });
    const res = await app.request(
      'http://localhost/oauth/alice/authorize',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() },
      env
    );
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain('Invalid username or password');
    expect(html).toContain('type="password"');
  });

  it('POST login with no password returns 400', async () => {
    const env = { STORAGE: {} as any, DB: makeDb({ username: 'alice', password_hash: passwordHash }), SESSION_SECRET };
    const body = new URLSearchParams({
      action: 'login',
      client_id: 'test-client',
      redirect_uri: 'https://example.com/callback',
      response_type: 'code',
      scope: 'documents:rw',
      state: '',
    });
    const res = await app.request(
      'http://localhost/oauth/alice/authorize',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() },
      env
    );
    expect(res.status).toBe(400);
  });

  it('POST login for unknown user returns 401', async () => {
    const env = { STORAGE: {} as any, DB: makeDb(null), SESSION_SECRET };
    const body = new URLSearchParams({
      action: 'login',
      password: 'anypassword',
      client_id: 'test-client',
      redirect_uri: 'https://example.com/callback',
      response_type: 'code',
      scope: 'documents:rw',
      state: '',
    });
    const res = await app.request(
      'http://localhost/oauth/alice/authorize',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() },
      env
    );
    expect(res.status).toBe(401);
  });

  it('POST approve with valid session_token redirects with code', async () => {
    const sessionToken = await signSessionToken('alice', SESSION_SECRET);
    const codeInserts: string[] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...args: any[]) => ({
          first: async () => null,
          run: async () => { if (sql.includes('oauth_codes')) codeInserts.push(args[0]); },
        }),
      }),
    } as any;
    const env = { STORAGE: {} as any, DB: db, SESSION_SECRET };
    const body = new URLSearchParams({
      action: 'approve',
      session_token: sessionToken,
      client_id: 'test-client',
      redirect_uri: 'https://example.com/callback',
      response_type: 'code',
      scope: 'documents:rw',
      state: 'xyz',
    });
    const res = await app.request(
      'http://localhost/oauth/alice/authorize',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() },
      env
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('Location') || '';
    expect(location).toContain('https://example.com/callback');
    expect(location).toContain('code=');
    expect(location).toContain('state=xyz');
  });

  it('POST approve with invalid session_token returns 401', async () => {
    const env = { STORAGE: {} as any, DB: makeDb(), SESSION_SECRET };
    const body = new URLSearchParams({
      action: 'approve',
      session_token: 'invalid.token',
      client_id: 'test-client',
      redirect_uri: 'https://example.com/callback',
      response_type: 'code',
      scope: 'documents:rw',
      state: '',
    });
    const res = await app.request(
      'http://localhost/oauth/alice/authorize',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() },
      env
    );
    expect(res.status).toBe(401);
  });

  it('POST deny redirects with access_denied', async () => {
    const env = { STORAGE: {} as any, DB: makeDb(), SESSION_SECRET };
    const body = new URLSearchParams({
      action: 'deny',
      redirect_uri: 'https://example.com/callback',
      state: 'xyz',
    });
    const res = await app.request(
      'http://localhost/oauth/alice/authorize',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() },
      env
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('Location') || '';
    expect(location).toContain('error=access_denied');
    expect(location).toContain('state=xyz');
  });
});