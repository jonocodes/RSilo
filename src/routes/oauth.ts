import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { PROTOCOL_VERSION } from '../protocol/constants';

export const oauthRouter = new Hono();

oauthRouter.get('/:user/authorize', async (c) => {
  const user = c.req.param('user');
  const clientId = c.req.query('client_id');
  const redirectUri = c.req.query('redirect_uri');
  const responseType = c.req.query('response_type');
  const scope = c.req.query('scope') || 'documents:rw';
  const state = c.req.query('state');

  if (!clientId || !redirectUri) {
    return c.json({ error: 'invalid_request', error_description: 'client_id and redirect_uri are required' }, 400);
  }

  if (responseType !== 'token' && responseType !== 'code') {
    return c.json({ error: 'unsupported_response_type' }, 400);
  }

  const db = c.env.DB as any;
  const client = db?.prepare?.('SELECT * FROM oauth_clients WHERE id = ?')?.bind?.(clientId)?.first?.();

  if (!client) {
    return c.json({ error: 'invalid_client', error_description: 'Unknown client_id' }, 400);
  }

  const redirectUris = client.redirect_uris?.split(',') || [];
  if (!redirectUris.includes(redirectUri)) {
    return c.json({ error: 'invalid_request', error_description: 'Invalid redirect_uri' }, 400);
  }

  if (c.req.header('Authorization')) {
    const authHeader = c.req.header('Authorization') || '';
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const tokenData = db?.prepare?.('SELECT * FROM oauth_tokens WHERE access_token = ?')?.bind?.(token)?.first?.();
      if (tokenData && tokenData.user_id === client.user_id) {
        const code = generateAuthCode();
        const codeStore = c.env.OAUTH_CODES as Map<string, any> || new Map();
        codeStore.set(code, {
          client_id: clientId,
          user_id: client.user_id,
          redirect_uri: redirectUri,
          scope,
          expires_at: Math.floor(Date.now() / 1000) + 600,
        });
        if (responseType === 'code') {
          const redirectUrl = new URL(redirectUri);
          redirectUrl.searchParams.set('code', code);
          if (state) redirectUrl.searchParams.set('state', state);
          return c.redirect(redirectUrl.toString(), 302);
        } else {
          const accessToken = generateToken();
          const expiresAt = Math.floor(Date.now() / 1000) + 3600;
          db?.prepare?.('INSERT INTO oauth_tokens (id, access_token, refresh_token, expires_at, scopes, user_id, client_id) VALUES (?, ?, ?, ?, ?, ?, ?)?')?.bind?.(
            crypto.randomUUID(), accessToken, null, expiresAt, scope, client.user_id, clientId
          )?.run?.();
          const redirectUrl = new URL(redirectUri);
          redirectUrl.hash = new URLSearchParams({
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: '3600',
            scope,
            ...(state ? { state } : {}),
          }).toString();
          return c.redirect(redirectUrl.toString(), 302);
        }
      }
    }
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorize ${escapeHtml(clientId)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; }
    .container { max-width: 400px; margin: 100px auto; background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    h1 { font-size: 1.25rem; margin-bottom: 1rem; }
    .client-info { background: #f5f5f5; padding: 1rem; border-radius: 4px; margin-bottom: 1rem; }
    .client-info p { margin: 0.25rem 0; font-size: 0.875rem; }
    .client-name { font-weight: 600; }
    .scope-list { margin: 1rem 0; }
    .scope-item { padding: 0.5rem; background: #e8f4ff; border-radius: 4px; margin: 0.25rem 0; font-size: 0.875rem; }
    .buttons { display: flex; gap: 1rem; margin-top: 1.5rem; }
    button { flex: 1; padding: 0.75rem; border-radius: 4px; border: none; font-size: 1rem; cursor: pointer; }
    .approve { background: #0066cc; color: white; }
    .approve:hover { background: #0052a3; }
    .deny { background: #dc3545; color: white; }
    .deny:hover { background: #c82333; }
    .error { color: #dc3545; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorize Access</h1>
    <div class="client-info">
      <p class="client-name">${escapeHtml(client.name || clientId)}</p>
      <p><strong>Client ID:</strong> ${escapeHtml(clientId)}</p>
      <p><strong>Redirect URI:</strong> ${escapeHtml(redirectUri)}</p>
    </div>
    <p>This application is requesting access to:</p>
    <div class="scope-list">
      ${scope.split(' ').map((s: string) => `<div class="scope-item">${escapeHtml(s)}</div>`).join('')}
    </div>
    <form method="POST" action="/oauth/${escapeHtml(user)}/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
      <input type="hidden" name="response_type" value="${escapeHtml(responseType || '')}">
      <input type="hidden" name="scope" value="${escapeHtml(scope)}">
      ${state ? `<input type="hidden" name="state" value="${escapeHtml(state)}">` : ''}
      <div class="buttons">
        <button type="submit" name="action" value="approve" class="approve">Authorize</button>
        <button type="submit" name="action" value="deny" class="deny">Deny</button>
      </div>
    </form>
  </div>
</body>
</html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
});

oauthRouter.post('/:user/authorize', async (c) => {
  const user = c.req.param('user');
  const body = await c.req.parseBody() as any;
  const { client_id, redirect_uri, response_type, scope, state, action } = body;

  if (action === 'deny') {
    const denyUrl = new URL(redirect_uri);
    denyUrl.searchParams.set('error', 'access_denied');
    if (state) denyUrl.searchParams.set('state', state);
    return c.redirect(denyUrl.toString(), 302);
  }

  if (!client_id || !redirect_uri) {
    return c.json({ error: 'invalid_request' }, 400);
  }

  const db = c.env.DB as any;
  const client = db?.prepare?.('SELECT * FROM oauth_clients WHERE id = ?')?.bind?.(client_id)?.first?.();

  if (!client || client.user_id !== user) {
    return c.json({ error: 'invalid_client' }, 400);
  }

  const code = generateAuthCode();
  const codeStore = c.env.OAUTH_CODES as Map<string, any> || new Map();
  codeStore.set(code, {
    client_id,
    user_id: user,
    redirect_uri,
    scope: scope || 'documents:rw',
    expires_at: Math.floor(Date.now() / 1000) + 600,
  });

  if (response_type === 'token') {
    const accessToken = generateToken();
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    db?.prepare?.('INSERT INTO oauth_tokens (id, access_token, refresh_token, expires_at, scopes, user_id, client_id) VALUES (?, ?, ?, ?, ?, ?, ?)?')?.bind?.(
      crypto.randomUUID(), accessToken, null, expiresAt, scope || 'documents:rw', user, client_id
    )?.run?.();
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

  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set('code', code);
  if (state) redirectUrl.searchParams.set('state', state);
  return c.redirect(redirectUrl.toString(), 302);
});

oauthRouter.post('/:user/token', async (c) => {
  const contentType = c.req.header('Content-Type') || '';

  let grantType: string;
  let clientId: string;
  let clientSecret: string | undefined;
  let code: string | undefined;
  let redirectUri: string | undefined;
  let refreshToken: string | undefined;
  let scope: string | undefined;

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const body = await c.req.text();
    const params = new URLSearchParams(body);
    grantType = params.get('grant_type') || '';
    clientId = params.get('client_id') || '';
    clientSecret = params.get('client_secret') || undefined;
    code = params.get('code') || undefined;
    redirectUri = params.get('redirect_uri') || undefined;
    refreshToken = params.get('refresh_token') || undefined;
    scope = params.get('scope') || undefined;
  } else {
    const json = await c.req.json() as any;
    grantType = json.grant_type || '';
    clientId = json.client_id || '';
    clientSecret = json.client_secret;
    code = json.code;
    redirectUri = json.redirect_uri;
    refreshToken = json.refresh_token;
    scope = json.scope;
  }

  const db = c.env.DB as any;

  if (grantType === 'authorization_code') {
    if (!code || !redirectUri) {
      return c.json({ error: 'invalid_request', error_description: 'code and redirect_uri required' }, 400);
    }
    const codeStore = c.env.OAUTH_CODES as Map<string, any>;
    const codeData = codeStore?.get(code);

    if (!codeData) {
      return c.json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' }, 400);
    }

    if (codeData.redirect_uri !== redirectUri) {
      return c.json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400);
    }

    if (codeData.expires_at < Math.floor(Date.now() / 1000)) {
      codeStore.delete(code);
      return c.json({ error: 'invalid_grant', error_description: 'Authorization code expired' }, 400);
    }

    codeStore.delete(code);

    const accessToken = generateToken();
    const newRefreshToken = generateToken();
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const refreshExpiresAt = Math.floor(Date.now() / 1000) + 86400 * 30;

    db?.prepare?.('INSERT INTO oauth_tokens (id, access_token, refresh_token, expires_at, scopes, user_id, client_id) VALUES (?, ?, ?, ?, ?, ?, ?)?')?.bind?.(
      crypto.randomUUID(), accessToken, newRefreshToken, expiresAt, codeData.scope, codeData.user_id, clientId
    )?.run?.();

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

    const tokenData = db?.prepare?.('SELECT * FROM oauth_tokens WHERE refresh_token = ?')?.bind?.(refreshToken)?.first?.();

    if (!tokenData) {
      return c.json({ error: 'invalid_grant', error_description: 'Invalid refresh token' }, 400);
    }

    const accessToken = generateToken();
    const newRefreshToken = generateToken();
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;

    db?.prepare?.('UPDATE oauth_tokens SET access_token = ?, refresh_token = ?, expires_at = ? WHERE refresh_token = ?')?.bind?.(
      accessToken, newRefreshToken, expiresAt, refreshToken
    )?.run?.();

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
  let code = '';
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  for (let i = 0; i < 32; i++) {
    code += chars[array[i] % chars.length];
  }
  return code;
}

function generateToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  const array = new Uint8Array(48);
  crypto.getRandomValues(array);
  for (let i = 0; i < 48; i++) {
    token += chars[array[i] % chars.length];
  }
  return token;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}