import type { Context } from '../types';
import { isLocalDevelopment } from '../config';

interface RateLimitOptions {
  namespace: string;
  account?: string;
  maxAttempts?: number;
  windowSeconds?: number;
}

function trustedClientIp(c: Context): string {
  const cloudflareIp = c.req.header('CF-Connecting-IP');
  if (cloudflareIp) return cloudflareIp;
  if (isLocalDevelopment(c.env)) {
    return c.req.header('X-Forwarded-For')?.split(',')[0].trim() || 'local';
  }
  return 'unknown';
}

export async function enforceRateLimit(c: Context, options: RateLimitOptions): Promise<Response | null> {
  const kv = (c.env as any)?.RATE_LIMIT_KV;
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') {
    return isLocalDevelopment(c.env)
      ? null
      : c.text('Rate limiting is not configured', 503);
  }

  const maxAttempts = options.maxAttempts ?? 10;
  const windowSeconds = options.windowSeconds ?? 300;
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const account = options.account?.trim().toLowerCase() || '-';
  const key = `ratelimit:${options.namespace}:ip:${trustedClientIp(c)}:account:${account}`;
  const current = await kv.get(key, 'json') as { count: number; windowStart: number } | null;
  const inWindow = Boolean(current && current.windowStart > now - windowMs);

  if (inWindow && current!.count >= maxAttempts) {
    return c.text('Rate limit exceeded', 429, {
      'Retry-After': Math.max(1, Math.ceil((current!.windowStart + windowMs - now) / 1000)).toString(),
      'X-RateLimit-Limit': maxAttempts.toString(),
      'X-RateLimit-Remaining': '0',
    });
  }

  const count = inWindow ? current!.count + 1 : 1;
  const windowStart = inWindow ? current!.windowStart : now;
  await kv.put(key, JSON.stringify({ count, windowStart }), { expirationTtl: windowSeconds });
  return null;
}
