import type { KVNamespace } from '@cloudflare/workers-types';

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

export class RateLimiter {
  constructor(private kv: KVNamespace, private config: RateLimitConfig) {}

  async isAllowed(identifier: string): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    const key = `ratelimit:${identifier}`;

    const current = await this.kv.get(key, 'json') as { count: number; windowStart: number } | null;

    if (!current || current.windowStart < windowStart) {
      await this.kv.put(key, JSON.stringify({ count: 1, windowStart: now }), { expirationTtl: Math.ceil(this.config.windowMs / 1000) });
      return { allowed: true, remaining: this.config.maxRequests - 1, resetAt: now + this.config.windowMs };
    }

    if (current.count >= this.config.maxRequests) {
      return { allowed: false, remaining: 0, resetAt: current.windowStart + this.config.windowMs };
    }

    await this.kv.put(key, JSON.stringify({ count: current.count + 1, windowStart: current.windowStart }), { expirationTtl: Math.ceil(this.config.windowMs / 1000) });

    return {
      allowed: true,
      remaining: this.config.maxRequests - current.count - 1,
      resetAt: current.windowStart + this.config.windowMs
    };
  }

  getLimitInfo(resetAt: number): { 'Retry-After': string; 'X-RateLimit-Limit': string; 'X-RateLimit-Remaining': string } {
    return {
      'Retry-After': Math.ceil((resetAt - Date.now()) / 1000).toString(),
      'X-RateLimit-Limit': this.config.maxRequests.toString(),
      'X-RateLimit-Remaining': '0',
    };
  }
}

export function createRateLimiter(kv: KVNamespace, maxRequests = 100, windowMs = 60000): RateLimiter {
  return new RateLimiter(kv, { maxRequests, windowMs });
}