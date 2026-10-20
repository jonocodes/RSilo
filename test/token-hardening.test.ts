import { describe, it, expect } from 'vitest';
import { createServer } from '../src/index';
import { createSqliteD1, type SqliteD1 } from '../src/services/db/sqlite';
import { PKCE, tokenHash as sha256 } from './helpers/tokens';
import { MemoryStorage } from './helpers/memory-storage';
import { generateToken, hashToken } from '../src/services/auth';
import { IMPLICIT_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS } from '../src/services/tokens';

// Hardening borrowed from cloudflare/workers-oauth-provider (see
// docs/research/workers-oauth-provider.md): secrets are stored only as hashes
// and generated secrets are unbiased base64url. Refresh tokens rotate, expire
// after 30 days, and only the newest one works. Required PKCE is covered in
// test/pkce.test.ts.

const app = createServer({});
const CONSENT_URL = 'http://localhost/account/oauth/authorize';
const TOKEN_URL = 'http://localhost/oauth/alice/token';
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const SAME_ORIGIN = { ...FORM, 'Sec-Fetch-Site': 'same-origin' };

const REQUEST = {
  client_id: 'https://app.example',
  redirect_uri: 'https://app.example/cb',
  response_type: 'code',
  scope: 'documents:rw',
  state: 's1',
  code_challenge: PKCE.challenge,
  code_challenge_method: 'S256',
};

function devEnv() {
  return { STORAGE: new MemoryStorage(), DB: createSqliteD1() };
}

function rows(env: { DB: SqliteD1 }, sql: string): any[] {
  return env.DB.sqlite.prepare(sql).all() as any[];
}

async function approve(env: unknown, params: Record<string, string> = {}) {
  return app.request(CONSENT_URL, {
    method: 'POST',
    headers: SAME_ORIGIN,
    body: new URLSearchParams({ ...REQUEST, action: 'approve', ...params }).toString(),
  }, env);
}

async function authorizationCode(env: unknown): Promise<string> {
  const res = await approve(env);
  expect(res.status).toBe(302);
  return new URL(res.headers.get('Location')!).searchParams.get('code')!;
}

function exchange(env: unknown, params: Record<string, string>) {
  return app.request(TOKEN_URL, { method: 'POST', headers: FORM, body: new URLSearchParams(params).toString() }, env);
}

function redeem(env: unknown, code: string) {
  return exchange(env, { grant_type: 'authorization_code', code, redirect_uri: REQUEST.redirect_uri, code_verifier: PKCE.verifier });
}

function refresh(env: unknown, refreshToken: string) {
  return exchange(env, { grant_type: 'refresh_token', refresh_token: refreshToken });
}

function putFile(env: unknown, token: string) {
  return app.request('http://localhost/storage/alice/documents/a.txt', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: 'hi',
  }, env);
}

describe('generated secrets', () => {
  it('are 256-bit base64url strings', () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(generateToken()).not.toBe(token);
  });

  it('hash to base64url SHA-256', async () => {
    expect(await hashToken('abc')).toBe(sha256('abc'));
  });
});

describe('secrets at rest', () => {
  it('stores an authorization code only as its hash', async () => {
    const env = devEnv();
    const code = await authorizationCode(env);
    const [row] = rows(env, 'SELECT * FROM oauth_codes');
    expect(row.code_hash).toBe(sha256(code));
    expect(JSON.stringify(row)).not.toContain(code);
  });

  it('stores access and refresh tokens only as hashes', async () => {
    const env = devEnv();
    const res = await redeem(env, await authorizationCode(env));
    expect(res.status).toBe(200);
    const { access_token, refresh_token } = await res.json() as any;

    const [row] = rows(env, 'SELECT * FROM oauth_tokens');
    expect(row.access_token_hash).toBe(sha256(access_token));
    expect(row.refresh_token_hash).toBe(sha256(refresh_token));
    const stored = JSON.stringify(rows(env, 'SELECT * FROM oauth_tokens'));
    expect(stored).not.toContain(access_token);
    expect(stored).not.toContain(refresh_token);
    expect((await putFile(env, access_token)).status).toBeOneOf([200, 201]);
  });

  it('stores an implicit-flow token only as its hash, and it still works', async () => {
    const env = devEnv();
    const res = await approve(env, { response_type: 'token', code_challenge: '', code_challenge_method: '' });
    const accessToken = new URLSearchParams(new URL(res.headers.get('Location')!).hash.slice(1)).get('access_token')!;
    const [row] = rows(env, 'SELECT * FROM oauth_tokens');
    expect(row.access_token_hash).toBe(sha256(accessToken));
    expect((await putFile(env, accessToken)).status).toBeOneOf([200, 201]);
  });

  it('rejects a bearer token equal to a stored hash', async () => {
    const env = devEnv();
    await redeem(env, await authorizationCode(env));
    const [row] = rows(env, 'SELECT * FROM oauth_tokens');
    expect((await putFile(env, row.access_token_hash)).status).toBe(401);
  });
});

