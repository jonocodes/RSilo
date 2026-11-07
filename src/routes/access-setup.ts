// POST /account/setup-access: the finish-setup page's "Set up Access" form
// (follow-up to #61). A Deploy-button Owner has no `bun run setup`, so the
// Worker creates the Access app itself from a pasted Cloudflare API token.
//
// It runs before requireOwner() because Access is not there yet, and so is
// guarded on its own:
// - It acts only when SetupState.canSetUpAccess: Access is the one thing
//   missing, and the request is on the public host the app would protect.
//   Otherwise it redirects to /account, which shows whatever applies.
// - The Allow policy is always OWNER_EMAIL from the config, never form input,
//   so whoever submits cannot let themselves in; a stranger's token can only
//   create apps in the stranger's own Cloudflare account.
// - Same-origin only, and rate-limited per IP (TOKEN_LIMITER: one token
//   submission is an attempt like a token request).
// - The token is used for this request only: never stored, logged or echoed.
import { getInstanceConfig, getOwnerEmail } from '../config';
import { CloudflareApiError, cloudflareApi, ensureAccessApp, listAccounts } from '../services/cloudflare-access';
import { isSameOriginRequest, resolveOwner } from '../services/identity';
import { enforceRateLimit } from '../services/rate-limit';
import { securityEvent, trustedClientIp } from '../services/security-log';
import { accessSetupPage, type AccessSetupOutcome } from '../ui/setup-pages';
import type { Context } from '../types';

const HTML = { 'Content-Type': 'text/html; charset=utf-8' };

export async function setupAccess(c: Context): Promise<Response> {
  const owner = await resolveOwner(c);
  const instance = getInstanceConfig(c.env, c.req.url);
  const ownerEmail = getOwnerEmail(c.env);
  const allowed = owner.status === 'not_configured' && owner.setup.canSetUpAccess;
  // The narrowing repeats what canSetUpAccess already checked.
  if (!allowed || !('config' in instance) || !('email' in ownerEmail)) return c.redirect('/account', 303);

  if (!isSameOriginRequest(c, instance.config.publicBaseUrl)) return c.text('Cross-site request refused', 403);
  const limited = await enforceRateLimit(c, { limiter: 'TOKEN_LIMITER', key: `access-setup:ip:${trustedClientIp(c)}` });
  if (limited) return limited;

  const form = await c.req.parseBody();
  const token = typeof form.token === 'string' ? form.token.trim() : '';
  const host = instance.config.publicHost;
  const answer = (status: number, outcome: AccessSetupOutcome) => {
    if (outcome.status !== 'no-token') securityEvent(c, 'account.access_setup', { result: outcome.status });
    return new Response(accessSetupPage(outcome, host), { status, headers: HTML });
  };
  if (!token) return answer(400, { status: 'no-token' });

  try {
    const accounts = await listAccounts({ token });
    if (accounts.length !== 1) return answer(400, { status: 'not-one-account', count: accounts.length });
    return answer(200, await ensureAccessApp(cloudflareApi({ token, accountId: accounts[0].id }), { host, ownerEmail: ownerEmail.email }));
  } catch (err) {
    if (err instanceof CloudflareApiError && err.refused) return answer(400, { status: 'refused' });
    return answer(502, { status: 'error', detail: err instanceof Error ? err.message : String(err) });
  }
}
