import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createServer } from '../src/index';
import { seedToken } from './helpers/tokens';
import { PRODUCTION_INSTANCE } from './helpers/instance';
import { RATE_LIMITS, RATE_LIMIT_PERIOD_SECONDS } from '../src/services/rate-limit';
import { createSqliteD1 } from '../src/services/db/sqlite';
import { MemoryStorage } from './helpers/memory-storage';

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

const storage = new MemoryStorage();

const db = createSqliteD1();

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    STORAGE: storage,
    DB: db,
    STORAGE_LIMITER: fakeLimiter(RATE_LIMITS.STORAGE_LIMITER),
    PUBLIC_LIMITER: fakeLimiter(RATE_LIMITS.PUBLIC_LIMITER),
    TOKEN_LIMITER: fakeLimiter(RATE_LIMITS.TOKEN_LIMITER),
    ...overrides,
  };
}

const PUBLIC_DOC = 'http://localhost/storage/alice/public/documents/shared.txt';

async function seedPublicDocument(env: ReturnType<typeof makeEnv>) {
  const res = await createServer(env).request(PUBLIC_DOC, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${seedToken(env, 'alice', 'documents:rw')}`, 'Content-Type': 'text/plain' },
    body: 'shared',
  }, env);
  expect(res.status).toBeOneOf([200, 201]);
}

function publicRead(env: ReturnType<typeof makeEnv>, headers: Record<string, string> = {}, method = 'GET') {
  return createServer(env).request(PUBLIC_DOC, { method, headers: { 'CF-Connecting-IP': '203.0.113.30', ...headers } }, env);
}

function tokenRequest(env: ReturnType<typeof makeEnv>, ip = '203.0.113.40') {
  return createServer(env).request('http://localhost/oauth/alice/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': ip },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'not-a-refresh-token' }).toString(),
  }, env);
}

function storageGet(env: ReturnType<typeof makeEnv>, token: string, user = 'alice', ip = '203.0.113.20') {
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

describe('public document rate limiting', () => {
  it('counts anonymous reads by IP and returns 429 once over budget', async () => {
    const env = makeEnv();
    await seedPublicDocument(env);
    for (let i = 0; i < RATE_LIMITS.PUBLIC_LIMITER; i++) {
      expect((await publicRead(env, {}, i % 2 ? 'HEAD' : 'GET')).status).toBe(200);
    }
    const blocked = await publicRead(env);
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).toBe('Rate limit exceeded');
    expect(blocked.headers.get('Retry-After')).toBe(String(RATE_LIMIT_PERIOD_SECONDS));
    expect(blocked.headers.get('X-RateLimit-Limit')).toBe(String(RATE_LIMITS.PUBLIC_LIMITER));
    expect([...env.PUBLIC_LIMITER.keys.keys()]).toEqual(['public-read:ip:203.0.113.30']);
  });

  it('never counts reads with a valid token for the Account', async () => {
    const env = makeEnv();
    await seedPublicDocument(env);
    const token = seedToken(env, 'alice', 'documents:r');
    expect((await publicRead(env, { Authorization: `Bearer ${token}` })).status).toBe(200);
    expect(env.PUBLIC_LIMITER.keys.size).toBe(0);
  });

  it('counts reads with an invalid or another account\'s token as anonymous', async () => {
    const env = makeEnv();
    await seedPublicDocument(env);
    expect((await publicRead(env, { Authorization: 'Bearer not-a-token' })).status).toBe(200);
    expect((await publicRead(env, { Authorization: `Bearer ${seedToken(env, 'bob', '*:rw')}` })).status).toBe(200);
    expect(env.PUBLIC_LIMITER.keys.get('public-read:ip:203.0.113.30')).toBe(2);
  });

  it('does not count public folder listings (they need a token) or private paths', async () => {
    const env = makeEnv();
    const app = createServer(env);
    await app.request('http://localhost/storage/alice/public/documents/', { headers: { 'CF-Connecting-IP': '203.0.113.30' } }, env);
    await app.request('http://localhost/storage/alice/documents/a.txt', { headers: { 'CF-Connecting-IP': '203.0.113.30' } }, env);
    expect(env.PUBLIC_LIMITER.keys.size).toBe(0);
  });

  it('fails closed in production when the public limiter is missing', async () => {
    const env = makeEnv({ RSILO_DEV_MODE: 'false', ...PRODUCTION_INSTANCE, PUBLIC_LIMITER: undefined });
    await seedPublicDocument(env);
    expect((await publicRead(env)).status).toBe(503);
  });
});

describe('token endpoint rate limiting', () => {
  it('counts every request by IP and returns 429 once over budget', async () => {
    const env = makeEnv();
    for (let i = 0; i < RATE_LIMITS.TOKEN_LIMITER; i++) {
      expect((await tokenRequest(env)).status).toBe(400);
    }
    const blocked = await tokenRequest(env);
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).toBe('Rate limit exceeded');
    expect(blocked.headers.get('Retry-After')).toBe(String(RATE_LIMIT_PERIOD_SECONDS));
    expect(blocked.headers.get('X-RateLimit-Limit')).toBe(String(RATE_LIMITS.TOKEN_LIMITER));
    expect((await tokenRequest(env, '203.0.113.41')).status).toBe(400);
    expect([...env.TOKEN_LIMITER.keys.keys()]).toEqual(['token:ip:203.0.113.40', 'token:ip:203.0.113.41']);
  });

  it('fails closed in production when the token limiter is missing', async () => {
    const env = makeEnv({ RSILO_DEV_MODE: 'false', ...PRODUCTION_INSTANCE, TOKEN_LIMITER: undefined });
    expect((await tokenRequest(env)).status).toBe(503);
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

  it('gives each binding its own namespace_id, so their counters stay apart', () => {
    const ids = [...toml.matchAll(/namespace_id\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(Object.keys(RATE_LIMITS).length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('declares no binding missing from RATE_LIMITS', () => {
    const declared = [...toml.matchAll(/\[\[ratelimits\]\]\s*name\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(declared.sort()).toEqual(Object.keys(RATE_LIMITS).sort());
  });
});
