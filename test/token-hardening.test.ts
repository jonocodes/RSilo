import { describe, it, expect } from 'vitest';
import { createServer } from '../src/index';
import { createSqliteD1 } from '../src/services/db/sqlite';
import { PKCE, tokenHash as sha256 } from './helpers/tokens';
import { generateToken, hashToken } from '../src/services/auth';

// Hardening borrowed from cloudflare/workers-oauth-provider (see
// docs/research/workers-oauth-provider.md): secrets are stored only as hashes,
// a refresh token survives one lost response, and generated secrets are
// unbiased base64url. Required PKCE is covered in test/pkce.test.ts.

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

function devEnv() {
  return { STORAGE: new MemoryStorage() as any, DB: createSqliteD1() } as any;
}

function rows(env: any, sql: string): any[] {
  return env.DB.sqlite.prepare(sql).all() as any[];
}

async function approve(env: any, params: Record<string, string> = {}) {
  return app.request(CONSENT_URL, {
    method: 'POST',
    headers: SAME_ORIGIN,
    body: new URLSearchParams({ ...REQUEST, action: 'approve', ...params }).toString(),
  }, env);
}

async function authorizationCode(env: any): Promise<string> {
  const res = await approve(env);
  expect(res.status).toBe(302);
  return new URL(res.headers.get('Location')!).searchParams.get('code')!;
}

function exchange(env: any, params: Record<string, string>) {
  return app.request(TOKEN_URL, { method: 'POST', headers: FORM, body: new URLSearchParams(params).toString() }, env);
}

function redeem(env: any, code: string) {
  return exchange(env, { grant_type: 'authorization_code', code, redirect_uri: REQUEST.redirect_uri, code_verifier: PKCE.verifier });
}

function refresh(env: any, refreshToken: string) {
  return exchange(env, { grant_type: 'refresh_token', refresh_token: refreshToken });
}

function putFile(env: any, token: string) {
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
  async function tokens(env: any) {
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

  it('accepts the previous refresh token again if the client lost the response', async () => {
    const env = devEnv();
    const first = await tokens(env);
    const lost = await (await refresh(env, first.refresh_token)).json() as any;

    const retry = await refresh(env, first.refresh_token);
    expect(retry.status).toBe(200);
    const second = await retry.json() as any;
    expect((await putFile(env, second.access_token)).status).toBeOneOf([200, 201]);
    // The response that never arrived is superseded.
    expect((await refresh(env, lost.refresh_token)).status).toBe(400);
  });

  it('retires the previous refresh token once its replacement is used', async () => {
    const env = devEnv();
    const first = await tokens(env);
    const second = await (await refresh(env, first.refresh_token)).json() as any;
    expect((await refresh(env, second.refresh_token)).status).toBe(200);
    expect((await refresh(env, first.refresh_token)).status).toBe(400);
  });
});
