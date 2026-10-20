import { describe, it, expect, vi } from 'vitest';
import { createServer } from '../src/index';
import { createSqliteD1 } from '../src/services/db/sqlite';
import type { SqliteD1, SqliteStatement } from '../src/services/db/sqlite';
import { PKCE, seedToken, tokenHash } from './helpers/tokens';
import { MemoryStorage } from './helpers/memory-storage';

// OAuth discovery and the token endpoint. The whole consent -> code -> token
// flow lives in consent.test.ts, PKCE enforcement in pkce.test.ts, and refresh
// rotation plus hashed storage in token-hardening.test.ts; this file keeps
// discovery, the error grants and the few endpoint behaviours not covered
// there, all against the real SQLite database.

function makeEnv(extra: Record<string, unknown> = {}) {
  return { STORAGE: new MemoryStorage(), DB: createSqliteD1(), ...extra };
}

const REDIRECT_URI = 'https://example.com/callback';

function insertCode(env: { DB: SqliteD1 }, code: string, overrides: { redirect_uri?: string; expires_at?: number } = {}) {
  env.DB.sqlite.prepare(
    'INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, scope, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    tokenHash(code),
    'test-client',
    'alice',
    overrides.redirect_uri ?? REDIRECT_URI,
    'documents:rw',
    PKCE.challenge,
    overrides.expires_at ?? Math.floor(Date.now() / 1000) + 600,
  );
}

// D1 answers over the network: each statement runs at once, but its result
// arrives later, so concurrent requests interleave between statements.
function withLatency(db: SqliteD1): SqliteD1 {
  const later = <T>(result: Promise<T>) => new Promise<T>(resolve => setTimeout(() => resolve(result), 5));
  const statement = (s: SqliteStatement): SqliteStatement => ({
    bind: (...values: unknown[]) => statement(s.bind(...values)),
    first: () => later(s.first()),
    all: () => later(s.all()),
    run: () => later(s.run()),
  }) as unknown as SqliteStatement;
  return { ...db, prepare: (sql: string) => statement(db.prepare(sql)) };
}

