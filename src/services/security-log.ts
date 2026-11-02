import type { Context } from '../types';
import { isLocalDevelopment } from '../config';

// Security events, one JSON object per line on console.log: Workers Logs
// indexes the fields, and `wrangler tail` shows them live. Only refusals and
// grants are logged, never a successful storage request. Callers must never
// pass a secret: no tokens, codes, code_verifiers, Authorization headers or
// document contents.
export type SecurityEvent =
  | 'storage.auth_denied'
  | 'rate_limit.exceeded'
  | 'oauth.consent_approved'
  | 'oauth.consent_denied'
  | 'oauth.token_issued'
  | 'oauth.token_refreshed'
  | 'oauth.invalid_grant'
  | 'account.app_revoked'
  | 'account.owner_rejected';

/** The client's IP as Cloudflare reports it; rate limits and security logs key on it. */
export function trustedClientIp(c: Context): string {
  const cloudflareIp = c.req.header('CF-Connecting-IP');
  if (cloudflareIp) return cloudflareIp;
  if (isLocalDevelopment(c.env)) {
    return c.req.header('X-Forwarded-For')?.split(',')[0].trim() || 'local';
  }
  return 'unknown';
}

export function securityEvent(c: Context, event: SecurityEvent, fields: Record<string, string | number | null> = {}): void {
  console.log(JSON.stringify({ event, ip: trustedClientIp(c), method: c.req.method, path: c.req.path, ...fields }));
}
