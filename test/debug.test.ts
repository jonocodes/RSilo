import { describe, it, expect, beforeAll } from 'vitest';
import { createServer } from '../src/index';
import { seedToken } from './helpers/tokens';

class FakeStorage {
  objects = new Map<string, { body: ArrayBuffer; contentType: string }>();

  async put(key: string, body: ArrayBuffer, contentType: string): Promise<string> {
    this.objects.set(key, { body, contentType });
    return '"etag"';
  }

  async get(key: string) {
    const entry = this.objects.get(key);
    if (!entry) return null;
    return {
      body: entry.body,
      metadata: {
        contentType: entry.contentType,
        contentLength: entry.body.byteLength,
        etag: '"etag"',
      },
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async head(key: string) {
    const entry = this.objects.get(key);
    if (!entry) return null;
    return {
      contentType: entry.contentType,
      contentLength: entry.body.byteLength,
      etag: '"etag"',
    };
  }

  async list(prefix: string) {
    const objects = [
      { key: 'users/alice/storage/documents/a.txt', size: 100, etag: '"a"', contentType: 'text/plain' },
      { key: 'users/alice/storage/documents/b.txt', size: 50, etag: '"b"', contentType: 'text/plain' },
      { key: 'users/alice/storage/documents/', size: 0, etag: '' },
      { key: 'users/alice/storage/pictures/c.png', size: 300, etag: '"c"', contentType: 'image/png' },
      { key: 'users/alice/storage/public/documents/d.txt', size: 20, etag: '"d"', contentType: 'text/plain' },
    ].filter((o) => o.key.startsWith(prefix));
    return { objects };
  }
}

function makeDb(user: any = null) {
  return {
    prepare: (sql: string) => ({
      bind: (..._args: any[]) => ({
        first: async () => {
          if (sql.includes('FROM users WHERE username')) return user;
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => ({}),
      }),
      first: async () => (sql.includes('SELECT 1') ? { ok: 1 } : null),
      all: async () => ({ results: [] }),
      run: async () => ({}),
    }),
  } as any;
}

const testUser = {
  id: '1',
  username: 'alice',
  storage_quota_bytes: 1000,
  used_storage_bytes: 400,
};

describe('GET /admin/debug/token', () => {
  let app: ReturnType<typeof createServer>;
  const env = { STORAGE: new FakeStorage() as any, DB: makeDb() };

  beforeAll(() => {
    app = createServer(env);
  });

  it('introspects a valid opaque token', async () => {
    const token = seedToken(env, 'alice', 'documents:rw pictures:r');
    const res = await app.request(
      `http://localhost/admin/debug/token?token=${encodeURIComponent(token)}`,
      { method: 'GET' },
      env,
    );

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.valid).toBe(true);
    expect(json.sub).toBe('alice');
    expect(json.source).toBe('oauth_token');
    expect(json.parsed_scopes).toContainEqual({ raw: 'documents:rw', module: 'documents', permissions: 'rw' });
  });

  it('reports scope checks against the token scopes', async () => {
    const token = seedToken(env, 'alice', 'documents:rw');
    const res = await app.request(
      `http://localhost/admin/debug/token?token=${encodeURIComponent(token)}&scope=documents:rw&scope=pictures:r`,
      { method: 'GET' },
      env,
    );

    const json = await res.json() as any;
    expect(json.scope_checks['documents:rw']).toBe(true);
    expect(json.scope_checks['pictures:r']).toBe(false);
  });

  it('returns valid:false for a malformed token', async () => {
    const res = await app.request(
      'http://localhost/admin/debug/token?token=not-a-token',
      { method: 'GET' },
      env,
    );

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.valid).toBe(false);
  });

  it('reports an unsigned JWT as invalid', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'alice', scopes: '*:rw', exp: 9999999999 })).toString('base64url');
    const res = await app.request(
      `http://localhost/admin/debug/token?token=${header}.${payload}.`,
      { method: 'GET' },
      env,
    );

    const json = await res.json() as any;
    expect(json.valid).toBe(false);
    expect(json.source).toBeNull();
    expect(json).not.toHaveProperty('jwt_secret_set');
  });

  it('accepts a token in a POST body', async () => {
    const token = seedToken(env, 'alice', 'documents:rw');
    const res = await app.request(
      'http://localhost/admin/debug/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.valid).toBe(true);
  });

  it('returns 400 when no token is supplied', async () => {
    const res = await app.request('http://localhost/admin/debug/token', { method: 'GET' }, env);
    expect(res.status).toBe(400);
  });
});