function exchange(env: unknown, body: Record<string, string>) {
  return createServer(env).request('http://localhost/oauth/alice/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  }, env);
}

describe('OAuth endpoint discovery', () => {
  const app = createServer({});

  it('GET /oauth/:user returns OAuth discover info', async () => {
    const env = makeEnv();
    const res = await app.request('http://localhost/oauth/alice', { method: 'GET' }, env);

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.auth_method).toBe('popup');
    expect(json.owner).toBe('alice');
    expect(json.auth).toContain('/account/oauth/authorize');
    expect(json.token_endpoint).toContain('/oauth/alice/token');
    expect(json.storageapi).toContain('/storage/alice');
  });

  it('advertises HTTPS endpoints from an HTTPS PUBLIC_BASE_URL', async () => {
    const env = makeEnv({ PUBLIC_BASE_URL: 'https://storage.example' });
    const res = await app.request('http://localhost/oauth/alice', { method: 'GET' }, env);
    const json = await res.json() as any;
    expect(json.auth).toBe('https://storage.example/account/oauth/authorize');
    expect(json.token_endpoint).toBe('https://storage.example/oauth/alice/token');
    expect(json.storageapi).toBe('https://storage.example/storage/alice');
  });

  it('ignores X-Forwarded-Proto, so a request cannot downgrade the advertised scheme', async () => {
    const env = makeEnv({ PUBLIC_BASE_URL: 'https://storage.example' });
    const res = await app.request('http://storage.example/oauth/alice', {
      method: 'GET',
      headers: { 'X-Forwarded-Proto': 'http' },
    }, env);
    const json = await res.json() as any;
    expect(json.auth).toMatch(/^https:\/\//);
  });

  it('OPTIONS /oauth/:user returns CORS headers', async () => {
    const res = await app.request('http://localhost/oauth/alice', { method: 'OPTIONS' }, makeEnv());
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
  });

  it('OPTIONS /oauth/:user/token returns CORS headers', async () => {
    const res = await app.request('http://localhost/oauth/alice/token', {
      method: 'OPTIONS',
      headers: { 'Access-Control-Request-Method': 'POST' },
    }, makeEnv());
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });
});

describe('OAuth token endpoint', () => {
  it('returns unsupported_grant_type for an unknown grant', async () => {
    const env = makeEnv();
    const res = await exchange(env, { grant_type: 'password', client_id: 'test-client' });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe('unsupported_grant_type');
  });

  it('rejects an unknown authorization code with invalid_grant', async () => {
    const res = await exchange(makeEnv(), {
      grant_type: 'authorization_code',
      code: 'no-such-code',
      redirect_uri: REDIRECT_URI,
      code_verifier: PKCE.verifier,
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe('invalid_grant');
  });

  it('rejects an expired authorization code with invalid_grant', async () => {
    const env = makeEnv();
    insertCode(env, 'expired-code', { expires_at: Math.floor(Date.now() / 1000) - 1 });
    const res = await exchange(env, {
      grant_type: 'authorization_code',
      code: 'expired-code',
      redirect_uri: REDIRECT_URI,
      code_verifier: PKCE.verifier,
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe('invalid_grant');
  });

  it('rejects a redirect_uri that differs from the one the code was issued for', async () => {
    const env = makeEnv();
    insertCode(env, 'code-with-redirect');
    const res = await exchange(env, {
      grant_type: 'authorization_code',
      code: 'code-with-redirect',
      redirect_uri: 'https://evil.com/callback',
      code_verifier: PKCE.verifier,
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe('invalid_grant');
    // The attempt spent the code.
    expect(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM oauth_codes').get()).toEqual({ n: 0 });
  });

  it('deletes a code after use, so it cannot be replayed', async () => {
    const env = makeEnv();
    seedToken(env, 'alice');
    insertCode(env, 'one-time-code');
    const body = {
      grant_type: 'authorization_code',
      code: 'one-time-code',
      redirect_uri: REDIRECT_URI,
      code_verifier: PKCE.verifier,
    };

    const first = await exchange(env, body);
    expect(first.status).toBe(200);
    const json = await first.json() as any;
    expect(json.access_token).toBeTruthy();
    expect(json.refresh_token).toBeTruthy();
    expect(json.token_type).toBe('Bearer');
    expect(json.scope).toBe('documents:rw');

    const second = await exchange(env, body);
    expect(second.status).toBe(400);
    expect((await second.json() as any).error).toBe('invalid_grant');
  });

  it('redeems a code once when two requests race for it', async () => {
    const env = makeEnv();
    env.DB = withLatency(env.DB);
    seedToken(env, 'alice');
    insertCode(env, 'raced-code');
    const body = { grant_type: 'authorization_code', code: 'raced-code', redirect_uri: REDIRECT_URI, code_verifier: PKCE.verifier };

    const results = await Promise.all([exchange(env, body), exchange(env, body)]);
    expect(results.map(res => res.status).sort()).toEqual([200, 400]);
    expect(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM oauth_tokens WHERE refresh_token_hash IS NOT NULL').get()).toEqual({ n: 1 });
  });

  it('rejects an unknown refresh_token with invalid_grant', async () => {
    const res = await exchange(makeEnv(), {
      grant_type: 'refresh_token',
      refresh_token: 'no-such-token',
      client_id: 'test-client',
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe('invalid_grant');
  });
});

describe('malformed token requests', () => {
  const BODIES: [string, Record<string, string>, string][] = [
    ['invalid JSON', { 'Content-Type': 'application/json' }, '{"grant_type":'],
    ['a JSON array', { 'Content-Type': 'application/json' }, '["refresh_token"]'],
    ['JSON null', { 'Content-Type': 'application/json' }, 'null'],
    ['a multipart body', { 'Content-Type': 'multipart/form-data; boundary=x' }, '--x--'],
    ['no Content-Type', {}, 'grant_type=refresh_token'],
  ];

  for (const [name, headers, body] of BODIES) {
    it(`answers ${name} with 400 invalid_request`, async () => {
      const env = makeEnv();
      const res = await createServer(env).request('http://localhost/oauth/alice/token', { method: 'POST', headers, body }, env);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_request' });
    });
  }

  it('treats non-string JSON values as missing', async () => {
    const env = makeEnv();
    const res = await createServer(env).request('http://localhost/oauth/alice/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: 123 }),
    }, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('is a 503 without a database (dev mode), not tokens that were never stored', async () => {
    const env = { STORAGE: new MemoryStorage() };
    const res = await exchange(env, { grant_type: 'refresh_token', refresh_token: 'x' });
    expect(res.status).toBe(503);
  });
});

describe('database and storage failures surface as 500', () => {
  it('a database that throws during token lookup is a logged 500 that reveals nothing, not a silent 401', async () => {
    const env = {
      STORAGE: new MemoryStorage(),
      DB: { prepare: () => { throw new Error('Database connection failed'); } } as any,
    };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await createServer(env).request('http://localhost/storage/alice/documents/test.txt', {
        method: 'GET',
        headers: { Authorization: 'Bearer opaque-token' },
      }, env);
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('Internal Server Error');
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ message: 'Database connection failed' }));
    } finally {
      log.mockRestore();
    }
  });

  it('a storage get failure after auth is a 500', async () => {
    const env = makeEnv();
    env.STORAGE.get = async () => { throw new Error('Storage get failed'); };
    const token = seedToken(env, 'alice', '*:rw');
    const res = await createServer(env).request('http://localhost/storage/alice/documents/test.txt', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, env);
    expect(res.status).toBe(500);
  });
});
