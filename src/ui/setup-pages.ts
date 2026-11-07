import { accessTokenUrl, type AccessResult } from '../services/cloudflare-access';
import type { SetupState } from '../services/identity';

// Pages shown instead of /account when the Instance is not ready for the Owner,
// or the signed-in identity is not the Owner. They reveal only config names,
// the caller's own email and (to the Owner only) stored usernames; never the
// configured OWNER_EMAIL or Account data.

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — RSilo</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #222; margin: 0; }
    .box { max-width: 640px; margin: 60px auto; background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); line-height: 1.5; }
    h1 { font-size: 1.3rem; margin-top: 0; }
    h2 { font-size: 1.05rem; margin-top: 1.5rem; }
    li { margin: 0.35rem 0; }
    code { background: #f0f0f0; padding: 0.1rem 0.35rem; border-radius: 4px; }
    pre.copy { background: #f0f0f0; padding: 0.6rem 0.9rem; border-radius: 4px; user-select: all; overflow-x: auto; }
    pre.copy code { background: none; padding: 0; }
    form.access-token { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 1rem 0 1.5rem; }
    form.access-token input { flex: 1; min-width: 16rem; padding: 0.45rem 0.6rem; font: inherit; border: 1px solid #ccc; border-radius: 4px; }
    form.access-token button { padding: 0.45rem 1rem; font: inherit; border: 0; border-radius: 4px; background: #f38020; color: white; cursor: pointer; }
    .problems { background: #fff5f5; color: #a12; padding: 0.75rem 1rem 0.75rem 2rem; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="box">
${body}
  </div>
</body>
</html>`;
}

/**
 * The Worker's name, from a `<worker>.<subdomain>.workers.dev` host; null for
 * any other host (a custom domain does not reveal it).
 */
export function workerNameFromHost(host: string): string | null {
  const hostname = host.replace(/:\d+$/, '').toLowerCase();
  if (!hostname.endsWith('.workers.dev')) return null;
  const labels = hostname.split('.');
  return labels.length >= 4 ? labels[0] : null;
}

function workerLabel(host: string): string {
  const name = workerNameFromHost(host);
  return name ? escapeHtml(name) : 'your Worker';
}

const VARIABLES = 'Settings → Variables and Secrets';

/** Dashboard click path to add a plain-text Worker variable (HTML). */
export function addVariablePath(host: string, name: string, value: string): string {
  return `<strong>Workers &amp; Pages → ${workerLabel(host)} → ${VARIABLES} → Add → Type: Text, `
    + `Variable name: ${escapeHtml(name)}, Value: ${value} → Deploy</strong>`;
}

/** Dashboard click path to edit an existing Worker variable (HTML). */
export function editVariablePath(host: string, name: string): string {
  return `<strong>Workers &amp; Pages → ${workerLabel(host)} → ${VARIABLES} → ${escapeHtml(name)} → Edit → Deploy</strong>`;
}

export const ACCESS_POLICY_PATH = '<strong>Zero Trust → Access → Applications → RSilo app → Policies</strong>';

/**
 * The two places a new sign-in email must go, as an HTML list. Shared by the
 * 403 page and the dashboard's "Change your sign-in email" help.
 */
export function changeSignInEmailSteps(host: string): string {
  return `<ol>
      <li>In the Cloudflare dashboard, change <code>OWNER_EMAIL</code> to the new email:
        ${editVariablePath(host, 'OWNER_EMAIL')}.
        If you set up from the command line, run <code>bun run setup --owner-email=…</code> instead:
        your <code>wrangler.prod.toml</code> would put the old email back on the next <code>bun run deploy</code>.
        Given its Access API token, that re-run does the next step too.</li>
      <li>Add the new email to the Access application's <strong>Allow</strong> policy:
        ${ACCESS_POLICY_PATH}. Otherwise Cloudflare Access will not let the new email through at all.</li>
    </ol>`;
}

function configProblemsSection(problems: string[], host: string): string {
  if (!problems.length) return '';
  return `<p>These settings are invalid. Fix them in the Worker's settings in the Cloudflare dashboard
      (<strong>Workers &amp; Pages → ${workerLabel(host)} → ${VARIABLES}</strong>), or delete them to use the defaults:</p>
    <ul class="problems">${problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`;
}

function ownerEmailSection(setup: SetupState, host: string): string {
  if (!setup.ownerEmail) return '';
  const { missing } = setup.ownerEmail;
  const what = missing
    ? '<p><code>OWNER_EMAIL</code> is not set. It is the one email allowed into your account area, so the account area stays closed until it is set.</p>'
    : `<p>${escapeHtml(setup.ownerEmail.problem)}. The value set now is not a valid email address, so the account area stays closed until it is fixed.</p>`;
  const who = setup.accessEmail
    ? `<p>You're signed in through Cloudflare Access as <strong>${escapeHtml(setup.accessEmail)}</strong>.
      Set <code>OWNER_EMAIL</code> to exactly that email:</p>
    <pre class="copy"><code>${escapeHtml(setup.accessEmail)}</code></pre>`
    : '<p>Set <code>OWNER_EMAIL</code> to the email you sign in with through Cloudflare Access.</p>';
  const path = missing
    ? addVariablePath(host, 'OWNER_EMAIL', 'your email')
    : editVariablePath(host, 'OWNER_EMAIL');
  return `<h2>Set your sign-in email (OWNER_EMAIL)</h2>
    ${what}
    ${who}
    <p>In the Cloudflare dashboard: ${path}.</p>
    <p>Apps already connected to your storage keep syncing meanwhile; only this account area waits for it.</p>`;
}

/**
 * Lets RSilo create the Access app itself (POST /account/setup-access,
 * routes/access-setup.ts). Offered only when SetupState.canSetUpAccess: the
 * app's Allow policy is OWNER_EMAIL, and it protects the public host.
 */
function automaticAccessForm(): string {
  return `<p>RSilo can set it up for you with a Cloudflare API token that may edit Access:</p>
    <ol>
      <li><a href="${escapeHtml(accessTokenUrl())}" target="_blank" rel="noopener">Open the API token form</a>,
        already filled in. Under <strong>Account Resources</strong>, pick the account this Worker is in.</li>
      <li>Click <strong>Continue to summary → Create Token</strong>, and copy the token.</li>
      <li>Paste it here. It is used once, to create the Access application, and never stored.</li>
    </ol>
    <form method="post" action="/account/setup-access" class="access-token">
      <input type="password" name="token" autocomplete="off" required placeholder="Cloudflare API token" aria-label="Cloudflare API token">
      <button type="submit">Set up Access</button>
    </form>
    <p>Or set it up yourself in the Cloudflare dashboard:</p>`;
}

function accessSection(host: string, offerAutomatic: boolean): string {
  return `<h2>Turn on Cloudflare Access</h2>
    <p>Your account area is protected by Cloudflare Access, which signs you in.${offerAutomatic ? '' : ' To turn it on:'}</p>
    ${offerAutomatic ? automaticAccessForm() : ''}
    <ol>
      <li>In the Cloudflare dashboard, open <strong>Zero Trust</strong> (the free plan is enough).</li>
      <li>Go to <strong>Access → Applications</strong> and add a <strong>Self-hosted</strong> application named <strong>RSilo</strong>.</li>
      <li>Set the domain to <code>${escapeHtml(host)}</code> (your <code>&lt;worker&gt;.&lt;subdomain&gt;.workers.dev</code> hostname) and the path to <code>account</code>.</li>
      <li>Add an <strong>Allow</strong> policy that includes exactly your email address, the same one set as <code>OWNER_EMAIL</code>.</li>
      <li>Pick a sign-in method; a one-time PIN sent to your email works.</li>
    </ol>
    <p>Do not use the Worker-level "protect this Worker" option: it would also block apps from reaching your storage.</p>`;
}

/**
 * "Finish setup": OWNER_EMAIL is missing or invalid, another setting is
 * invalid, or Cloudflare Access is not in front of /account yet. `host` is the
 * request host, used for the Access application's domain and the Worker name.
 */
export function finishSetupPage(setup: SetupState, host: string): string {
  return page('Finish setup', `
    <h1>Finish setting up RSilo</h1>
    ${configProblemsSection(setup.configProblems, host)}
    ${ownerEmailSection(setup, host)}
    ${setup.accessMissing ? accessSection(host, setup.canSetUpAccess) : ''}
    <p>Then reload this page.</p>`);
}

/** How the finish-setup page's "Set up Access" form went (routes/access-setup.ts). */
export type AccessSetupOutcome =
  | AccessResult
  | { status: 'no-token' | 'refused' }
  /** The token reaches `count` Cloudflare accounts, not exactly one. */
  | { status: 'not-one-account'; count: number }
  | { status: 'error'; detail: string };

const TRY_AGAIN = '<p><a href="/account">Back to the setup page</a> to try again, or to set Access up by hand.</p>';

/** The answer to the "Set up Access" form. Never shows the token or OWNER_EMAIL. */
export function accessSetupPage(outcome: AccessSetupOutcome, host: string): string {
  const target = `<code>${escapeHtml(host)}/account</code>`;
  switch (outcome.status) {
    case 'created':
    case 'updated':
    case 'unchanged': {
      const pin = outcome.status === 'created' && outcome.addedOneTimePin
        ? `<p>RSilo also added the <strong>One-time PIN</strong> login method to your Zero Trust organization.
      Your other Access applications that allow every login method offer it too; their policies still decide who may sign in.</p>`
        : '';
      return page('Access is on', `
    <h1>Cloudflare Access is on</h1>
    <p>Cloudflare Access now protects ${target}. Only the email set as <code>OWNER_EMAIL</code> may sign in,
      with a one-time PIN sent to it.</p>
    ${pin}
    <p>It can take a minute to take effect. Then <a href="/account">open your account area</a> and sign in.</p>
    <p>To sign in less often (24 hours by default), raise the session duration in the Zero Trust dashboard:
      <strong>Access → Applications → RSilo → Edit → Session Duration</strong>.</p>`);
    }
    case 'shared-policy':
      return page('Check your Access policy', `
    <h1>Check your Access policy</h1>
    <p>An Access application for ${target} already exists. It lets people in through the reusable policy
      <strong>${escapeHtml(outcome.policyName)}</strong>, which other applications use too, so RSilo left it alone.</p>
    <p>Make sure it includes the email set as <code>OWNER_EMAIL</code>:
      <strong>Zero Trust → Access → Policies → ${escapeHtml(outcome.policyName)}</strong>.
      Then <a href="/account">open your account area</a>.</p>`);
    case 'no-zero-trust':
      return page('Set up Zero Trust first', `
    <h1>Set up Cloudflare Zero Trust first</h1>
    <p>Access is part of Cloudflare Zero Trust, which this Cloudflare account has not set up yet.</p>
    <p>Open <a href="https://one.dash.cloudflare.com/" target="_blank" rel="noopener">one.dash.cloudflare.com</a>,
      pick a team name and the <strong>Free</strong> plan. Then <a href="/account">go back to the setup page</a>
      and submit the token again.</p>`);
    case 'no-token':
      return page('Paste the token', `<h1>Paste the API token first</h1>${TRY_AGAIN}`);
    case 'refused':
      return page('Token refused', `
    <h1>Cloudflare refused the token</h1>
    <p>It needs <strong>Access: Apps and Policies → Edit</strong> and
      <strong>Access: Organizations, Identity Providers, and Groups → Edit</strong>.
      The link on the setup page fills both in.</p>${TRY_AGAIN}`);
    case 'not-one-account':
      return page('Pick one account', `
    <h1>The token must reach exactly one Cloudflare account</h1>
    <p>It reaches ${outcome.count === 0 ? 'none' : outcome.count}, so RSilo cannot tell which one this Worker is in.
      Create the token again and, under <strong>Account Resources</strong>, include only the account this Worker is in.</p>${TRY_AGAIN}`);
    case 'error':
      return page('Could not set up Access', `
    <h1>Could not set up Access</h1>
    <p>Cloudflare answered: <code>${escapeHtml(outcome.detail)}</code></p>${TRY_AGAIN}`);
  }
}

/** 403 for a signed-in identity that is not OWNER_EMAIL. Never shows OWNER_EMAIL itself. */
export function forbiddenPage(email: string | null, host: string): string {
  const who = email
    ? `You are signed in as <strong>${escapeHtml(email)}</strong>, which is not the owner of this RSilo.`
    : 'Your sign-in did not include an email address, so RSilo cannot tell whether you are its owner.';
  return page('Not allowed', `
    <h1>Not allowed</h1>
    <p>${who}</p>
    <h2>Changed the email you sign in with?</h2>
    <p>If you are the owner, update it in two places in the Cloudflare dashboard:</p>
    ${changeSignInEmailSteps(host)}
    <p><a href="/cdn-cgi/access/logout">Sign out</a> to try a different email.</p>`);
}

export interface UsernameMismatch {
  /** The resolved ACCOUNT_USERNAME (the default "me" when unset). */
  configured: string;
  /** Usernames already in the users table. Shown only on this Owner-gated page. */
  stored: string[];
  /** The request host, for the Worker name in the click path. */
  host: string;
}

/** The Account row cannot be created (ADR-0002 username mismatch). Owner-gated. */
export function usernameMismatchPage(mismatch: UsernameMismatch): string {
  const { configured, stored, host } = mismatch;
  const storedList = stored.map((u) => `<code>${escapeHtml(u)}</code>`).join(', ');
  const suggestion = stored.length === 1 ? escapeHtml(stored[0]) : 'the stored username';
  return page('Finish setup', `
    <h1>Finish setting up RSilo</h1>
    <p><strong>Username mismatch:</strong> this RSilo serves the account <code>${escapeHtml(configured)}</code>
      (<code>ACCOUNT_USERNAME</code>, which defaults to <code>me</code> when unset), but its database already holds
      ${stored.length === 1 ? 'the account' : 'the accounts'} ${storedList}.</p>
    <p>To keep using your existing storage, set <code>ACCOUNT_USERNAME</code> to ${stored.length === 1 ? `<code>${suggestion}</code>` : 'one of those usernames'}.
      In the Cloudflare dashboard: ${addVariablePath(host, 'ACCOUNT_USERNAME', suggestion)}.
      If <code>ACCOUNT_USERNAME</code> is already listed there, use ${editVariablePath(host, 'ACCOUNT_USERNAME')} instead.</p>
    <p>Storage is refused until this is fixed, so no data is written under the wrong account.</p>
    <p>Then reload this page.</p>`);
}
