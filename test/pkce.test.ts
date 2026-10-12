import { describe, it, expect } from 'vitest';
import { createServer } from '../src/index';
import { createSqliteD1 } from './helpers/sqlite-d1';

// PKCE (RFC 7636) on the authorization code flow, S256 only. Optional: a code
// requested without a code_challenge redeems as before, but one requested with
// a challenge redeems only with the matching code_verifier.

const app = createServer({});
const CONSENT_URL = 'http://localhost/account/oauth/authorize';
const TOKEN_URL = 'http://localhost/oauth/alice/token';
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const SAME_ORIGIN = { ...FORM, 'Sec-Fetch-Site': 'same-origin' };

// RFC 7636 Appendix B.
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const REQUEST = {
  client_id: 'https://app.example',
  redirect_uri: 'https://app.example/cb',
  response_type: 'code',
  scope: 'documents:rw',
  state: 'xyz',
};
const PKCE = { code_challenge: CHALLENGE, code_challenge_method: 'S256' };

function devEnv() {
  return { DB: createSqliteD1() } as any;
}

function count(env: any, table: string): number {
  return Number((env.DB.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n);
}

async function approve(env: any, params: Record<string, string> = {}): Promise<Response> {
  const body = new URLSearchParams({ ...REQUEST, action: 'approve', ...params }).toString();
  return app.request(CONSENT_URL, { method: 'POST', headers: SAME_ORIGIN, body }, env);
}

async function codeFor(env: any, params: Record<string, string> = {}): Promise<string> {
  const res = await approve(env, params);
  expect(res.status).toBe(302);
  return new URL(res.headers.get('Location')!).searchParams.get('code')!;
}

async function exchange(env: any, code: string, params: Record<string, string> = {}, json = false): Promise<Response> {
  const fields = { grant_type: 'authorization_code', code, redirect_uri: REQUEST.redirect_uri, ...params };
  return app.request(TOKEN_URL, json
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) }
    : { method: 'POST', headers: FORM, body: new URLSearchParams(fields).toString() }, env);
}

describe('PKCE on the consent page', () => {
  it('carries code_challenge and code_challenge_method through as hidden fields', async () => {
    const qs = new URLSearchParams({ ...REQUEST, ...PKCE });
    const res = await app.request(`${CONSENT_URL}?${qs}`, {}, devEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`name="code_challenge" value="${CHALLENGE}"`);
    expect(html).toContain('name="code_challenge_method" value="S256"');
  });

  it('omits the PKCE fields when the app sends none', async () => {
    const res = await app.request(`${CONSENT_URL}?${new URLSearchParams(REQUEST)}`, {}, devEnv());
    expect(await res.text()).not.toContain('code_challenge');
  });

  const invalid: [string, Record<string, string>][] = [
    ['the plain method', { code_challenge: CHALLENGE, code_challenge_method: 'plain' }],
    ['no method (which means plain)', { code_challenge: CHALLENGE }],
    ['an unknown method', { code_challenge: CHALLENGE, code_challenge_method: 'S512' }],
    ['a method without a challenge', { code_challenge_method: 'S256' }],
    ['a challenge that is not 43 base64url characters', { code_challenge: 'too-short', code_challenge_method: 'S256' }],
    ['a challenge with invalid characters', { code_challenge: `${CHALLENGE.slice(0, 42)}=`, code_challenge_method: 'S256' }],
  ];
  for (const [name, params] of invalid) {
    it(`GET with ${name} is a 400 with no redirect`, async () => {
      const qs = new URLSearchParams({ ...REQUEST, ...params });
      const res = await app.request(`${CONSENT_URL}?${qs}`, {}, devEnv());
      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBeNull();
      expect(await res.text()).toContain('invalid_request');
    });

    it(`POST approve with ${name} is a 400 that issues nothing`, async () => {
      const env = devEnv();
      const res = await approve(env, params);
      expect(res.status).toBe(400);
      expect(count(env, 'oauth_codes')).toBe(0);
    });
  }

  it('ignores PKCE parameters on the implicit flow, which has no code to protect', async () => {
    const env = devEnv();
    const res = await approve(env, { response_type: 'token', code_challenge: 'anything', code_challenge_method: 'plain' });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('Location')!).hash).toContain('access_token=');
  });
});

describe('PKCE at the token endpoint', () => {
  it('redeems a PKCE code with the matching code_verifier (form body)', async () => {
    const env = devEnv();
    const res = await exchange(env, await codeFor(env, PKCE), { code_verifier: VERIFIER });
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.access_token).toBeTruthy();
    expect(json.refresh_token).toBeTruthy();
  });

  it('redeems a PKCE code with the matching code_verifier (JSON body)', async () => {
    const env = devEnv();
    const res = await exchange(env, await codeFor(env, PKCE), { code_verifier: VERIFIER }, true);
    expect(res.status).toBe(200);
  });

  it('refuses a PKCE code without a code_verifier', async () => {
    const env = devEnv();
    const res = await exchange(env, await codeFor(env, PKCE));
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe('invalid_grant');
    expect(count(env, 'oauth_tokens')).toBe(0);
  });

  it('refuses a PKCE code with the wrong code_verifier', async () => {
    const env = devEnv();
    const res = await exchange(env, await codeFor(env, PKCE), { code_verifier: 'x'.repeat(43) });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe('invalid_grant');
    expect(count(env, 'oauth_tokens')).toBe(0);
  });

  it('refuses the challenge itself as the verifier (plain is not supported)', async () => {
    const env = devEnv();
    const res = await exchange(env, await codeFor(env, PKCE), { code_verifier: CHALLENGE });
    expect(res.status).toBe(400);
  });

  it('refuses a malformed code_verifier', async () => {
    const env = devEnv();
    const res = await exchange(env, await codeFor(env, PKCE), { code_verifier: 'short' });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe('invalid_grant');
  });

  it('burns the code on a failed verifier, so it cannot be retried', async () => {
    const env = devEnv();
    const code = await codeFor(env, PKCE);
    expect((await exchange(env, code, { code_verifier: 'x'.repeat(43) })).status).toBe(400);
    expect(count(env, 'oauth_codes')).toBe(0);
    expect((await exchange(env, code, { code_verifier: VERIFIER })).status).toBe(400);
  });

  it('still redeems a code requested without PKCE when no code_verifier is sent', async () => {
    const env = devEnv();
    const res = await exchange(env, await codeFor(env));
    expect(res.status).toBe(200);
  });

  it('refuses a code_verifier for a code requested without PKCE (downgrade protection)', async () => {
    const env = devEnv();
    const res = await exchange(env, await codeFor(env), { code_verifier: VERIFIER });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe('invalid_grant');
  });
});

describe('PKCE discovery', () => {
  it('/oauth/:user advertises S256', async () => {
    const res = await app.request('http://localhost/oauth/alice', {}, devEnv());
    expect((await res.json() as any).code_challenge_methods_supported).toEqual(['S256']);
  });
});
