import { describe, it, expect } from 'vitest';
import { createServer } from '../src/index';
import { seedToken } from './helpers/tokens';
import { createSqliteD1 } from '../src/services/db/sqlite';
import { MemoryStorage } from './helpers/memory-storage';

function createTestEnv() {
  return {
    STORAGE: new MemoryStorage(),
    DB: createSqliteD1(),
  };
}

describe('Security Tests', () => {
  describe('Path Traversal Attacks', () => {
    it('rejects path with .. segments', async () => {
      const env = createTestEnv();
      const app = createServer(env);
      const token = seedToken(env, 'alice', 'documents:rw');

      const res = await app.request(
        'http://localhost/storage/alice/../bob/documents/test.txt',
        { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
        env
      );

      expect([400, 403, 404]).toContain(res.status);
    });

    it('rejects user impersonation via path', async () => {
      const env = createTestEnv();
      const app = createServer(env);
      // A token whose subject is not the Account (e.g. a pre-migration token).
      const token = seedToken(env, 'bob', 'documents:rw');

      const res = await app.request(
        'http://localhost/storage/alice/documents/test.txt',
        { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
        env
      );

      expect(res.status).toBe(403);
    });

    it('does not reveal storage of users other than the Account', async () => {
      const env = createTestEnv();
      const app = createServer(env);
      const token = seedToken(env, 'alice', 'documents:rw');

      const res = await app.request(
        'http://localhost/storage/bob/documents/test.txt',
        { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
        env
      );

      expect(res.status).toBe(403);
    });
  });

  describe('Scope Security', () => {
    it('rejects read-only scope for write operation', async () => {
      const env = createTestEnv();
      const app = createServer(env);
      const token = seedToken(env, 'alice', 'documents:r');

      const res = await app.request(
        'http://localhost/storage/alice/documents/test.txt',
        { 
          method: 'PUT', 
          headers: { 
            Authorization: `Bearer ${token}`,
            'Content-Type': 'text/plain'
          },
          body: 'test'
        },
        env
      );

      expect(res.status).toBe(403);
    });

    it('rejects module scope bypass', async () => {
      const env = createTestEnv();
      const app = createServer(env);
      const token = seedToken(env, 'alice', 'documents:rw');

      const res = await app.request(
        'http://localhost/storage/alice/pictures/test.txt',
        { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
        env
      );

      expect(res.status).toBe(403);
    });
  });

  describe('Quota Enforcement', () => {
    it('rejects PUT when quota exceeded', async () => {
    const env = {
      STORAGE: new MemoryStorage(),
      DB: createSqliteD1(),
      ACCOUNT_USERNAME: 'quotauser',
    };
    const app = createServer(env);
    const token = seedToken(env, 'quotauser', 'documents:rw');
    env.DB.sqlite.prepare('UPDATE users SET storage_quota_bytes = 10, used_storage_bytes = 9 WHERE username = ?').run('quotauser');

      const res = await app.request(
        'http://localhost/storage/quotauser/documents/large.txt',
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
          body: 'This content exceeds quota',
        },
        env
      );

      expect(res.status).toBe(413);
      expect(await res.text()).toContain('quota');
    });
  });
});
