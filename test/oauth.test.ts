import { describe, it, expect, beforeAll } from 'vitest';
import { createServer, createTestToken } from '../src/index';

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
    const codeStore = new Map<string, any>();
    codeStore.set('test-auth-code', {
      client_id: 'test-client',
      user_id: 'alice',
      redirect_uri: 'https://example.com/callback',
      scope: 'documents:rw',
      expires_at: Math.floor(Date.now() / 1000) + 600,
    });

    const oauthEnv = {
      ...TEST_ENV,
      OAUTH_CODES: codeStore,
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