// Runs ensureAccessApp against the real Cloudflare API, so the request bodies
// are checked by Cloudflare rather than the fake in helpers/fake-cloudflare-api.
// Skipped unless RSILO_ACCESS_LIVE_TOKEN is set. It creates one Access app for
// a throwaway host under your workers.dev subdomain (no Worker needs to exist
// there), re-runs, changes the email, and deletes the app again:
//
//   RSILO_ACCESS_LIVE_TOKEN=<token with Access edit> RSILO_ACCESS_LIVE_ACCOUNT_ID=<account id> \
//   RSILO_ACCESS_LIVE_SUBDOMAIN=<subdomain>.workers.dev bun run test test/cloudflare-access-live.test.ts
import { afterAll, describe, expect, it } from 'vitest';
import { cloudflareApi, ensureAccessApp } from '../src/services/cloudflare-access';

const token = process.env.RSILO_ACCESS_LIVE_TOKEN;

interface LiveApp {
  id: string;
  domain: string;
  destinations: { type: string; uri: string }[];
  allowed_idps: string[];
  auto_redirect_to_identity: boolean;
  policies: { decision: string; include: unknown[]; reusable: boolean }[];
}

describe.skipIf(!token)('ensureAccessApp against the live Cloudflare API', () => {
  const api = cloudflareApi({ token: token!, accountId: process.env.RSILO_ACCESS_LIVE_ACCOUNT_ID ?? '' });
  const host = `rsilo-access-live-${Date.now().toString(36)}.${process.env.RSILO_ACCESS_LIVE_SUBDOMAIN ?? ''}`;
  const appIds = new Set<string>();

  afterAll(async () => {
    for (const id of appIds) await api.call('DELETE', `/access/apps/${id}`).catch(() => {});
  });

  it('creates the app for <host>/account, finds it again, and follows a changed email', async () => {
    const created = await ensureAccessApp(api, { host, ownerEmail: 'rsilo-live-a@example.com' });
    expect(created.status).toBe('created');
    if (!('appId' in created)) throw new Error('no app');
    appIds.add(created.appId);

    const app = await api.call<LiveApp>('GET', `/access/apps/${created.appId}`);
    expect(app.domain).toBe(`${host}/account`);
    expect(app.destinations).toEqual([expect.objectContaining({ type: 'public', uri: `${host}/account` })]);
    expect(app.allowed_idps).toHaveLength(1);
    expect(app.auto_redirect_to_identity).toBe(true);
    expect(app.policies).toEqual([
      expect.objectContaining({ decision: 'allow', include: [{ email: { email: 'rsilo-live-a@example.com' } }] }),
    ]);

    expect(await ensureAccessApp(api, { host, ownerEmail: 'rsilo-live-a@example.com' })).toEqual({ status: 'unchanged', appId: created.appId });
    expect(await ensureAccessApp(api, { host, ownerEmail: 'rsilo-live-b@example.com' })).toEqual({ status: 'updated', appId: created.appId });

    const updated = await api.call<LiveApp>('GET', `/access/apps/${created.appId}`);
    expect(updated.policies).toEqual([
      expect.objectContaining({ decision: 'allow', include: [{ email: { email: 'rsilo-live-b@example.com' } }] }),
    ]);
  });
});
