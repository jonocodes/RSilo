// ensureAccessApp (src/scripts/cloudflare-access.ts) against an in-memory
// Cloudflare API: the Access app `bun run setup` creates, finds again on a
// re-run, and brings back in line with OWNER_EMAIL.
import { describe, expect, it } from 'vitest';
import { CloudflareApiError, cloudflareApi, ensureAccessApp } from '../src/scripts/cloudflare-access';
import { emailPolicy, FAKE_ACCOUNT_ID, FAKE_API_BASE, FAKE_TOKEN, fakeCloudflareApi, manualApp } from './helpers/fake-cloudflare-api';

const HOST = 'rsilo.my-sub.workers.dev';

function client(fake: ReturnType<typeof fakeCloudflareApi>, token = FAKE_TOKEN) {
  return cloudflareApi({ token, accountId: FAKE_ACCOUNT_ID, baseUrl: FAKE_API_BASE, fetch: fake.fetch });
}

describe('ensureAccessApp', () => {
  it('creates a self-hosted app for <host>/account that lets only OWNER_EMAIL in by one-time PIN', async () => {
    const fake = fakeCloudflareApi();
    const result = await ensureAccessApp(client(fake), { host: HOST, ownerEmail: 'me@example.com' });

    expect(fake.state.apps).toHaveLength(1);
    expect(result).toEqual({ status: 'created', appId: fake.state.apps[0].id });
    expect(fake.state.apps[0]).toMatchObject({
      name: 'RSilo',
      type: 'self_hosted',
      domain: 'rsilo.my-sub.workers.dev/account',
      destinations: [{ type: 'public', uri: 'rsilo.my-sub.workers.dev/account' }],
      allowed_idps: ['otp-idp'],
      auto_redirect_to_identity: true,
      policies: [{ decision: 'allow', include: [{ email: { email: 'me@example.com' } }] }],
    });
  });

  it('on a re-run finds the app by hostname and path and changes nothing', async () => {
    const fake = fakeCloudflareApi();
    await ensureAccessApp(client(fake), { host: HOST, ownerEmail: 'me@example.com' });
    fake.requests.length = 0;

    // Hostnames are case-insensitive; the email match is too (as in RSilo itself).
    const again = await ensureAccessApp(client(fake), { host: 'RSilo.My-Sub.workers.dev', ownerEmail: 'Me@Example.com' });
    expect(again).toEqual({ status: 'unchanged', appId: fake.state.apps[0].id });
    expect(fake.state.apps).toHaveLength(1);
    expect(fake.writes()).toEqual([]);
  });

  it('points the Allow policy of an existing app at a changed OWNER_EMAIL, keeping its other settings', async () => {
    const app = manualApp(HOST, [emailPolicy('old@example.com', 'Allow me')]);
    const fake = fakeCloudflareApi({ apps: [app] });

    const result = await ensureAccessApp(client(fake), { host: HOST, ownerEmail: 'new@example.com' });
    expect(result).toEqual({ status: 'updated', appId: app.id });
    expect(fake.state.apps).toHaveLength(1);
    expect(fake.state.apps[0].policies).toEqual([
      expect.objectContaining({ id: app.policies[0].id, name: 'Allow me', decision: 'allow', include: [{ email: { email: 'new@example.com' } }] }),
    ]);
    // Login methods are left as they are, so another sign-in method (#27) survives a re-run.
    expect(fake.state.apps[0]).toMatchObject({ allowed_idps: [], auto_redirect_to_identity: false });
  });

  it('updates a reusable Allow policy that only this app uses', async () => {
    const policy = emailPolicy('old@example.com');
    const app = manualApp(HOST, [], [policy.id]);
    const fake = fakeCloudflareApi({ apps: [app], reusablePolicies: [policy] });

    expect(await ensureAccessApp(client(fake), { host: HOST, ownerEmail: 'new@example.com' })).toEqual({ status: 'updated', appId: app.id });
    expect(fake.state.reusablePolicies[0].include).toEqual([{ email: { email: 'new@example.com' } }]);
  });

  it('leaves a reusable Allow policy shared with other apps alone, and says so', async () => {
    const policy = emailPolicy('old@example.com', 'Family');
    const fake = fakeCloudflareApi({
      apps: [manualApp(HOST, [], [policy.id]), manualApp('wiki.example.com', [], [policy.id])],
      reusablePolicies: [policy],
    });

    const result = await ensureAccessApp(client(fake), { host: HOST, ownerEmail: 'new@example.com' });
    expect(result).toEqual({ status: 'shared-policy', appId: fake.state.apps[0].id, policyName: 'Family' });
    expect(fake.writes()).toEqual([]);
  });

  it('on an account without Zero Trust, says so and changes nothing', async () => {
    const fake = fakeCloudflareApi({ organization: null });
    const result = await ensureAccessApp(client(fake), { host: HOST, ownerEmail: 'me@example.com' });

    expect(result).toEqual({ status: 'no-zero-trust', detail: 'GET /access/organizations: HTTP 404, access.api.error.not_found (9999)' });
    expect(fake.writes()).toEqual([]);
  });

  it('throws a refused CloudflareApiError when the token may not manage Access', async () => {
    const fake = fakeCloudflareApi();
    const err = await ensureAccessApp(client(fake, 'wrangler-only-token'), { host: HOST, ownerEmail: 'me@example.com' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CloudflareApiError);
    expect(err).toMatchObject({ refused: true });
    expect((err as Error).message).toContain('Authentication error (10000)');
  });

  it('adds the one-time PIN login method when the account does not have it yet', async () => {
    const fake = fakeCloudflareApi({ identityProviders: [{ id: 'github-idp', name: 'GitHub', type: 'github' }] });
    await ensureAccessApp(client(fake), { host: HOST, ownerEmail: 'me@example.com' });

    const pin = fake.state.identityProviders.find((idp) => idp.type === 'onetimepin');
    expect(pin).toBeDefined();
    expect(fake.state.apps[0].allowed_idps).toEqual([pin!.id]);
  });

  it('adds an Allow policy to an existing app that has none, instead of creating a second app', async () => {
    const deny = { ...emailPolicy('blocked@example.com', 'Block'), decision: 'deny' };
    const app = manualApp(HOST, [deny]);
    const fake = fakeCloudflareApi({ apps: [app] });

    expect(await ensureAccessApp(client(fake), { host: HOST, ownerEmail: 'me@example.com' })).toEqual({ status: 'updated', appId: app.id });
    expect(fake.state.apps).toHaveLength(1);
    expect(fake.state.apps[0].policies).toEqual([
      expect.objectContaining({ name: 'Block', decision: 'deny' }),
      expect.objectContaining({ name: 'RSilo owner', decision: 'allow', include: [{ email: { email: 'me@example.com' } }] }),
    ]);
  });

  it('finds the app on a later page of a long app list', async () => {
    const decoys = Array.from({ length: 60 }, (_, i) => manualApp(`app-${i}.example.com`, [emailPolicy('x@example.com')]));
    const app = manualApp(HOST, [emailPolicy('me@example.com')]);
    const fake = fakeCloudflareApi({ apps: [...decoys, app] });

    expect(await ensureAccessApp(client(fake), { host: HOST, ownerEmail: 'me@example.com' })).toEqual({ status: 'unchanged', appId: app.id });
    expect(fake.state.apps).toHaveLength(61);
  });

  it('keeps the Allow policy\'s other settings when it changes the email', async () => {
    const policy = { ...emailPolicy('old@example.com'), session_duration: '730h' };
    const fake = fakeCloudflareApi({ apps: [manualApp(HOST, [policy])] });

    await ensureAccessApp(client(fake), { host: HOST, ownerEmail: 'new@example.com' });
    expect(fake.state.apps[0].policies[0]).toMatchObject({ session_duration: '730h', include: [{ email: { email: 'new@example.com' } }] });
  });

  it('treats a Cloudflare outage as an error, not as a missing Zero Trust organization', async () => {
    const fake = fakeCloudflareApi();
    const flaky = (input: string, init: RequestInit) =>
      input.endsWith('/access/organizations')
        ? Promise.resolve(Response.json({ success: false, errors: [{ code: 10001, message: 'Service unavailable' }] }, { status: 503 }))
        : fake.fetch(input, init);
    const api = cloudflareApi({ token: FAKE_TOKEN, accountId: FAKE_ACCOUNT_ID, baseUrl: FAKE_API_BASE, fetch: flaky });

    const err = await ensureAccessApp(api, { host: HOST, ownerEmail: 'me@example.com' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudflareApiError);
    expect((err as Error).message).toContain('HTTP 503');
  });
});