describe('refresh token rotation', () => {
  async function tokens(env: { DB: SqliteD1 }) {
    return await (await redeem(env, await authorizationCode(env))).json() as any;
  }

  it('rotates both tokens; the old access token stops working', async () => {
    const env = devEnv();
    const first = await tokens(env);
    const res = await refresh(env, first.refresh_token);
    expect(res.status).toBe(200);
    const second = await res.json() as any;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await putFile(env, first.access_token)).status).toBe(401);
    expect((await putFile(env, second.access_token)).status).toBeOneOf([200, 201]);
  });

  it('rejects a superseded refresh token, and replaying it does not disturb the current one', async () => {
    const env = devEnv();
    const first = await tokens(env);
    const second = await (await refresh(env, first.refresh_token)).json() as any;

    for (let i = 0; i < 2; i++) {
      const replay = await refresh(env, first.refresh_token);
      expect(replay.status).toBe(400);
      expect((await replay.json() as any).error).toBe('invalid_grant');
    }
    expect((await putFile(env, second.access_token)).status).toBeOneOf([200, 201]);
    expect((await refresh(env, second.refresh_token)).status).toBe(200);
  });

  it('issues refresh tokens for 30 days, and each rotation starts a fresh 30 days', async () => {
    const env = devEnv();
    const first = await tokens(env);
    const [issued] = rows(env, 'SELECT expires_at, refresh_expires_at FROM oauth_tokens');
    const now = Math.floor(Date.now() / 1000);
    expect(issued.refresh_expires_at - now).toBeGreaterThan(REFRESH_TOKEN_TTL_SECONDS - 60);
    expect(issued.refresh_expires_at - now).toBeLessThanOrEqual(REFRESH_TOKEN_TTL_SECONDS);
    expect(issued.expires_at - now).toBeLessThanOrEqual(3600);

    env.DB.sqlite.prepare('UPDATE oauth_tokens SET refresh_expires_at = ?').run(now + 60);
    expect((await refresh(env, first.refresh_token)).status).toBe(200);
    const [rotated] = rows(env, 'SELECT refresh_expires_at FROM oauth_tokens');
    expect(rotated.refresh_expires_at - now).toBeGreaterThan(REFRESH_TOKEN_TTL_SECONDS - 60);
  });

  it('rejects an expired refresh token', async () => {
    const env = devEnv();
    const first = await tokens(env);
    env.DB.sqlite.prepare('UPDATE oauth_tokens SET refresh_expires_at = ?').run(Math.floor(Date.now() / 1000) - 1);
    const res = await refresh(env, first.refresh_token);
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe('invalid_grant');
  });
});

