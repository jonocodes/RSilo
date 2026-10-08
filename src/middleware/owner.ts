import type { Context, Next } from '../types';
import { isSameOriginRequest, resolveOwner } from '../services/identity';
import { finishSetupPage, forbiddenPage } from '../ui/setup-pages';

declare module 'hono' {
  interface ContextVariableMap {
    ownerEmail: string;
  }
}

const HTML = { 'Content-Type': 'text/html; charset=utf-8' };

/**
 * Admits only the Owner (services/identity.ts). Otherwise answers with the
 * finish-setup page (503) or the not-the-Owner page (403). Sets `instance` and
 * `ownerEmail` for later handlers.
 */
export function requireOwner() {
  return async (c: Context, next: Next) => {
    const result = await resolveOwner(c);
    if (result.status === 'not_configured') {
      return new Response(finishSetupPage(result.problems, new URL(c.req.url).host), { status: 503, headers: HTML });
    }
    if (result.status === 'forbidden') {
      return new Response(forbiddenPage(result.email), { status: 403, headers: HTML });
    }
    c.set('instance', result.config);
    c.set('ownerEmail', result.email);
    await next();
  };
}

/**
 * Rejects cross-site state changes: every request other than GET/HEAD must be
 * same-origin (services/identity.ts isSameOriginRequest). Must run after
 * requireOwner() or requireInstanceConfig().
 */
export function requireSameOrigin() {
  return async (c: Context, next: Next) => {
    const method = c.req.method;
    if (method !== 'GET' && method !== 'HEAD' && !isSameOriginRequest(c, c.get('instance').publicBaseUrl)) {
      return c.text('Cross-site request refused', 403);
    }
    await next();
  };
}
