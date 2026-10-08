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
        ${editVariablePath(host, 'OWNER_EMAIL')}.</li>
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

function accessSection(host: string): string {
  return `<h2>Turn on Cloudflare Access</h2>
    <p>Your account area is protected by Cloudflare Access, which signs you in. To turn it on:</p>
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
    ${setup.accessMissing ? accessSection(host) : ''}
    <p>Then reload this page.</p>`);
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
