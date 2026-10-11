import { Hono } from 'hono';
import { generateToken } from '../services/auth';
import { parsePkceRequest } from '../services/pkce';
import type { Context } from '../types';

// The OAuth consent dialog (ADR-0004). Mounted by the /account router at
// /oauth, so it inherits the whole /account gate: the Owner check, the
// same-origin check on POST, the Account row, and the security headers. It is
// always for the Account; there is no username in the path.
//
// GET renders from the query string alone, so if the Access session expires
// between rendering and submitting (Access swallows the POST into its login
// redirect) the Owner can simply reload and retry.

declare module 'hono' {
  interface ContextVariableMap {
    /** Extra origin the page's CSP form-action allows (see routes/account.ts). */
    formActionOrigin: string;
  }
}

export const consentRouter = new Hono();

const DEFAULT_SCOPE = 'documents:rw';

interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  responseType: 'code' | 'token';
  scope: string;
  state: string;
  /** PKCE challenge for the code flow; null when the app sent none (or uses implicit). */
  pkce: { codeChallenge: string; method: 'S256' } | null;
  /** The client_id (= redirect_uri) origin, e.g. https://app.example */
  appOrigin: string;
  appHost: string;
}

type Parsed =
  | { ok: true; request: AuthorizationRequest }
  | { ok: false; error: string; description: string };

function httpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Validates an authorization request. Clients are not pre-registered, so the
 * client_id is the app's URL and, per protocol §10, the redirect_uri must be
 * on the same origin; anything else is refused without redirecting, since the
 * redirect target is exactly what cannot be trusted.
 */
function parseAuthorizationRequest(params: Record<string, unknown>): Parsed {
  const str = (key: string) => (typeof params[key] === 'string' ? params[key] as string : '');
  const clientId = str('client_id');
  const redirectUri = str('redirect_uri');
  const responseType = str('response_type');

  if (!clientId || !redirectUri) {
    return { ok: false, error: 'invalid_request', description: 'client_id and redirect_uri are required' };
  }
  const client = httpUrl(clientId);
  if (!client) {
    return { ok: false, error: 'invalid_request', description: 'client_id must be an http(s) URL' };
  }
  const redirect = httpUrl(redirectUri);
  if (!redirect) {
    return { ok: false, error: 'invalid_request', description: 'redirect_uri must be an http(s) URL' };
  }
  if (redirect.origin !== client.origin) {
    return { ok: false, error: 'invalid_request', description: 'redirect_uri must be on the same origin as client_id' };
  }
  if (responseType !== 'token' && responseType !== 'code') {
    return { ok: false, error: 'unsupported_response_type', description: 'response_type must be code or token' };
  }
  // PKCE protects the code exchange, so the implicit flow ignores it.
  let pkce: AuthorizationRequest['pkce'] = null;
  if (responseType === 'code') {
    const parsed = parsePkceRequest(str('code_challenge'), str('code_challenge_method'));
    if ('description' in parsed) return { ok: false, error: 'invalid_request', description: parsed.description };
    pkce = parsed.challenge;
  }

  return {
    ok: true,
    request: {
      clientId,
      redirectUri,
      responseType,
      scope: str('scope') || DEFAULT_SCOPE,
      state: str('state'),
      pkce,
      appOrigin: client.origin,
      appHost: client.host,
    },
  };
}

// A plain-text 400 that never carries a Location: an invalid request must not
// bounce the browser anywhere.
function badRequest(c: Context, parsed: { error: string; description: string }): Response {
  return c.text(`${parsed.error}: ${parsed.description}`, 400);
}

consentRouter.get('/authorize', (c) => {
  const parsed = parseAuthorizationRequest(c.req.query());
  if ('error' in parsed) return badRequest(c, parsed);

  // The page's own CSP governs where its form may go, including the 302 that
  // answers the POST. Chromium and WebKit apply form-action to redirects after
  // a form submission, so with plain `form-action 'self'` approving would be
  // blocked at the app's redirect. Allow exactly this request's app origin
  // (already checked to be http(s) and equal to the client_id origin), and
  // nothing else.
  c.set('formActionOrigin', parsed.request.appOrigin);
  return c.html(renderConsentPage(parsed.request, c.get('ownerEmail'), c.get('instance').accountUsername));
});

consentRouter.post('/authorize', async (c) => {
  const body = await c.req.parseBody();
  const action = body.action;
  if (action !== 'approve' && action !== 'deny') {
    return c.text('invalid_request: action must be approve or deny', 400);
  }

  const parsed = parseAuthorizationRequest(body);
  if ('error' in parsed) return badRequest(c, parsed);
  const request = parsed.request;

  if (action === 'deny') {
    const denyUrl = new URL(request.redirectUri);
    denyUrl.searchParams.set('error', 'access_denied');
    if (request.state) denyUrl.searchParams.set('state', request.state);
    return c.redirect(denyUrl.toString(), 302);
  }

  const location = await issueGrant((c.env as any).DB, c.get('instance').accountUsername, request);
  return c.redirect(location, 302);
});

