import { Hono } from 'hono';
import { PROTOCOL_VERSION } from '../protocol/constants';
import { verifyPassword, signSessionToken, verifySessionToken } from '../services/auth';

export const oauthRouter = new Hono();

const DEFAULT_SESSION_SECRET = 'dev-session-secret-change-in-production';

function getSessionSecret(env: any): string {
  return env?.SESSION_SECRET || DEFAULT_SESSION_SECRET;
}

oauthRouter.get('/:user/authorize', async (c) => {
  const user = c.req.param('user');
  const clientId = c.req.query('client_id');
  const redirectUri = c.req.query('redirect_uri');
  const responseType = c.req.query('response_type');
  const scope = c.req.query('scope') || 'documents:rw';
  const state = c.req.query('state') || '';

  if (!clientId || !redirectUri) {
    return c.json({ error: 'invalid_request', error_description: 'client_id and redirect_uri are required' }, 400);
  }

  if (responseType !== 'token' && responseType !== 'code') {
    return c.json({ error: 'unsupported_response_type' }, 400);
  }

  const db = (c.env as any).DB;
  const client = await db?.prepare?.('SELECT * FROM oauth_clients WHERE id = ?')?.bind?.(clientId)?.first?.();

  if (!client) {
    return c.json({ error: 'invalid_client', error_description: 'Unknown client_id' }, 400);
  }

  const redirectUris = (client.redirect_uris || '').split(',');
  if (!redirectUris.includes(redirectUri)) {
    return c.json({ error: 'invalid_request', error_description: 'Invalid redirect_uri' }, 400);
  }

  return new Response(renderLoginForm({ user, clientId, redirectUri, responseType, scope, state }), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
});

oauthRouter.post('/:user/authorize', async (c) => {
  const user = c.req.param('user');
  const body = await c.req.parseBody() as any;
  const { client_id, redirect_uri, response_type, scope, state, action, password, session_token } = body;

  if (action === 'deny') {
    const denyUrl = new URL(redirect_uri);
    denyUrl.searchParams.set('error', 'access_denied');
    if (state) denyUrl.searchParams.set('state', state);
    return c.redirect(denyUrl.toString(), 302);
  }

  const db = (c.env as any).DB;

  if (action === 'login') {
    if (!password) {
      return new Response(renderLoginForm({ user, clientId: client_id, redirectUri: redirect_uri, responseType: response_type, scope, state, error: 'Password is required' }), {
        status: 400,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    const userRow = await db?.prepare?.('SELECT * FROM users WHERE username = ?')?.bind?.(user)?.first?.();

    if (!userRow || !userRow.password_hash) {
      return new Response(renderLoginForm({ user, clientId: client_id, redirectUri: redirect_uri, responseType: response_type, scope, state, error: 'Invalid username or password' }), {
        status: 401,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    const valid = await verifyPassword(password, userRow.password_hash);
    if (!valid) {
      return new Response(renderLoginForm({ user, clientId: client_id, redirectUri: redirect_uri, responseType: response_type, scope, state, error: 'Invalid username or password' }), {
        status: 401,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    const client = await db?.prepare?.('SELECT * FROM oauth_clients WHERE id = ?')?.bind?.(client_id)?.first?.();
    const token = await signSessionToken(user, getSessionSecret(c.env));

    return new Response(renderConsentForm({ user, client, clientId: client_id, redirectUri: redirect_uri, responseType: response_type, scope, state, sessionToken: token }), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  if (action === 'approve') {
    if (!session_token) {
      return c.json({ error: 'invalid_request', error_description: 'Missing session token' }, 400);
    }

    const authedUser = await verifySessionToken(session_token, getSessionSecret(c.env));
    if (!authedUser || authedUser !== user) {
      return c.json({ error: 'access_denied', error_description: 'Session expired, please log in again' }, 401);
    }

    if (!client_id || !redirect_uri) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    if (response_type === 'token') {
      const accessToken = generateToken();
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await db?.prepare?.(
        'INSERT INTO oauth_tokens (id, access_token, refresh_token, expires_at, scopes, user_id, client_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )?.bind?.(crypto.randomUUID(), accessToken, null, expiresAt, scope || 'documents:rw', user, client_id)?.run?.();

      const redirectUrl = new URL(redirect_uri);
      redirectUrl.hash = new URLSearchParams({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: '3600',
        scope: scope || 'documents:rw',
        ...(state ? { state } : {}),
      }).toString();
      return c.redirect(redirectUrl.toString(), 302);
    }

    // response_type=code
    const code = generateAuthCode();
    const expiresAt = Math.floor(Date.now() / 1000) + 600;
    await db?.prepare?.(
      'INSERT INTO oauth_codes (code, client_id, user_id, redirect_uri, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
    )?.bind?.(code, client_id, user, redirect_uri, scope || 'documents:rw', expiresAt)?.run?.();

    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);
    return c.redirect(redirectUrl.toString(), 302);
  }

  return c.json({ error: 'invalid_request', error_description: 'Unknown action' }, 400);
});

oauthRouter.post('/:user/token', async (c) => {
  const contentType = c.req.header('Content-Type') || '';

  let grantType: string;
  let clientSecret: string | undefined;
  let code: string | undefined;
  let redirectUri: string | undefined;
  let refreshToken: string | undefined;

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(await c.req.text());
    grantType = params.get('grant_type') || '';
    clientSecret = params.get('client_secret') || undefined;
    code = params.get('code') || undefined;
    redirectUri = params.get('redirect_uri') || undefined;
    refreshToken = params.get('refresh_token') || undefined;
  } else {
    const json = await c.req.json() as any;
    grantType = json.grant_type || '';
    clientSecret = json.client_secret;
    code = json.code;
    redirectUri = json.redirect_uri;
    refreshToken = json.refresh_token;
  }

  const db = (c.env as any).DB;

  if (grantType === 'authorization_code') {
    if (!code || !redirectUri) {
      return c.json({ error: 'invalid_request', error_description: 'code and redirect_uri required' }, 400);
    }

    const codeData = await db?.prepare?.(
      'SELECT * FROM oauth_codes WHERE code = ? AND expires_at > ?'
    )?.bind?.(code, Math.floor(Date.now() / 1000))?.first?.();

    if (!codeData) {
      return c.json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' }, 400);
    }

    if (codeData.redirect_uri !== redirectUri) {
      return c.json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400);
    }

    // Validate client_secret if provided
    if (clientSecret) {
      const client = await db?.prepare?.(
        'SELECT * FROM oauth_clients WHERE id = ? AND secret = ?'
      )?.bind?.(codeData.client_id, clientSecret)?.first?.();
      
      if (!client) {
        return c.json({ error: 'invalid_client', error_description: 'Invalid client credentials' }, 400);
      }
    }

    await db?.prepare?.('DELETE FROM oauth_codes WHERE code = ?')?.bind?.(code)?.run?.();

    const accessToken = generateToken();
    const newRefreshToken = generateToken();
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;

    await db?.prepare?.(
      'INSERT INTO oauth_tokens (id, access_token, refresh_token, expires_at, scopes, user_id, client_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )?.bind?.(crypto.randomUUID(), accessToken, newRefreshToken, expiresAt, codeData.scope, codeData.user_id, codeData.client_id)?.run?.();

    return c.json({
      access_token: accessToken,
      refresh_token: newRefreshToken,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: codeData.scope,
    });
  }

  if (grantType === 'refresh_token') {
    if (!refreshToken) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    const tokenData = await db?.prepare?.(
      'SELECT * FROM oauth_tokens WHERE refresh_token = ?'
    )?.bind?.(refreshToken)?.first?.();

    if (!tokenData) {
      return c.json({ error: 'invalid_grant', error_description: 'Invalid refresh token' }, 400);
    }

    // Validate client_secret if provided
    if (clientSecret) {
      const client = await db?.prepare?.(
        'SELECT * FROM oauth_clients WHERE id = ? AND secret = ?'
      )?.bind?.(tokenData.client_id, clientSecret)?.first?.();
      
      if (!client) {
        return c.json({ error: 'invalid_client', error_description: 'Invalid client credentials' }, 400);
      }
    }

    const accessToken = generateToken();
    const newRefreshToken = generateToken();
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;

    await db?.prepare?.(
      'UPDATE oauth_tokens SET access_token = ?, refresh_token = ?, expires_at = ? WHERE refresh_token = ?'
    )?.bind?.(accessToken, newRefreshToken, expiresAt, refreshToken)?.run?.();

    return c.json({
      access_token: accessToken,
      refresh_token: newRefreshToken,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: tokenData.scopes,
    });
  }

  if (grantType === 'client_credentials') {
    return c.json({ error: 'not_implemented', error_description: 'Client credentials not yet supported' }, 501);
  }

  return c.json({ error: 'unsupported_grant_type' }, 400);
});

oauthRouter.get('/:user', async (c) => {
  const user = c.req.param('user');
  const origin = c.req.header('Origin') || '*';
  const baseUrl = `http://${c.req.header('Host') || 'localhost'}`;

  return c.json({
    needs_grant: false,
    auth_method: 'popup',
    scopes: ['documents:rw', 'pictures:rw', 'music:rw'],
    owner: user,
    www: baseUrl,
    api: PROTOCOL_VERSION,
    auth: `${baseUrl}/oauth/${user}/authorize`,
    token_endpoint: `${baseUrl}/oauth/${user}/token`,
    storageapi: `${baseUrl}/storage/${user}`,
  }, 200, {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  } as any);
});

oauthRouter.options('/:user', (c) => {
  const origin = c.req.header('Origin') || '*';
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    }
  });
});

oauthRouter.options('/:user/authorize', (c) => {
  const origin = c.req.header('Origin') || '*';
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    }
  });
});

oauthRouter.options('/:user/token', (c) => {
  const origin = c.req.header('Origin') || '*';
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    }
  });
});

function generateAuthCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array).map(b => chars[b % chars.length]).join('');
}

function generateToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const array = new Uint8Array(48);
  crypto.getRandomValues(array);
  return Array.from(array).map(b => chars[b % chars.length]).join('');
}

function escapeHtml(str: string): string {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; }
  .container { max-width: 400px; margin: 100px auto; background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  h1 { font-size: 1.25rem; margin-bottom: 1rem; }
  .client-info { background: #f5f5f5; padding: 1rem; border-radius: 4px; margin-bottom: 1rem; }
  .client-info p { margin: 0.25rem 0; font-size: 0.875rem; }
  .client-name { font-weight: 600; }
  .scope-list { margin: 1rem 0; }
  .scope-item { padding: 0.5rem; background: #e8f4ff; border-radius: 4px; margin: 0.25rem 0; font-size: 0.875rem; }
  .field { margin-bottom: 1rem; }
  label { display: block; font-size: 0.875rem; font-weight: 500; margin-bottom: 0.25rem; }
  input[type=password] { width: 100%; padding: 0.5rem 0.75rem; border: 1px solid #ddd; border-radius: 4px; font-size: 1rem; }
  input[type=password]:focus { outline: none; border-color: #0066cc; box-shadow: 0 0 0 2px rgba(0,102,204,0.2); }
  .buttons { display: flex; gap: 1rem; margin-top: 1.5rem; }
  button { flex: 1; padding: 0.75rem; border-radius: 4px; border: none; font-size: 1rem; cursor: pointer; }
  .approve { background: #0066cc; color: white; }
  .approve:hover { background: #0052a3; }
  .deny { background: #dc3545; color: white; }
  .deny:hover { background: #c82333; }
  .error { color: #dc3545; font-size: 0.875rem; margin-bottom: 1rem; padding: 0.5rem; background: #fff5f5; border-radius: 4px; }
  .user-badge { font-size: 0.875rem; color: #666; margin-bottom: 1rem; }
`;

interface LoginFormParams {
  user: string;
  clientId: string;
  redirectUri: string;
  responseType: string;
  scope: string;
  state: string;
  error?: string;
}

function renderLoginForm({ user, clientId, redirectUri, responseType, scope, state, error }: LoginFormParams): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign in — ${escapeHtml(user)}</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="container">
    <h1>Sign in</h1>
    <p class="user-badge">Signing in as <strong>${escapeHtml(user)}</strong></p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <form method="POST" action="/oauth/${escapeHtml(user)}/authorize">
      <input type="hidden" name="action" value="login">
      <input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
      <input type="hidden" name="response_type" value="${escapeHtml(responseType)}">
      <input type="hidden" name="scope" value="${escapeHtml(scope)}">
      <input type="hidden" name="state" value="${escapeHtml(state)}">
      <div class="field">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" autofocus autocomplete="current-password">
      </div>
      <div class="buttons">
        <button type="submit" class="approve">Sign in</button>
      </div>
    </form>
  </div>
</body>
</html>`;
}

interface ConsentFormParams {
  user: string;
  client: any;
  clientId: string;
  redirectUri: string;
  responseType: string;
  scope: string;
  state: string;
  sessionToken: string;
}

function renderConsentForm({ user, client, clientId, redirectUri, responseType, scope, state, sessionToken }: ConsentFormParams): string {
  const scopes = scope.split(/\s+/).filter(Boolean);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorize — ${escapeHtml(clientId)}</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="container">
    <h1>Authorize Access</h1>
    <p class="user-badge">Signed in as <strong>${escapeHtml(user)}</strong></p>
    <div class="client-info">
      <p class="client-name">${escapeHtml(client?.name || clientId)}</p>
      <p><strong>Client ID:</strong> ${escapeHtml(clientId)}</p>
      <p><strong>Redirect URI:</strong> ${escapeHtml(redirectUri)}</p>
    </div>
    <p>This application is requesting access to:</p>
    <div class="scope-list">
      ${scopes.map(s => `<div class="scope-item">${escapeHtml(s)}</div>`).join('')}
    </div>
    <form method="POST" action="/oauth/${escapeHtml(user)}/authorize">
      <input type="hidden" name="action" value="approve">
      <input type="hidden" name="session_token" value="${escapeHtml(sessionToken)}">
      <input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
      <input type="hidden" name="response_type" value="${escapeHtml(responseType)}">
      <input type="hidden" name="scope" value="${escapeHtml(scope)}">
      ${state ? `<input type="hidden" name="state" value="${escapeHtml(state)}">` : ''}
      <div class="buttons">
        <button type="submit" class="approve">Authorize</button>
        <button type="submit" form="deny-form" class="deny">Deny</button>
      </div>
    </form>
    <form id="deny-form" method="POST" action="/oauth/${escapeHtml(user)}/authorize">
      <input type="hidden" name="action" value="deny">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
      ${state ? `<input type="hidden" name="state" value="${escapeHtml(state)}">` : ''}
    </form>
  </div>
</body>
</html>`;
}
