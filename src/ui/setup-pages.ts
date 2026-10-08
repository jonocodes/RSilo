import { ACCESS_NOT_CONFIGURED } from '../services/identity';

// Pages shown instead of /account when the Instance is not ready for the Owner,
// or the signed-in identity is not the Owner. They reveal only config names and
// the caller's own email, never Account data.

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
    li { margin: 0.35rem 0; }
    code { background: #f0f0f0; padding: 0.1rem 0.35rem; border-radius: 4px; }
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
 * "Finish setup": a required config value is missing, or Cloudflare Access is
 * not in front of /account yet. `host` is the request host, used only to fill
 * in the Access application's domain.
 */
export function finishSetupPage(problems: string[], host: string): string {
  const configProblems = problems.filter((p) => p !== ACCESS_NOT_CONFIGURED);
  const missing = configProblems.length
    ? `<p>These settings are missing or invalid. Set them as variables in the Worker's settings in the Cloudflare dashboard:</p>
    <ul class="problems">${configProblems.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`
    : '';
  return page('Finish setup', `
    <h1>Finish setting up RSilo</h1>
    ${missing}
    <p>Your account area is protected by Cloudflare Access, which signs you in. To turn it on:</p>
    <ol>
      <li>In the Cloudflare dashboard, open <strong>Zero Trust</strong> (the free plan is enough).</li>
      <li>Go to <strong>Access → Applications</strong> and add a <strong>Self-hosted</strong> application.</li>
      <li>Set the domain to <code>${escapeHtml(host)}</code> (your <code>&lt;worker&gt;.&lt;subdomain&gt;.workers.dev</code> hostname) and the path to <code>account</code>.</li>
      <li>Add an <strong>Allow</strong> policy that includes exactly your email address, the same one set as <code>OWNER_EMAIL</code>.</li>
      <li>Pick a sign-in method; a one-time PIN sent to your email works.</li>
    </ol>
    <p>Do not use the Worker-level "protect this Worker" option: it would also block apps from reaching your storage.</p>
    <p>Then reload this page.</p>`);
}

/** 403 for a signed-in identity that is not OWNER_EMAIL. */
export function forbiddenPage(email: string | null): string {
  const who = email
    ? `You are signed in as <strong>${escapeHtml(email)}</strong>, which is not the owner of this RSilo.`
    : 'Your sign-in did not include an email address, so RSilo cannot tell whether you are its owner.';
  return page('Not allowed', `
    <h1>Not allowed</h1>
    <p>${who}</p>
    <p>If you are the owner and changed the email you sign in with, update <code>OWNER_EMAIL</code> in the Worker's settings,
      and the Allow policy of the RSilo Access application, in the Cloudflare dashboard.</p>
    <p><a href="/cdn-cgi/access/logout">Sign out</a> to try a different email.</p>`);
}

/** The Account row cannot be created (ADR-0002 username mismatch). */
export function setupMessagePage(message: string): string {
  return page('Finish setup', `
    <h1>Finish setting up RSilo</h1>
    <p>${escapeHtml(message)}</p>`);
}
