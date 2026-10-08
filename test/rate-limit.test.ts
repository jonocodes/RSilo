import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createServer } from '../src/index';
import { seedToken } from './helpers/tokens';
import { PRODUCTION_INSTANCE } from './helpers/instance';
import { RATE_LIMITS, RATE_LIMIT_PERIOD_SECONDS } from '../src/services/rate-limit';

// Mirrors the native Workers rate-limit binding: limit() counts the call and
// reports whether the key is still within its budget.
function fakeLimiter(max: number) {
  const counts = new Map<string, number>();
  return {
    keys: counts,
    async limit({ key }: { key: string }) {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= max };
    },
  };
}

const storage = new Map<string, { body: ArrayBuffer; etag: string }>();
const mockStorage = {
  async get(key: string) {
    const item = storage.get(key);
    return item ? { body: item.body, metadata: { contentType: 'text/plain', contentLength: item.body.byteLength, etag: item.etag } } : null;
  },
  async put(key: string, body: ArrayBuffer) {
    const etag = `"etag-${storage.size}"`;
    storage.set(key, { body, etag });
    return etag;
  },
  async delete(key: string) { storage.delete(key); },
  async head(key: string) {
    const item = storage.get(key);
    return item ? { contentType: 'text/plain', contentLength: item.body.byteLength, etag: item.etag } : null;
  },
  async list() { return { objects: [] }; },
} as any;

const db = {
  prepare: () => ({
    bind: () => ({ first: async () => null, run: async () => ({}), all: async () => ({ results: [] }) }),
  }),
} as any;

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    STORAGE: mockStorage,
    DB: db,
    STORAGE_LIMITER: fakeLimiter(RATE_LIMITS.STORAGE_LIMITER),
    ...overrides,
  } as any;
}

function storageGet(env: any, token: string, user = 'alice', ip = '203.0.113.20') {
  return createServer(env).request(`http://localhost/storage/${user}/documents/`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, 'CF-Connecting-IP': ip },
  }, env);
}

describe('storage rate limiting', () => {
  it('never throttles requests with a valid token, however many', async () => {
    const env = makeEnv();
    const token = seedToken(env, 'alice', '*:rw');
    for (let i = 0; i < RATE_LIMITS.STORAGE_LIMITER * 5; i++) {
      expect((await storageGet(env, token)).status).toBe(200);
    }
    expect(env.STORAGE_LIMITER.keys.size).toBe(0);
  });

  it('counts failed authentication and returns 429 once over budget', async () => {
    const env = makeEnv();
    for (let i = 0; i < RATE_LIMITS.STORAGE_LIMITER; i++) {
      expect((await storageGet(env, 'not-a-token')).status).toBe(401);
    }
    const blocked = await storageGet(env, 'not-a-token');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe(String(RATE_LIMIT_PERIOD_SECONDS));
    expect(blocked.headers.get('X-RateLimit-Limit')).toBe(String(RATE_LIMITS.STORAGE_LIMITER));
  });

  it('keys failed storage auth by IP only', async () => {
    const env = makeEnv();
    // Only the Account's paths reach auth, so the key carries no username.
    await storageGet(env, 'not-a-token', 'alice');
    await storageGet(env, 'not-a-token', 'alice');
    expect([...env.STORAGE_LIMITER.keys.entries()]).toEqual([['storage-auth:ip:203.0.113.20', 2]]);
  });

  it('fails closed in production when the storage limiter is missing', async () => {
    const env = makeEnv({ RSILO_DEV_MODE: 'false', ...PRODUCTION_INSTANCE, STORAGE_LIMITER: undefined });
    expect((await storageGet(env, 'not-a-token')).status).toBe(503);
  });
});

describe('wrangler.toml rate-limit bindings', () => {
  const toml = readFileSync('wrangler.toml', 'utf8');

  it('declares no KV namespace', () => {
    expect(toml).not.toContain('kv_namespaces');
    expect(toml).not.toContain('RATE_LIMIT_KV');
  });

  for (const [name, limit] of Object.entries(RATE_LIMITS)) {
    it(`declares ${name} matching the limit used in response headers`, () => {
      const block = toml.match(new RegExp(`\\[\\[ratelimits\\]\\]\\s*name\\s*=\\s*"${name}"[\\s\\S]*?simple\\s*=\\s*\\{([^}]*)\\}`));
      expect(block, `${name} binding missing from wrangler.toml`).toBeTruthy();
      expect(block![1]).toMatch(new RegExp(`limit\\s*=\\s*${limit}\\b`));
      expect(block![1]).toMatch(new RegExp(`period\\s*=\\s*${RATE_LIMIT_PERIOD_SECONDS}\\b`));
    });
  }

  it('declares no binding missing from RATE_LIMITS', () => {
    const declared = [...toml.matchAll(/\[\[ratelimits\]\]\s*name\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(declared.sort()).toEqual(Object.keys(RATE_LIMITS).sort());
  });
});
