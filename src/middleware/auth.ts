import type { Context, Next } from '../types';
import { parseAuthHeader, hasScope, scopeFromPath } from '../services/auth';
import type { TokenPayload } from '../services/auth';

// Access tokens are opaque bearer tokens: a token is valid exactly while its
// unexpired row exists in oauth_tokens (ADR-0003).
async function resolveTokenPayload(c: Context, token: string): Promise<TokenPayload | null> {
  const db = (c.env as any)?.DB;
  if (!db || typeof db.prepare !== 'function') return null;

  const row = await db.prepare(
    'SELECT * FROM oauth_tokens WHERE access_token = ? AND expires_at > ?'
  ).bind(token, Math.floor(Date.now() / 1000)).first() as any;

  if (!row) return null;
  return {
    sub: row.user_id,
    scopes: row.scopes,
    iat: row.created_at,
    exp: row.expires_at,
  };
}

export function authMiddleware() {
  return async (c: Context, next: Next) => {
    // Tokens live in D1, so storage auth is configured once the DB is bound.
    if (!(c.env as any)?.DB) {
      return c.text('Server authentication is not configured', 503);
    }

    const path = c.req.path;
    const method = c.req.method;

    // Public reads may be anonymous, but still resolve a supplied token so that
    // folder listings under /public/ can be authorised.
    if (path.includes('/public/') && (method === 'GET' || method === 'HEAD')) {
      const token = parseAuthHeader(c.req.header('Authorization') ?? null);
      if (token) {
        const payload = await resolveTokenPayload(c, token);
        if (payload) c.set('tokenPayload', payload);
      }
      await next();
      return;
    }

    const authHeader = c.req.header('Authorization') ?? null;
    const token = parseAuthHeader(authHeader);

    if (!token) {
      return c.text('Unauthorized', 401, {
        'WWW-Authenticate': 'Bearer realm="storage"',
      });
    }

    const payload = await resolveTokenPayload(c, token);
    if (payload) {
      c.set('tokenPayload', payload);
      await next();
      return;
    }

    return c.text('Invalid token', 401, {
      'WWW-Authenticate': 'Bearer realm="storage" error="invalid_token"',
    });
  };
}

export function requireScope(scope: 'r' | 'rw') {
  return async (c: Context, next: Next) => {
    const payload = c.get('tokenPayload') as TokenPayload | undefined;
    if (!payload) {
      return c.text('Unauthorized', 401, {
        'WWW-Authenticate': 'Bearer realm="storage"',
      });
    }

    const path = c.req.path;
    const { module } = scopeFromPath(path);
    const usernameFromUrl = c.req.param('username') || '';

    if (!module || module === '..' || module === '.' || module.includes('..') || module.includes('/')) {
      return c.text('Invalid path', 400);
    }

    if (usernameFromUrl !== payload.sub) {
      return c.text('Forbidden', 403, { 'WWW-Authenticate': 'Bearer realm="storage"' });
    }

    const requiredScope = `${module}:${scope}`;

    if (!hasScope(payload.scopes, requiredScope)) {
      return c.text('Insufficient scope', 403, {
        'WWW-Authenticate': `Bearer realm="storage" scope="${requiredScope}" error="insufficient_scope"`,
      });
    }

    await next();
  };
}
