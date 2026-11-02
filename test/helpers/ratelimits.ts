import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { RATE_LIMITS } from '../../src/services/rate-limit';
import { rateLimitBindings } from '../../src/scripts/setup-config';

// Production fails closed (503) without a limiter binding, so every config a
// deploy generates must carry the committed [[ratelimits]] tables unchanged.
const tables = (toml: string) => toml.match(/\[\[ratelimits\]\][^[]*/g)?.map((t) => t.trim()) ?? [];

export function expectEveryRateLimiter(toml: string): void {
  expect(rateLimitBindings(toml).sort()).toEqual(Object.keys(RATE_LIMITS).sort());
  expect(tables(toml)).toEqual(tables(readFileSync('wrangler.toml', 'utf8')));
}
