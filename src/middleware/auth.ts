import type { Context, Next } from '../types';
import { parseAuthHeader, verifyToken, hasScope, scopeFromPath } from '../services/auth';
import type { TokenPayload } from '../services/auth';

export function authMiddleware() {
  return async (c: Context, next: Next) => {
    const path = c.req.path;

    if (path.includes('/public/') && c.req.method === 'GET') {
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

    // Try dev token (unsigned JWT) first
    const devPayload = await verifyToken(token);
    if (devPayload) {
      c.set('tokenPayload', devPayload);
      await next();
      return;
    }

    // Fall back to DB-backed OAuth token lookup
    const db = (c.env as any)?.DB;
    if (db && typeof db.prepare === 'function') {
      const row = await db.prepare(
        'SELECT * FROM oauth_tokens WHERE access_token = ? AND expires_at > ?'
      ).bind(token, Math.floor(Date.now() / 1000)).first() as any;

      if (row) {
        const payload: TokenPayload = {
          sub: row.user_id,
          scopes: row.scopes,
          iat: row.created_at,
          exp: row.expires_at,
        };
        c.set('tokenPayload', payload);
        await next();
        return;
      }
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

    if (!module || module === '*' || module === '..' || module === '.' || module.includes('..') || module.includes('/')) {
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
