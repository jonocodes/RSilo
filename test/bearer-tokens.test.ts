import { describe, it, expect } from 'vitest';
import { createServer } from '../src/index';
import { seedToken, deleteToken } from './helpers/tokens';

// ADR-0003: storage accepts only opaque bearer tokens stored in oauth_tokens.

function createStorage() {
  const objects = new Map<string, { body: ArrayBuffer; contentType: string }>();
  return {
    async get(key: string) {
      const item = objects.get(key);
      if (!item) return null;
      return { body: item.body, metadata: { contentType: item.contentType, contentLength: item.body.byteLength, etag: '"etag"' } };
    },
    async put(key: string, body: ArrayBuffer, contentType?: string) {
      objects.set(key, { body, contentType: contentType || 'application/octet-stream' });
      return '"etag"';
    },
    async delete(key: string) { objects.delete(key); },
    async head(key: string) {
      const item = objects.get(key);
      if (!item) return null;
      return { etag: '"etag"', contentType: item.contentType, contentLength: item.body.byteLength };
    },
    async list() { return { objects: [] }; },
  } as any;
}

// Production mode fails closed without a rate-limit binding.
const allowAll = { limit: async () => ({ success: true }) };

function createEnv(overrides: Record<string, unknown> = {}) {
  return { STORAGE: createStorage(), DB: {} as any, ...overrides };
}

function base64Url(input: string | ArrayBuffer): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  return Buffer.from(bytes).toString('base64url');
}

function jwtPayload(username: string): string {
  const now = Math.floor(Date.now() / 1000);
  return base64Url(JSON.stringify({ sub: username, scopes: '*:rw', iat: now, exp: now + 3600 }));
}

function unsignedJwt(username: string): string {
  return `${base64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${jwtPayload(username)}.`;
}

async function signedJwt(username: string, secret: string): Promise<string> {
  const signingInput = `${base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${jwtPayload(username)}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64Url(signature)}`;
}

async function getDocument(env: any, token: string) {
  const app = createServer(env);
  return app.request(
    'http://localhost/storage/alice/documents/note.txt',
    { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
    env,
  );
}

function expectInvalidToken(res: Response) {
  expect(res.status).toBe(401);
  expect(res.headers.get('WWW-Authenticate')).toContain('error="invalid_token"');
}

describe('Opaque bearer tokens', () => {
  it('authorizes a request with a seeded token row', async () => {
    const env = createEnv();
    const token = seedToken(env, 'alice', 'documents:rw');

    const res = await getDocument(env, token);

    expect(res.status).toBe(404);
  });

  it('authorizes a seeded token row in production mode without any secret', async () => {
    const env = createEnv({ RSILO_DEV_MODE: 'false', STORAGE_LIMITER: allowAll });
    const token = seedToken(env, 'alice', 'documents:rw');

    const res = await getDocument(env, token);

    expect(res.status).toBe(404);
  });

  it('rejects an expired token row', async () => {
    const env = createEnv();
    const token = seedToken(env, 'alice', 'documents:rw', { expiresAt: Math.floor(Date.now() / 1000) - 1 });

    expectInvalidToken(await getDocument(env, token));
  });

  it('revokes a token as soon as its row is deleted', async () => {
    const env = createEnv();
    const token = seedToken(env, 'alice', 'documents:rw');
    expect((await getDocument(env, token)).status).toBe(404);

    deleteToken(env, token);

    expectInvalidToken(await getDocument(env, token));
  });

  it('rejects an alg:none JWT in dev mode', async () => {
    const env = createEnv({ RSILO_DEV_MODE: 'true' });
    seedToken(env, 'alice', 'documents:rw');

    expectInvalidToken(await getDocument(env, unsignedJwt('alice')));
  });

  it('rejects a signed JWT in dev mode, even with JWT_SECRET set', async () => {
    const env = createEnv({ RSILO_DEV_MODE: 'true', JWT_SECRET: 'jwt-secret' });
    seedToken(env, 'alice', 'documents:rw');

    expectInvalidToken(await getDocument(env, await signedJwt('alice', 'jwt-secret')));
  });

  it('rejects a signed JWT in production mode, even with JWT_SECRET set', async () => {
    const env = createEnv({ RSILO_DEV_MODE: 'false', STORAGE_LIMITER: allowAll, JWT_SECRET: 'jwt-secret' });
    seedToken(env, 'alice', 'documents:rw');

    expectInvalidToken(await getDocument(env, await signedJwt('alice', 'jwt-secret')));
  });

  it('returns 503 when the DB binding is missing', async () => {
    const env = { STORAGE: createStorage(), RSILO_DEV_MODE: 'false' };

    const res = await getDocument(env, 'anything');

    expect(res.status).toBe(503);
  });
});