/**
 * Issues what the Owner approved and returns where to send the browser:
 * implicit (`token`) puts a fresh access token in the redirect fragment;
 * `code` stores a 10-minute authorization code for /oauth/:user/token.
 */
async function issueGrant(db: any, user: string, request: AuthorizationRequest): Promise<string> {
  const { clientId, redirectUri, scope, state } = request;

  // Record the client on first approval so it can be listed and revoked.
  try {
    const known = await db?.prepare?.('SELECT id FROM oauth_clients WHERE id = ?')?.bind?.(clientId)?.first?.();
    if (!known) {
      await db?.prepare?.('INSERT INTO oauth_clients (id, name, redirect_uris, created_at, user_id) VALUES (?, ?, ?, ?, ?)')
        ?.bind?.(clientId, clientId, redirectUri, Math.floor(Date.now() / 1000), user)?.run?.();
    }
  } catch { /* best effort */ }

  const redirectUrl = new URL(redirectUri);

  if (request.responseType === 'token') {
    const accessToken = generateToken();
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    await db?.prepare?.(
      'INSERT INTO oauth_tokens (id, access_token, refresh_token, expires_at, scopes, user_id, client_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )?.bind?.(crypto.randomUUID(), accessToken, null, expiresAt, scope, user, clientId)?.run?.();

    redirectUrl.hash = new URLSearchParams({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: '3600',
      scope,
      ...(state ? { state } : {}),
    }).toString();
    return redirectUrl.toString();
  }

  const code = generateAuthCode();
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  await db?.prepare?.(
    'INSERT INTO oauth_codes (code, client_id, user_id, redirect_uri, scope, expires_at, code_challenge, code_challenge_method) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )?.bind?.(code, clientId, user, redirectUri, scope, expiresAt, request.pkce?.codeChallenge ?? null, request.pkce?.method ?? null)?.run?.();

  redirectUrl.searchParams.set('code', code);
  if (state) redirectUrl.searchParams.set('state', state);
  return redirectUrl.toString();
}

function generateAuthCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array).map(b => chars[b % chars.length]).join('');
}

function escapeHtml(str: string): string {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** One requested Module per scope, e.g. `documents:rw` -> documents, read and write. */
function describeScopes(scope: string): { module: string; access: string }[] {
  return scope.split(/\s+/).filter(Boolean).map((item) => {
    const [name, level] = item.split(':');
    const module = name === '*' ? 'All modules' : name;
    const access = level === 'rw' ? 'read and write' : level === 'r' ? 'read only' : `"${level ?? ''}" access`;
    return { module, access };
  });
}

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; }
  .container { max-width: 440px; margin: 80px auto; background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  h1 { font-size: 1.25rem; margin-bottom: 1rem; overflow-wrap: anywhere; }
  .muted { font-size: 0.875rem; color: #666; margin-bottom: 1rem; }
  .scope-list { margin: 0.75rem 0 1rem; }
  .scope-item { padding: 0.5rem; background: #e8f4ff; border-radius: 4px; margin: 0.25rem 0; font-size: 0.875rem; }
  .redirect { background: #f5f5f5; padding: 0.75rem 1rem; border-radius: 4px; font-size: 0.875rem; overflow-wrap: anywhere; }
  .buttons { display: flex; gap: 1rem; margin-top: 1.5rem; }
  button { flex: 1; padding: 0.75rem; border-radius: 4px; border: none; font-size: 1rem; cursor: pointer; }
  .approve { background: #0066cc; color: white; }
  .approve:hover { background: #0052a3; }
  .deny { background: #dc3545; color: white; }
  .deny:hover { background: #c82333; }
`;

function renderConsentPage(request: AuthorizationRequest, ownerEmail: string, user: string): string {
  const { clientId, redirectUri, responseType, scope, state, pkce, appHost } = request;
  const modules = describeScopes(scope);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Allow ${escapeHtml(appHost)}? — RSilo</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="container">
    <h1>Allow <strong>${escapeHtml(appHost)}</strong> to access your storage?</h1>
    <p class="muted">Account <strong>${escapeHtml(user)}</strong>, signed in as ${escapeHtml(ownerEmail)}</p>
    <p>It is asking for:</p>
    <div class="scope-list">
      ${modules.map(m => `<div class="scope-item"><strong>${escapeHtml(m.module)}</strong>: ${escapeHtml(m.access)}</div>`).join('')}
    </div>
    <p>If you allow it, you will be sent back to:</p>
    <p class="redirect"><code>${escapeHtml(redirectUri)}</code></p>
    <form method="POST" action="/account/oauth/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
      <input type="hidden" name="response_type" value="${escapeHtml(responseType)}">
      <input type="hidden" name="scope" value="${escapeHtml(scope)}">
      ${state ? `<input type="hidden" name="state" value="${escapeHtml(state)}">` : ''}
      ${pkce ? `<input type="hidden" name="code_challenge" value="${escapeHtml(pkce.codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(pkce.method)}">` : ''}
      <div class="buttons">
        <button type="submit" name="action" value="approve" class="approve">Allow</button>
        <button type="submit" name="action" value="deny" class="deny">Deny</button>
      </div>
    </form>
  </div>
</body>
</html>`;
}
