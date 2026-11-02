import type { Context } from '../types';
import { isLocalDevelopment } from '../config';
import { securityEvent } from './security-log';

// Native Workers rate-limit bindings (see [[ratelimits]] in wrangler.toml).
// Counters are kept by Cloudflare per location — no KV reads or writes.
// These limits must match wrangler.toml; a test enforces it. They are
// duplicated here only because the binding does not expose its own limit,
// and X-RateLimit-Limit needs it. All are per IP, per minute:
// - STORAGE_LIMITER: failed storage authentication.
// - PUBLIC_LIMITER: public document reads without the Account's token. 300
//   (5/s) lets a page or app load a gallery of public files at once, while
//   one IP cannot burn through R2 reads and Worker requests unchecked.
// - TOKEN_LIMITER: every token endpoint request. An app redeems a code once
//   and refreshes at most hourly, so 20 leaves room for several apps behind
//   one address.
export const RATE_LIMIT_PERIOD_SECONDS = 60;
export const RATE_LIMITS = {
  STORAGE_LIMITER: 20,
  PUBLIC_LIMITER: 300,
  TOKEN_LIMITER: 20,
} as const;

export type RateLimiterName = keyof typeof RATE_LIMITS;

interface RateLimitOptions {
  limiter: RateLimiterName;
  key: string;
}

function getLimiter(c: Context, name: RateLimiterName): RateLimit | null {
  const binding = c.env?.[name];
  return binding && typeof binding.limit === 'function' ? binding : null;
}

// Returns a 503 when the limiter is missing in production (fail closed), and
// null when it is present or local development may run without it.
export function rateLimiterUnavailable(c: Context, name: RateLimiterName): Response | null {
  if (getLimiter(c, name) || isLocalDevelopment(c.env)) return null;
  return c.text('Rate limiting is not configured', 503);
}

// Counts one attempt against `key`. Returns a 429 once over budget, a 503 when
// the limiter is missing in production, and null when the request may proceed.
export async function enforceRateLimit(c: Context, options: RateLimitOptions): Promise<Response | null> {
  const limiter = getLimiter(c, options.limiter);
  if (!limiter) return rateLimiterUnavailable(c, options.limiter);

  const { success } = await limiter.limit({ key: options.key });
  if (success) return null;

  securityEvent(c, 'rate_limit.exceeded', { limiter: options.limiter });
  return c.text('Rate limit exceeded', 429, {
    'Retry-After': RATE_LIMIT_PERIOD_SECONDS.toString(),
    'X-RateLimit-Limit': RATE_LIMITS[options.limiter].toString(),
    'X-RateLimit-Remaining': '0',
  });
}
