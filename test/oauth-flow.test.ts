import { describe, it, expect } from 'vitest';
import { createServer, createTestToken } from '../src/index';

function createTestEnv() {
  return {
    STORAGE: {
      async get() { return null; },
      async put() { return '"test"'; },
      async delete() {},
      async head() { return null; },
      async list() { return { objects: [] }; },
    } as any,
    DB: {
      prepare: (query: string) => ({
        bind: () => ({
          first: async () => {
            if (query.includes('SELECT * FROM oauth_codes')) {
              return { 
                code: 'valid-code',
                user_id: '1',
                client_id: 'test-client',
                redirect_uri: 'http://localhost/callback',
                scopes: 'documents:rw',
                expires_at: Date.now() + 600000
              };
            }
            if (query.includes('SELECT * FROM oauth_tokens')) {
              return {
                id: 'token-1',
                user_id: '1',
                client_id: 'test-client',
                scopes: 'documents:rw',
                refresh_token: 'refresh-123',
                expires_at: Date.now() + 3600000
              };
            }
            if (query.includes('SELECT * FROM users')) {
              return { id: '1', username: 'alice', created_at: Date.now() };
            }
            return null;
          },
          run: async () => ({ success: true, changes: 1 }),
        }),
        first: async () => null,
        run: async () => ({ success: true }),
        all: async () => ({ results: [] }),
      }),
    } as any,
  };
}

describe('OAuth Flow Tests', () => {
  describe('Authorization Code Flow', () => {
    it('handles valid authorization code exchange', async () => {
      const env = createTestEnv();
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/oauth/alice/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: 'valid-code',
            redirect_uri: 'http://localhost/callback',
            client_id: 'test-client',
          }).toString(),
        },
        env
      );

      expect(res.status).toBe(200);
    });

    it('handles expired authorization code', async () => {
      const env = createTestEnv();
      const app = createServer(env);

      env.DB.prepare = (_query: string) => ({
        bind: () => ({
          first: async () => null,
          run: async () => ({ success: true }),
        }),
        first: async () => null,
        run: async () => ({ success: true }),
        all: async () => ({ results: [] }),
      });

      const res = await app.request(
        'http://localhost/oauth/alice/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: 'expired-code',
            redirect_uri: 'http://localhost/callback',
            client_id: 'test-client',
          }).toString(),
        },
        env
      );

      expect(res.status).toBe(400);
    });

    it('rejects mismatched redirect_uri', async () => {
      const env = createTestEnv();
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/oauth/alice/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: 'valid-code',
            redirect_uri: 'http://evil.com/callback',
            client_id: 'test-client',
          }).toString(),
        },
        env
      );

      expect(res.status).toBe(400);
    });

    it('handles refresh_token grant', async () => {
      const env = createTestEnv();
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/oauth/alice/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: 'refresh-123',
            client_id: 'test-client',
          }).toString(),
        },
        env
      );

      expect(res.status).toBe(200);
    });
  });

  describe('OAuth Error Cases', () => {
    it('handles missing required parameters', async () => {
      const env = createTestEnv();
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/oauth/alice/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
          }).toString(),
        },
        env
      );

      expect(res.status).toBe(400);
    });

    it('handles non-existent user', async () => {
      const env = createTestEnv();
      const app = createServer(env);

      env.DB.prepare = (_query: string) => ({
        bind: () => ({
          first: async () => null,
          run: async () => ({ success: true }),
        }),
        first: async () => null,
        run: async () => ({ success: true }),
        all: async () => ({ results: [] }),
      });

      const res = await app.request(
        'http://localhost/oauth/nonexistent/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: 'valid-code',
            redirect_uri: 'http://localhost/callback',
            client_id: 'test-client',
          }).toString(),
        },
        env
      );

      expect(res.status).toBe(400);
    });
  });

  describe('OAuth CORS', () => {
    it('includes CORS headers on OAuth endpoints', async () => {
      const env = createTestEnv();
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/oauth/alice/token',
        {
          method: 'OPTIONS',
          headers: {
            'Origin': 'http://example.com',
            'Access-Control-Request-Method': 'POST',
          },
        },
        env
      );

      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://example.com');
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    });
  });

  describe('OAuth Discovery', () => {
    it('returns OAuth discovery document', async () => {
      const env = createTestEnv();
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/oauth/alice',
        { method: 'GET' },
        env
      );

      expect(res.status).toBe(200);
    });
  });
});

describe('Database Error Handling', () => {
  it('handles database connection failure gracefully', async () => {
    const env = {
      STORAGE: {
        async get() { return null; },
        async put() { return '"test"'; },
        async delete() {},
        async head() { return null; },
        async list() { return { objects: [] }; },
      } as any,
      DB: {
        prepare: () => {
          throw new Error('Database connection failed');
        },
      } as any,
    };
    const app = createServer(env);
    const token = createTestToken('alice', '*:rw');

    const res = await app.request(
      'http://localhost/storage/alice/documents/test.txt',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(res.status).toBe(500);
  });
});

describe('Storage Error Handling', () => {
  it('handles storage get failure', async () => {
    const env = {
      STORAGE: {
        async get() { throw new Error('Storage get failed'); },
        async put() { return '"test"'; },
        async delete() {},
        async head() { return null; },
        async list() { return { objects: [] }; },
      } as any,
      DB: {} as any,
    };
    const app = createServer(env);
    const token = createTestToken('alice', '*:rw');

    const res = await app.request(
      'http://localhost/storage/alice/documents/test.txt',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env
    );
    expect(res.status).toBe(500);
  });
});
