import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createServer } from '../src/index';
import { createSqliteD1 } from '../src/services/db/sqlite';
import { PKCE } from './helpers/tokens';
import { MemoryStorage } from './helpers/memory-storage';

// Security events are single-line JSON on console.log (services/security-log.ts).
// Dev-mode requests to localhost are signed in as the Owner (dev identity).

const app = createServer({});
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const SAME_ORIGIN = { ...FORM, 'Sec-Fetch-Site': 'same-origin' };
const IP = '203.0.113.50';
const CLIENT = 'https://app.example';
const REDIRECT_URI = 'https://app.example/cb';

let log: MockInstance<typeof console.log>;

beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  log.mockRestore();
});

const lines = () => log.mock.calls.map((args) => args.map(String).join(' '));
const events = () => lines().map((line) => JSON.parse(line) as Record<string, unknown>);

function devEnv(extra: Record<string, unknown> = {}) {
  return { STORAGE: new MemoryStorage(), DB: createSqliteD1(), ...extra };
}

function consent(env: unknown, params: Record<string, string>) {
  const body = new URLSearchParams({
    client_id: CLIENT,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'documents:rw',
    code_challenge: PKCE.challenge,
    code_challenge_method: 'S256',
    action: 'approve',
    ...params,
  });
  return app.request('http://localhost/account/oauth/authorize', { method: 'POST', headers: { ...SAME_ORIGIN, 'CF-Connecting-IP': IP }, body: body.toString() }, env);
}

async function approveCode(env: unknown): Promise<string> {
  const res = await consent(env, {});
  return new URL(res.headers.get('Location')!).searchParams.get('code')!;
}

async function token(env: unknown, body: Record<string, string>) {
  const res = await app.request('http://localhost/oauth/alice/token', {
    method: 'POST',
    headers: { ...FORM, 'CF-Connecting-IP': IP },
    body: new URLSearchParams(body).toString(),
  }, env);
  return { status: res.status, json: await res.json() as Record<string, string> };
}

function storage(env: unknown, path: string, init: RequestInit = {}) {
  return app.request(`http://localhost/storage/alice/${path}`, { ...init, headers: { 'CF-Connecting-IP': IP, ...init.headers } }, env);
}

