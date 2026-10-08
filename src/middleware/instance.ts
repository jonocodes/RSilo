import type { Context, Next } from '../types';
import { configurationMessage, getInstanceConfig, isLocalDevelopment } from '../config';
import type { InstanceConfig } from '../config';
import { ensureAccount, usernameMismatchMessage } from '../services/account';

declare module 'hono' {
  interface ContextVariableMap {
    instance: InstanceConfig;
  }
}

/** Resolves ACCOUNT_USERNAME / PUBLIC_BASE_URL, or answers 503 naming what is wrong. */
export function requireInstanceConfig() {
  return async (c: Context, next: Next) => {
    const result = getInstanceConfig(c.env);
    if ('problems' in result) return c.text(configurationMessage(result.problems), 503);
    c.set('instance', result.config);
    await next();
  };
}

/**
 * Ensures the Account row exists before a route that reads or writes it runs.
 * In the username-mismatch state the request is refused with 503 and a setup
 * message. Must run after requireInstanceConfig().
 */
export function requireAccountRow() {
  return async (c: Context, next: Next) => {
    const { accountUsername } = c.get('instance');
    const db = (c.env as any)?.DB;
    if (!db || typeof db.prepare !== 'function') {
      // Mirrors storage accounting: dev mode tolerates a missing database.
      if (isLocalDevelopment(c.env)) return next();
      return c.text('Server database is not configured', 503);
    }

    const status = await ensureAccount(db, accountUsername);
    if (status === 'username_mismatch') {
      return c.text(usernameMismatchMessage(accountUsername), 503);
    }
    await next();
  };
}

/**
 * 404s unless the route's username segment (`:user` for OAuth, `:username` for
 * storage) names the Account exactly, matching the canonical advertised URLs
 * (storage keys are case-sensitive). Other accounts'
 * rows, tokens and data are thereby unreachable. Must run after
 * requireInstanceConfig().
 */
export function requireAccountPath(param: 'user' | 'username' = 'user') {
  return async (c: Context, next: Next) => {
    const user = c.req.param(param);
    if (user !== c.get('instance').accountUsername) {
      return c.json({ error: 'not_found', error_description: 'Unknown account' }, 404);
    }
    await next();
  };
}