describe('implicit-flow tokens', () => {
  async function implicitToken(env: unknown): Promise<URLSearchParams> {
    const res = await approve(env, { response_type: 'token', code_challenge: '', code_challenge_method: '' });
    expect(res.status).toBe(302);
    return new URLSearchParams(new URL(res.headers.get('Location')!).hash.slice(1));
  }

  it('last 30 days, as the redirect says', async () => {
    const env = devEnv();
    const fragment = await implicitToken(env);
    expect(fragment.get('expires_in')).toBe(String(IMPLICIT_TOKEN_TTL_SECONDS));
    const [issued] = rows(env, 'SELECT expires_at FROM oauth_tokens');
    const now = Math.floor(Date.now() / 1000);
    expect(issued.expires_at - now).toBeGreaterThan(IMPLICIT_TOKEN_TTL_SECONDS - 60);
    expect(issued.expires_at - now).toBeLessThanOrEqual(IMPLICIT_TOKEN_TTL_SECONDS);
  });

  it('slide forward on use, so an app in use never re-authorizes', async () => {
    const env = devEnv();
    const token = (await implicitToken(env)).get('access_token')!;
    const now = Math.floor(Date.now() / 1000);
    env.DB.sqlite.prepare('UPDATE oauth_tokens SET expires_at = ?').run(now + 3600);

    expect((await putFile(env, token)).status).toBeOneOf([200, 201]);
    const [renewed] = rows(env, 'SELECT expires_at FROM oauth_tokens');
    expect(renewed.expires_at - now).toBeGreaterThan(IMPLICIT_TOKEN_TTL_SECONDS - 60);
  });

  it('are renewed at most once a day', async () => {
    const env = devEnv();
    const token = (await implicitToken(env)).get('access_token')!;
    const recent = Math.floor(Date.now() / 1000) + IMPLICIT_TOKEN_TTL_SECONDS - 3600;
    env.DB.sqlite.prepare('UPDATE oauth_tokens SET expires_at = ?').run(recent);

    expect((await putFile(env, token)).status).toBeOneOf([200, 201]);
    expect(rows(env, 'SELECT expires_at FROM oauth_tokens')[0].expires_at).toBe(recent);
  });

  it('stay dead once expired', async () => {
    const env = devEnv();
    const token = (await implicitToken(env)).get('access_token')!;
    env.DB.sqlite.prepare('UPDATE oauth_tokens SET expires_at = ?').run(Math.floor(Date.now() / 1000) - 1);
    expect((await putFile(env, token)).status).toBe(401);
  });

  it('do not extend code-flow access tokens', async () => {
    const env = devEnv();
    const { access_token } = await (await redeem(env, await authorizationCode(env))).json() as any;
    const [before] = rows(env, 'SELECT expires_at FROM oauth_tokens');
    expect((await putFile(env, access_token)).status).toBeOneOf([200, 201]);
    expect(rows(env, 'SELECT expires_at FROM oauth_tokens')[0].expires_at).toBe(before.expires_at);
  });
});

describe('expired rows', () => {
  it('are purged when tokens are issued; live ones stay', async () => {
    const env = devEnv();
    const live = await (await redeem(env, await authorizationCode(env))).json() as any;
    const past = Math.floor(Date.now() / 1000) - 1;
    const raw = env.DB.sqlite;
    raw.prepare("INSERT INTO oauth_tokens (id, access_token_hash, expires_at, scopes, user_id, client_id) VALUES ('implicit-expired', 'h1', ?, 'documents:rw', 'alice', ?)")
      .run(past, REQUEST.client_id);
    raw.prepare("INSERT INTO oauth_tokens (id, access_token_hash, refresh_token_hash, expires_at, refresh_expires_at, scopes, user_id, client_id) VALUES ('refresh-expired', 'h2', 'r2', ?, ?, 'documents:rw', 'alice', ?)")
      .run(past, past, REQUEST.client_id);
    raw.prepare("INSERT INTO oauth_tokens (id, access_token_hash, refresh_token_hash, expires_at, refresh_expires_at, scopes, user_id, client_id) VALUES ('refresh-live', 'h3', 'r3', ?, ?, 'documents:rw', 'alice', ?)")
      .run(past, past + 86400, REQUEST.client_id);
    raw.prepare("INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, scope, code_challenge, expires_at) VALUES ('c-expired', ?, 'alice', ?, 'documents:rw', 'x', ?)")
      .run(REQUEST.client_id, REQUEST.redirect_uri, past);

    await approve(env, { response_type: 'token', code_challenge: '', code_challenge_method: '' });

    const ids = rows(env, 'SELECT id, access_token_hash FROM oauth_tokens').map(row => row.id);
    expect(ids).not.toContain('implicit-expired');
    expect(ids).not.toContain('refresh-expired');
    expect(ids).toContain('refresh-live');
    expect(ids).toHaveLength(3);
    expect(rows(env, "SELECT * FROM oauth_codes WHERE code_hash = 'c-expired'")).toHaveLength(0);
    expect((await putFile(env, live.access_token)).status).toBeOneOf([200, 201]);
  });
});
