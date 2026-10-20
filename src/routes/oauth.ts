import { Hono } from 'hono';
import { PROTOCOL_VERSION } from '../protocol/constants';
import { requireAccountPath, requireAccountRow, requireInstanceConfig } from '../middleware/instance';
import { accountUrls } from '../services/discovery';
import { PKCE_METHODS, verifyPkce } from '../services/pkce';
import { ACCESS_TOKEN_TTL_SECONDS, issueTokens, redeemCode, rotateRefreshToken } from '../services/tokens';
import type { IssuedTokens } from '../services/tokens';
import type { Context } from '../types';

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

// The token request's parameters, form-encoded (RFC 6749) or JSON. Null when
// the body is not a well-formed object of either kind.
async function tokenRequestParams(c: Context): Promise<Record<string, unknown> | null> {
  try {
    if ((c.req.header('Content-Type') || '').includes('application/x-www-form-urlencoded')) {
      return Object.fromEntries(new URLSearchParams(await c.req.text()));
    }
    const json: unknown = await c.req.json();
    return json !== null && typeof json === 'object' && !Array.isArray(json) ? json as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function tokenResponse(c: Context, tokens: IssuedTokens, scope: string): Response {
  return c.json({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope,
  });
}

oauthRouter.post('/:user/token', ...forAccount, async (c) => {
  const params = await tokenRequestParams(c);
  if (!params) {
    return c.json({ error: 'invalid_request', error_description: 'body must be a form-encoded or JSON object' }, 400);
  }
  const param = (name: string) => (typeof params[name] === 'string' && params[name] ? params[name] as string : undefined);
  const grantType = param('grant_type');

  // Tokens and codes live in D1; dev mode may run without it.
  const db = (c.env as { DB?: D1Database }).DB;
  if (!db) return c.json({ error: 'server_error', error_description: 'Server database is not configured' }, 503);

  if (grantType === 'authorization_code') {
    const code = param('code');
    const redirectUri = param('redirect_uri');
    if (!code || !redirectUri) {
      return c.json({ error: 'invalid_request', error_description: 'code and redirect_uri required' }, 400);
    }

    // A code is spent by any attempt to redeem it, successful or not.
    const codeData = await redeemCode(db, code);
    if (!codeData) {
      return c.json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' }, 400);
    }

    if (codeData.redirect_uri !== redirectUri) {
      return c.json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400);
    }

    // Every code carries an S256 challenge (the consent page requires one).
    const codeVerifier = param('code_verifier');
    if (!codeVerifier || !await verifyPkce(codeVerifier, codeData.code_challenge)) {
      return c.json({ error: 'invalid_grant', error_description: 'code_verifier does not match code_challenge' }, 400);
    }

    const tokens = await issueTokens(db, {
      clientId: codeData.client_id,
      user: codeData.user_id,
      scope: codeData.scope,
      withRefreshToken: true,
    });
    return tokenResponse(c, tokens, codeData.scope);
  }

  if (grantType === 'refresh_token') {
    const refreshToken = param('refresh_token');
    if (!refreshToken) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    // Refresh tokens rotate on use and expire after 30 days. Only the newest
    // one works: a superseded refresh token is invalid_grant.
    const rotated = await rotateRefreshToken(db, refreshToken);
    if (!rotated) {
      return c.json({ error: 'invalid_grant', error_description: 'Invalid or expired refresh token' }, 400);
    }
    return tokenResponse(c, rotated, rotated.scope);
  }

  if (grantType === 'client_credentials') {
    return c.json({ error: 'not_implemented', error_description: 'Client credentials not yet supported' }, 501);
  }

  return c.json({ error: 'unsupported_grant_type' }, 400);
});

oauthRouter.get('/:user', requireInstanceConfig(), requireAccountPath(), async (c) => {
  const instance = c.get('instance');
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
  });
});
