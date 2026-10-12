import { Hono } from 'hono';
import { PROTOCOL_VERSION } from '../protocol/constants';
import { generateToken } from '../services/auth';
import { requireAccountPath, requireAccountRow, requireInstanceConfig } from '../middleware/instance';
import { accountUrls } from '../services/discovery';
import { PKCE_METHODS, verifyPkce } from '../services/pkce';

export const oauthRouter = new Hono();

// Token issuance is for the Account only: any other username is a 404, and the
// canonical ACCOUNT_USERNAME (not the path segment) is used for every row
// written. The Account row must exist first, since OAuth rows reference
// users(username). The token endpoint stays outside /account and ungated:
// apps call it directly and cannot perform an Access login.
const forAccount = [requireInstanceConfig(), requireAccountPath(), requireAccountRow()] as const;

// The consent dialog moved under /account (routes/consent.ts, ADR-0004). Apps
// and remoteStorage.js cache discovery results, so the old URL stays as a
// redirect passing the query string through byte-for-byte: it is sliced from
// the raw request URL, never parsed and re-serialised. The target comes from
// resolved public origin (PUBLIC_BASE_URL when set) so the Owner lands on the
// Access-protected hostname.
oauthRouter.get('/:user/authorize', requireInstanceConfig(), requireAccountPath(), (c) => {
  const url = c.req.url;
  const queryStart = url.indexOf('?');
  const search = queryStart === -1 ? '' : url.slice(queryStart);
  return c.redirect(`${accountUrls(c.get('instance')).authorize}${search}`, 302);
});

// Consent is no longer submitted here. 405 rather than 404: the resource still
// exists (GET redirects), only this method is gone. Not a 307 to the new URL
// either: a consent decision must come from the page under /account that
// rendered it, behind the Owner gate and CSRF check.
oauthRouter.post('/:user/authorize', requireInstanceConfig(), requireAccountPath(), (c) => {
  return c.text('Method Not Allowed: consent is submitted at /account/oauth/authorize', 405, { Allow: 'GET, OPTIONS' });
});

oauthRouter.post('/:user/token', ...forAccount, async (c) => {
  const contentType = c.req.header('Content-Type') || '';

  let grantType: string;
  let code: string | undefined;
  let redirectUri: string | undefined;
  let refreshToken: string | undefined;
  let codeVerifier: string | undefined;

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(await c.req.text());
    grantType = params.get('grant_type') || '';
    code = params.get('code') || undefined;
    redirectUri = params.get('redirect_uri') || undefined;
    refreshToken = params.get('refresh_token') || undefined;
    codeVerifier = params.get('code_verifier') || undefined;
  } else {
    const json = await c.req.json() as any;
    grantType = json.grant_type || '';
    code = json.code;
    redirectUri = json.redirect_uri;
    refreshToken = json.refresh_token;
    codeVerifier = json.code_verifier;
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

    // Single use: burnt before the PKCE check, so a wrong verifier cannot be retried.
    await db?.prepare?.('DELETE FROM oauth_codes WHERE code = ?')?.bind?.(code)?.run?.();

    if (codeData.code_challenge) {
      if (typeof codeVerifier !== 'string' || !await verifyPkce(codeVerifier, codeData.code_challenge)) {
        return c.json({ error: 'invalid_grant', error_description: 'code_verifier does not match code_challenge' }, 400);
      }
    } else if (codeVerifier !== undefined) {
      // A verifier for a code requested without a challenge means the PKCE
      // parameters were stripped from the authorization request.
      return c.json({ error: 'invalid_grant', error_description: 'code_verifier sent for a code issued without code_challenge' }, 400);
    }

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

oauthRouter.get('/:user', requireInstanceConfig(), requireAccountPath(), async (c) => {
  const instance = c.get('instance');
  const origin = c.req.header('Origin') || '*';
  const urls = accountUrls(instance);

  return c.json({
    needs_grant: false,
    auth_method: 'popup',
    scopes: ['documents:rw', 'pictures:rw', 'music:rw'],
    owner: instance.accountUsername,
    www: urls.base,
    api: PROTOCOL_VERSION,
    auth: urls.authorize,
    token_endpoint: urls.token,
    code_challenge_methods_supported: PKCE_METHODS,
    storageapi: urls.storageRoot,
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
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
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

