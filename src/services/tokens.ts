import { generateToken, hashToken } from './auth';

// The rows behind App authorizations: oauth_clients, oauth_codes and
// oauth_tokens. Only hashes of codes and tokens are stored. Every function
// needs the database; callers check it is bound.

export const ACCESS_TOKEN_TTL_SECONDS = 3600;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 86400;
export const CODE_TTL_SECONDS = 600;
// The implicit flow (remoteStorage.js) has no refresh token, so its access
// token lasts 30 days from its last use instead: an app in use never asks the
// Owner again, and an abandoned one still expires.
export const IMPLICIT_TOKEN_TTL_SECONDS = 30 * 86400;
// How often an implicit token's expiry is pushed forward, at most, so use
// costs one D1 write a day rather than one per request.
const IMPLICIT_RENEWAL_INTERVAL_SECONDS = 86400;

export interface IssuedTokens {
  accessToken: string;
  /** Null for the implicit flow, which has no refresh token. */
  refreshToken: string | null;
}

export interface AuthorizationCode {
  client_id: string;
  user_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  expires_at: number;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Records the client on first approval so it can be listed and revoked. */
export async function recordClient(db: D1Database, clientId: string, redirectUri: string, user: string): Promise<void> {
  await db.prepare('INSERT OR IGNORE INTO oauth_clients (id, name, redirect_uris, created_at, user_id) VALUES (?, ?, ?, ?, ?)')
    .bind(clientId, clientId, redirectUri, nowSeconds(), user)
    .run();
}

/** Stores a 10-minute authorization code and returns it. */
export async function issueCode(
  db: D1Database,
  grant: { clientId: string; user: string; redirectUri: string; scope: string; codeChallenge: string },
): Promise<string> {
  const code = generateToken();
  await db.prepare(
    'INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, scope, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(await hashToken(code), grant.clientId, grant.user, grant.redirectUri, grant.scope, grant.codeChallenge, nowSeconds() + CODE_TTL_SECONDS).run();
  return code;
}

/**
 * Spends an authorization code and returns it if it had not expired. Any
 * attempt spends it, and the single DELETE … RETURNING means concurrent
 * attempts get it at most once.
 */
export async function redeemCode(db: D1Database, code: string): Promise<AuthorizationCode | null> {
  const row = await db.prepare(
    'DELETE FROM oauth_codes WHERE code_hash = ? RETURNING client_id, user_id, redirect_uri, scope, code_challenge, expires_at'
  ).bind(await hashToken(code)).first<AuthorizationCode>();
  return row && row.expires_at > nowSeconds() ? row : null;
}

/**
 * Stores a new token row: a 1-hour access token and a 30-day refresh token,
 * or for the implicit flow a sliding 30-day access token and none. Expired
 * rows and codes are purged first, so they never pile up.
 */
export async function issueTokens(
  db: D1Database,
  grant: { clientId: string; user: string; scope: string; withRefreshToken: boolean },
): Promise<IssuedTokens> {
  const now = nowSeconds();
  await db.batch([
    db.prepare('DELETE FROM oauth_tokens WHERE expires_at <= ? AND (refresh_expires_at IS NULL OR refresh_expires_at <= ?)').bind(now, now),
    db.prepare('DELETE FROM oauth_codes WHERE expires_at <= ?').bind(now),
  ]);

  const accessToken = generateToken();
  const refreshToken = grant.withRefreshToken ? generateToken() : null;
  await db.prepare(
    'INSERT INTO oauth_tokens (id, access_token_hash, refresh_token_hash, expires_at, refresh_expires_at, scopes, user_id, client_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    crypto.randomUUID(),
    await hashToken(accessToken),
    refreshToken ? await hashToken(refreshToken) : null,
    now + (refreshToken ? ACCESS_TOKEN_TTL_SECONDS : IMPLICIT_TOKEN_TTL_SECONDS),
    refreshToken ? now + REFRESH_TOKEN_TTL_SECONDS : null,
    grant.scope,
    grant.user,
    grant.clientId,
  ).run();
  return { accessToken, refreshToken };
}

/**
 * Pushes an implicit-flow token's expiry to 30 days from now, if it was last
 * pushed over a day ago. Code-flow tokens keep their 1-hour expiry; dev
 * tokens, which also have no refresh token, slide too.
 */
export async function renewImplicitToken(
  db: D1Database,
  row: { access_token_hash: string; expires_at: number; has_refresh_token: number },
): Promise<void> {
  const now = nowSeconds();
  if (row.has_refresh_token || row.expires_at > now + IMPLICIT_TOKEN_TTL_SECONDS - IMPLICIT_RENEWAL_INTERVAL_SECONDS) return;
  await db.prepare('UPDATE oauth_tokens SET expires_at = ? WHERE access_token_hash = ? AND refresh_token_hash IS NULL')
    .bind(now + IMPLICIT_TOKEN_TTL_SECONDS, row.access_token_hash)
    .run();
}

/**
 * Exchanges an unexpired refresh token for a new access token and a fresh
 * 30-day refresh token, replacing both in its row. One conditional UPDATE, so
 * a superseded token (or the loser of two concurrent rotations) matches
 * nothing and gets null.
 */
export async function rotateRefreshToken(db: D1Database, refreshToken: string): Promise<(IssuedTokens & { scope: string }) | null> {
  const now = nowSeconds();
  const accessToken = generateToken();
  const nextRefreshToken = generateToken();
  const row = await db.prepare(
    'UPDATE oauth_tokens SET access_token_hash = ?, refresh_token_hash = ?, expires_at = ?, refresh_expires_at = ? '
    + 'WHERE refresh_token_hash = ? AND refresh_expires_at > ? RETURNING scopes'
  ).bind(
    await hashToken(accessToken),
    await hashToken(nextRefreshToken),
    now + ACCESS_TOKEN_TTL_SECONDS,
    now + REFRESH_TOKEN_TTL_SECONDS,
    await hashToken(refreshToken),
    now,
  ).first<{ scopes: string }>();
  return row ? { accessToken, refreshToken: nextRefreshToken, scope: row.scopes } : null;
}