describe('GET /admin/debug/storage/:username', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer({ STORAGE: new FakeStorage() as any, DB: makeDb(testUser) });
  });

  it('summarises actual storage and reports drift against the DB counter', async () => {
    const env = { STORAGE: new FakeStorage() as any, DB: makeDb(testUser) };
    const res = await app.request('http://localhost/admin/debug/storage/alice', { method: 'GET' }, env);

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.actual_objects).toBe(4);
    expect(json.actual_bytes).toBe(470);
    expect(json.db_used_storage_bytes).toBe(400);
    expect(json.drift_bytes).toBe(70);
    expect(json.by_module.documents).toEqual({ objects: 2, bytes: 150 });
    expect(json.by_module.pictures).toEqual({ objects: 1, bytes: 300 });
    expect(json.by_module['public/documents']).toEqual({ objects: 1, bytes: 20 });
  });

  it('returns 404 for an unknown user', async () => {
    const env = { STORAGE: new FakeStorage() as any, DB: makeDb(null) };
    const res = await app.request('http://localhost/admin/debug/storage/nobody', { method: 'GET' }, env);
    expect(res.status).toBe(404);
  });

  it('returns 503 when the DB is unavailable', async () => {
    const env = { STORAGE: new FakeStorage() as any, DB: null };
    const res = await app.request('http://localhost/admin/debug/storage/alice', { method: 'GET' }, env);
    expect(res.status).toBe(503);
  });
});

describe('GET /admin/debug/health/deep', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer({ STORAGE: new FakeStorage() as any, DB: makeDb() });
  });

  it('reports ok with a storage round-trip and a DB check', async () => {
    const env = { STORAGE: new FakeStorage() as any, DB: makeDb() };
    const res = await app.request('http://localhost/admin/debug/health/deep', { method: 'GET' }, env);

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.status).toBe('ok');
    expect(json.checks.storage.ok).toBe(true);
    expect(json.checks.storage.backend).toBe('local');
    expect(json.checks.database.ok).toBe(true);
    expect(json.checks.rate_limiters.ok).toBe(true);
    expect(json.checks.rate_limiters.skipped).toBe(true);
  });

  it('does not leave health-check objects behind', async () => {
    const storage = new FakeStorage();
    const env = { STORAGE: storage as any, DB: makeDb() };
    await app.request('http://localhost/admin/debug/health/deep', { method: 'GET' }, env);
    expect([...storage.objects.keys()].filter((k) => k.startsWith('_healthcheck/'))).toHaveLength(0);
  });

  it('returns 503 when storage round-trip fails', async () => {
    const brokenStorage = {
      put: async () => { throw new Error('r2 down'); },
      get: async () => null,
      delete: async () => {},
      head: async () => null,
      list: async () => ({ objects: [] }),
    };
    const env = { STORAGE: brokenStorage as any, DB: makeDb() };
    const res = await app.request('http://localhost/admin/debug/health/deep', { method: 'GET' }, env);

    expect(res.status).toBe(503);
    const json = await res.json() as any;
    expect(json.status).toBe('error');
    expect(json.checks.storage.ok).toBe(false);
  });
});

describe('GET /admin/debug/env', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer({ STORAGE: new FakeStorage() as any, DB: makeDb() });
  });

  it('reports bindings and redacts secrets to booleans', async () => {
    const env = { STORAGE: new FakeStorage() as any, DB: makeDb(), ADMIN_SECRET: 'super-secret-value' };
    const res = await app.request(
      'http://localhost/admin/debug/env',
      { method: 'GET', headers: { Authorization: 'Bearer super-secret-value' } },
      env,
    );

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.bindings.STORAGE).toBe(true);
    expect(json.bindings.DB).toBe(true);
    expect(json.bindings.LOGIN_LIMITER).toBe(false);
    expect(json.bindings.STORAGE_LIMITER).toBe(false);
    expect(json.storage_backend).toBe('local');
    expect(json.secrets_set.ADMIN_SECRET).toBe(true);
    expect(json.secrets_set).not.toHaveProperty('JWT_SECRET');

    const text = await new Response(JSON.stringify(json)).text();
    expect(text).not.toContain('super-secret-value');
  });
});

describe('debug endpoints auth', () => {
  it('requires ADMIN_SECRET when set', async () => {
    const app = createServer({ STORAGE: new FakeStorage() as any, DB: makeDb() });
    const env = { STORAGE: new FakeStorage() as any, DB: makeDb(), ADMIN_SECRET: 'mysecret' };

    const res = await app.request('http://localhost/admin/debug/env', { method: 'GET' }, env);
    expect(res.status).toBe(401);

    const authed = await app.request(
      'http://localhost/admin/debug/env',
      { method: 'GET', headers: { Authorization: 'Bearer mysecret' } },
      env,
    );
    expect(authed.status).toBe(200);
  });
});

