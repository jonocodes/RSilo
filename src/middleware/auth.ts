import type { Context, Next } from '../types';
import { authorize, parseAuthHeader, hashToken } from '../services/auth';
import type { TokenPayload } from '../services/auth';
import { renewImplicitToken } from '../services/tokens';
import { decodeItemPath } from '../protocol/item-path';

// Access tokens are opaque bearer tokens: a token is valid exactly while its
// unexpired row exists in oauth_tokens (ADR-0003). Rows hold only its hash.
async function resolveTokenPayload(db: D1Database, token: string): Promise<TokenPayload | null> {
  const row = await db.prepare(
    'SELECT access_token_hash, user_id, scopes, created_at, expires_at, refresh_token_hash IS NOT NULL AS has_refresh_token '
    + 'FROM oauth_tokens WHERE access_token_hash = ? AND expires_at > ?'
  ).bind(await hashToken(token), Math.floor(Date.now() / 1000)).first<{
    access_token_hash: string; user_id: string; scopes: string; created_at: number; expires_at: number; has_refresh_token: number;
  }>();

  if (!row) return null;
  await renewImplicitToken(db, row);
  return {
    sub: row.user_id,
    scopes: row.scopes,
    iat: row.created_at,
    exp: row.expires_at,
  };
}

/**
 * Authenticates and authorizes every /storage request: resolves the bearer
 * token, if any, and lets authorize() decide. Reads are GET and HEAD; any
 * other method needs write access.
 */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function storageAuth() {
  return async (c: Context, next: Next) => {
    // Tokens live in D1, so storage auth is configured once the DB is bound.
    const db = (c.env as { DB?: D1Database } | undefined)?.DB;
    if (!db) {
      return c.text('Server authentication is not configured', 503);
    }

    const token = parseAuthHeader(c.req.header('Authorization') ?? null);
    const payload = token ? await resolveTokenPayload(db, token) : null;

    // c.req.path is the raw /storage/<username>/<path> (protocol/item-path.ts);
    // authorize by decoded names. An invalid path stays raw: the route
    // answers it with 400.
    const rest = c.req.path.slice('/storage/'.length);
    const slash = rest.indexOf('/');
    const username = safeDecode(slash === -1 ? rest : rest.slice(0, slash));
    const rawPath = slash === -1 ? '' : rest.slice(slash + 1);
    const path = decodeItemPath(rawPath) ?? rawPath;
    const access = c.req.method === 'GET' || c.req.method === 'HEAD' ? 'r' : 'rw';

    const denied = authorize(payload, username, path, access);
    if (!denied) return next();

    if (denied.status === 401) {
      return token
        ? c.text('Invalid token', 401, { 'WWW-Authenticate': 'Bearer realm="storage" error="invalid_token"' })
        : c.text('Unauthorized', 401, { 'WWW-Authenticate': 'Bearer realm="storage"' });
    }
    if (denied.requiredScope) {
      return c.text('Insufficient scope', 403, {
        'WWW-Authenticate': `Bearer realm="storage" scope="${denied.requiredScope}" error="insufficient_scope"`,
      });
    }
    return c.text('Forbidden', 403, { 'WWW-Authenticate': 'Bearer realm="storage"' });
  };
}