describe('security event logging', () => {
  it('logs a refused storage token as one JSON line, without the token', async () => {
    const res = await storage(devEnv(), 'documents/', { headers: { Authorization: 'Bearer not-a-real-token-1234' } });
    expect(res.status).toBe(401);
    expect(lines()).toHaveLength(1);
    expect(events()[0]).toEqual({
      event: 'storage.auth_denied',
      ip: IP,
      method: 'GET',
      path: '/storage/alice/documents/',
      status: 401,
      reason: 'invalid_token',
    });
    expect(lines()[0]).not.toContain('not-a-real-token-1234');
  });

  it('logs which limiter refused a request', async () => {
    const env = devEnv({ TOKEN_LIMITER: { limit: async () => ({ success: false }) } });
    const res = await app.request('http://localhost/oauth/alice/token', { method: 'POST', headers: { 'CF-Connecting-IP': IP } }, env);
    expect(res.status).toBe(429);
    expect(events()).toEqual([expect.objectContaining({ event: 'rate_limit.exceeded', limiter: 'TOKEN_LIMITER', ip: IP, path: '/oauth/alice/token' })]);
  });

  it('logs a non-Owner identity turned away from /account', async () => {
    const res = await app.request('http://localhost/account', {}, devEnv({ RSILO_DEV_EMAIL: 'intruder@example.com' }));
    expect(res.status).toBe(403);
    expect(events()).toEqual([expect.objectContaining({ event: 'account.owner_rejected', email: 'intruder@example.com', path: '/account' })]);
  });

  it('stays quiet on successful storage requests', async () => {
    const env = devEnv();
    const code = await approveCode(env);
    const { json } = await token(env, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: PKCE.verifier });
    log.mockClear();
    const auth = { Authorization: `Bearer ${json.access_token}` };
    expect((await storage(env, 'documents/a.txt', { method: 'PUT', headers: { ...auth, 'Content-Type': 'text/plain' }, body: 'hi' })).status).toBe(201);
    expect((await storage(env, 'documents/a.txt', { headers: auth })).status).toBe(200);
    expect((await storage(env, 'documents/', { headers: auth })).status).toBe(200);
    expect(lines()).toEqual([]);
  });

  it('logs a whole OAuth flow, and no logged line holds a secret or document contents', async () => {
    const env = devEnv();
    const secrets: string[] = [PKCE.verifier];

    // A code redeemed with the wrong verifier is spent: both attempts fail.
    const spent = await approveCode(env);
    const wrongVerifier = 'wrong-verifier-wrong-verifier-wrong-verifier-0';
    secrets.push(spent, wrongVerifier);
    expect((await token(env, { grant_type: 'authorization_code', code: spent, redirect_uri: REDIRECT_URI, code_verifier: wrongVerifier })).json.error).toBe('invalid_grant');
    expect((await token(env, { grant_type: 'authorization_code', code: spent, redirect_uri: REDIRECT_URI, code_verifier: PKCE.verifier })).json.error).toBe('invalid_grant');

    const code = await approveCode(env);
    const issued = (await token(env, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: PKCE.verifier })).json;
    const refreshed = (await token(env, { grant_type: 'refresh_token', refresh_token: issued.refresh_token })).json;
    expect((await token(env, { grant_type: 'refresh_token', refresh_token: issued.refresh_token })).json.error).toBe('invalid_grant');
    secrets.push(code, issued.access_token, issued.refresh_token, refreshed.access_token, refreshed.refresh_token);

    const auth = { Authorization: `Bearer ${refreshed.access_token}` };
    const contents = 'top secret document body';
    secrets.push(contents);
    expect((await storage(env, 'documents/note.txt', { method: 'PUT', headers: { ...auth, 'Content-Type': 'text/plain' }, body: contents })).status).toBe(201);
    expect((await storage(env, 'pictures/', { headers: auth })).status).toBe(403);

    const implicit = await consent(env, { response_type: 'token' });
    const implicitToken = new URLSearchParams(new URL(implicit.headers.get('Location')!).hash.slice(1)).get('access_token')!;
    secrets.push(implicitToken);
    await consent(env, { action: 'deny' });

    const revoke = await app.request('http://localhost/account/apps/revoke', {
      method: 'POST',
      headers: { ...SAME_ORIGIN, 'CF-Connecting-IP': IP },
      body: new URLSearchParams({ client_id: CLIENT }).toString(),
    }, env);
    expect(revoke.status).toBe(302);

    const decision = { client_id: CLIENT, scope: 'documents:rw' };
    expect(events().map(({ ip: _ip, method: _method, path: _path, ...rest }) => rest)).toEqual([
      { event: 'oauth.consent_approved', ...decision, response_type: 'code' },
      { event: 'oauth.invalid_grant', grant_type: 'authorization_code', reason: 'pkce_mismatch', client_id: CLIENT },
      { event: 'oauth.invalid_grant', grant_type: 'authorization_code', reason: 'invalid_code', client_id: null },
      { event: 'oauth.consent_approved', ...decision, response_type: 'code' },
      { event: 'oauth.token_issued', grant_type: 'authorization_code', ...decision },
      { event: 'oauth.token_refreshed', ...decision },
      { event: 'oauth.invalid_grant', grant_type: 'refresh_token', reason: 'invalid_refresh_token', client_id: null },
      { event: 'storage.auth_denied', status: 403, reason: 'insufficient_scope', required_scope: 'pictures:r' },
      { event: 'oauth.consent_approved', ...decision, response_type: 'token' },
      { event: 'oauth.consent_denied', ...decision, response_type: 'code' },
      { event: 'account.app_revoked', client_id: CLIENT },
    ]);
    expect(events().every((e) => e.ip === IP)).toBe(true);

    for (const line of lines()) {
      expect(line).not.toContain('Bearer');
      for (const secret of secrets) expect(line).not.toContain(secret);
    }
  });
});