function makeOAuthDb({ clients = [] as any[], tokens = [] as any[], codes = [] as any[] }) {
  return {
    prepare: (sql: string) => ({
      all: async () => {
        if (sql.includes('FROM oauth_clients')) return { results: clients };
        if (sql.includes('FROM oauth_tokens')) return { results: tokens };
        if (sql.includes('FROM oauth_codes')) return { results: codes };
        return { results: [] };
      },
      first: async () => null,
      run: async () => ({}),
      bind: () => ({
        all: async () => ({ results: [] }),
        first: async () => null,
        run: async () => ({}),
      }),
    }),
  } as any;
}

describe('GET /admin/debug/oauth', () => {
  const now = Math.floor(Date.now() / 1000);
  const clients = [
    { id: 'app-1', name: 'App One', user_id: 'alice', redirect_uris: 'https://app.example/cb', created_at: now - 1000 },
  ];
  const tokens = [
    { id: 't1', access_token: 'secret-access', refresh_token: 'secret-refresh', user_id: 'alice', client_id: 'app-1', scopes: 'documents:rw', created_at: now - 100, expires_at: now + 3600 },
    { id: 't2', access_token: 'secret-access-2', refresh_token: null, user_id: 'alice', client_id: 'app-1', scopes: 'pictures:r', created_at: now - 100, expires_at: now - 10 },
  ];
  const codes = [
    { code: 'abcdef1234567890', client_id: 'app-1', user_id: 'alice', redirect_uri: 'https://app.example/cb', scope: 'documents:rw', expires_at: now + 600, created_at: now },
  ];

  it('summarises clients, tokens and codes without leaking secrets', async () => {
    const env = { STORAGE: new FakeStorage() as any, DB: makeOAuthDb({ clients, tokens, codes }) };
    const app = createServer(env);
    const res = await app.request('http://localhost/admin/debug/oauth', { method: 'GET' }, env);

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.summary).toEqual({ clients: 1, tokens: 2, active_tokens: 1, expired_tokens: 1, pending_codes: 1 });
    expect(json.clients[0].token_count).toBe(2);
    expect(json.tokens[0].has_refresh_token).toBe(true);
    expect(json.tokens[1].has_refresh_token).toBe(false);
    expect(json.tokens[0].access_token).toBeUndefined();
    expect(json.tokens[0].refresh_token).toBeUndefined();
    expect(json.codes[0].code_prefix).toBe('abcdef12');
    expect(json.codes[0].code).toBeUndefined();
  });
});

describe('GET /admin/debug/echo', () => {
  const env = { STORAGE: new FakeStorage() as any, DB: makeDb() };
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer(env);
  });

  it('echoes the request and redacts auth headers', async () => {
    const res = await app.request(
      'http://localhost/admin/debug/echo?path=/storage/alice/documents/note.txt',
      { method: 'GET', headers: { Authorization: 'Bearer adminsecret', Cookie: 'a=b', 'X-Test': 'yes' } },
      env,
    );

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.method).toBe('GET');
    expect(json.headers.authorization).toBe('[redacted]');
    expect(json.headers.cookie).toBe('[redacted]');
    expect(json.headers['x-test']).toBe('yes');
    expect(json.storage.username).toBe('alice');
    expect(json.storage.path).toBe('documents/note.txt');
    expect(json.storage.module).toBe('documents');
    expect(json.storage.method_required_scope).toBe('documents:r');
  });

  it('reports the write scope and public flag', async () => {
    const res = await app.request(
      'http://localhost/admin/debug/echo?path=/storage/alice/public/documents/x.txt&method=PUT',
      { method: 'POST' },
      env,
    );
    const json = await res.json() as any;
    expect(json.storage.is_public).toBe(true);
    expect(json.storage.module).toBe('documents');
    expect(json.storage.method_required_scope).toBe('documents:rw');
  });

  it('introspects a token from the query and redacts it from the echo', async () => {
    const token = seedToken(env, 'alice', 'documents:rw');
    const res = await app.request(
      `http://localhost/admin/debug/echo?token=${encodeURIComponent(token)}`,
      { method: 'GET' },
      env,
    );
    const json = await res.json() as any;
    expect(json.query.token).toBe('[redacted]');
    expect(json.token.valid).toBe(true);
    expect(json.token.sub).toBe('alice');
  });

  it('previews a textual body and flags truncation', async () => {
    const body = 'x'.repeat(3000);
    const res = await app.request(
      'http://localhost/admin/debug/echo',
      { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body },
      env,
    );
    const json = await res.json() as any;
    expect(json.body.bytes).toBe(3000);
    expect(json.body.truncated).toBe(true);
    expect(json.body.preview.length).toBe(2048);
  });
});
