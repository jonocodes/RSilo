import type { Context } from '../types';
import { isLocalDevelopment } from '../config';

// Native Workers rate-limit bindings (see [[ratelimits]] in wrangler.toml).
// Counters are kept by Cloudflare per location — no KV reads or writes.
// These limits must match wrangler.toml; a test enforces it. They are
// duplicated here only because the binding does not expose its own limit,
// and X-RateLimit-Limit needs it.
export const RATE_LIMIT_PERIOD_SECONDS = 60;
export const RATE_LIMITS = {
  STORAGE_LIMITER: 20,
} as const;

export type RateLimiterName = keyof typeof RATE_LIMITS;

interface RateLimitOptions {
  limiter: RateLimiterName;
  key: string;
}

export function trustedClientIp(c: Context): string {
  const cloudflareIp = c.req.header('CF-Connecting-IP');
  if (cloudflareIp) return cloudflareIp;
  if (isLocalDevelopment(c.env)) {
    return c.req.header('X-Forwarded-For')?.split(',')[0].trim() || 'local';
  }
  return 'unknown';
}

function getLimiter(c: Context, name: RateLimiterName): RateLimit | null {
  const binding = (c.env as any)?.[name];
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

  return c.text('Rate limit exceeded', 429, {
    'Retry-After': RATE_LIMIT_PERIOD_SECONDS.toString(),
    'X-RateLimit-Limit': RATE_LIMITS[options.limiter].toString(),
    'X-RateLimit-Remaining': '0',
  });
}
