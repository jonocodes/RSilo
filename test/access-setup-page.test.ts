// Setting up Cloudflare Access from the finish-setup page (follow-up to #61):
// a Deploy-button Owner pastes an API token and the Worker creates the Access
// app for its own host and OWNER_EMAIL. The Worker's outbound fetch is the
// fake Cloudflare API from helpers/fake-cloudflare-api.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../src/index';
import { createSqliteD1 } from '../src/services/db/sqlite';
import { fakeCloudflareApi, FAKE_TOKEN, type FakeCloudflareApi } from './helpers/fake-cloudflare-api';
import { PRODUCTION_INSTANCE } from './helpers/instance';
import { MemoryStorage } from './helpers/memory-storage';

const app = createServer({});
const BASE = PRODUCTION_INSTANCE.PUBLIC_BASE_URL;
const allowAll = { limit: async () => ({ success: true }) };

function productionEnv(extra: Record<string, unknown> = {}) {
  return {
    STORAGE: new MemoryStorage(),
    DB: createSqliteD1(),
    RSILO_DEV_MODE: 'false',
    TOKEN_LIMITER: allowAll,
    ...PRODUCTION_INSTANCE,
    ...extra,
  };
}

let fake: FakeCloudflareApi;

beforeEach(() => {
  fake = fakeCloudflareApi();
  vi.stubGlobal('fetch', fake.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('finish-setup page: Turn on Cloudflare Access', () => {
  it('offers to set Access up from a pasted API token, above the manual steps', async () => {
    const res = await app.request(`${BASE}/account`, {}, productionEnv());
    expect(res.status).toBe(503);
    const html = await res.text();

    expect(html).toContain('<form method="post" action="/account/setup-access" class="access-token">');
    expect(html).toMatch(/<input[^>]+type="password"[^>]+name="token"/);
    expect(html).toContain('https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=');
    expect(html.indexOf('/account/setup-access')).toBeLessThan(html.indexOf('Self-hosted'));
  });

  it('does not offer it until OWNER_EMAIL is set: the policy needs it', async () => {
    const res = await app.request(`${BASE}/account`, {}, productionEnv({ OWNER_EMAIL: undefined }));
    expect(await res.text()).not.toContain('/account/setup-access');
  });
});

describe('POST /account/setup-access', () => {
  function submit(fields: Record<string, string>, env = productionEnv(), headers: Record<string, string> = { 'Sec-Fetch-Site': 'same-origin' }) {
    return app.request(`${BASE}/account/setup-access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(fields).toString(),
    }, env);
  }

  it('creates the Access app for this host, letting in only OWNER_EMAIL, whatever the form says', async () => {
    const res = await submit({ token: FAKE_TOKEN, email: 'mallory@example.com' });
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(fake.state.apps).toHaveLength(1);
    expect(fake.state.apps[0]).toMatchObject({
      domain: 'rsilo.example/account',
      policies: [{ decision: 'allow', include: [{ email: { email: 'owner@example.com' } }] }],
    });
    expect(html).toContain('Cloudflare Access now protects <code>rsilo.example/account</code>');
    expect(html).toContain('href="/account"');
    expect(html).not.toContain(FAKE_TOKEN);
    expect(html).not.toContain('owner@example.com');
  });

  it('does nothing once Access is in front of /account: redirects to /account', async () => {
    const ctx = { waitUntil() {}, passThroughOnException() {}, access: { aud: 'a', getIdentity: async () => ({ email: 'owner@example.com' }) } };
    const res = await app.request(`${BASE}/account/setup-access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin' },
      body: `token=${FAKE_TOKEN}`,
    }, productionEnv(), ctx as never);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/account');
    expect(fake.requests).toEqual([]);
  });

  it('does nothing while OWNER_EMAIL is missing: redirects to the finish-setup page', async () => {
    const res = await submit({ token: FAKE_TOKEN }, productionEnv({ OWNER_EMAIL: undefined }));
    expect(res.status).toBe(303);
    expect(fake.requests).toEqual([]);
  });

  it('refuses a cross-site post', async () => {
    const res = await submit({ token: FAKE_TOKEN }, productionEnv(), { 'Sec-Fetch-Site': 'cross-site' });
    expect(res.status).toBe(403);
    expect(fake.requests).toEqual([]);
  });

  it('is rate-limited per IP', async () => {
    const res = await submit({ token: FAKE_TOKEN }, productionEnv({ TOKEN_LIMITER: { limit: async () => ({ success: false }) } }));
    expect(res.status).toBe(429);
    expect(fake.requests).toEqual([]);
  });

  it('asks for the token when the field is empty', async () => {
    const res = await submit({ token: '  ' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Paste the API token first');
    expect(fake.requests).toEqual([]);
  });

  it('explains a refused token without echoing it', async () => {
    const res = await submit({ token: 'not-an-access-token' });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('Cloudflare refused the token');
    expect(html).toContain('Access: Apps and Policies');
    expect(html).not.toContain('not-an-access-token');
    expect(fake.writes()).toEqual([]);
  });

  it('asks for a token scoped to one account when it reaches several', async () => {
    fake.state.otherAccounts = [{ id: 'other', name: 'Work' }];
    const res = await submit({ token: FAKE_TOKEN });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/exactly one Cloudflare account[\s\S]*It reaches 2/);
    expect(fake.writes()).toEqual([]);
  });

  it('sends an account without Zero Trust to the sign-up page first', async () => {
    fake.state.organization = null;
    const res = await submit({ token: FAKE_TOKEN });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('https://one.dash.cloudflare.com/');
    expect(html).toContain('<strong>Free</strong> plan');
    expect(fake.writes()).toEqual([]);
  });
});
