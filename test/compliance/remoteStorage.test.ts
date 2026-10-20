import { describe, it, expect } from 'vitest';
import { createServer } from '../../src/index';
import { seedToken } from '../helpers/tokens';
import { createSqliteD1 } from '../../src/services/db/sqlite';
import { PRODUCTION_INSTANCE } from '../helpers/instance';
import { MemoryStorage } from '../helpers/memory-storage';

function createEnv(storage: MemoryStorage) {
  return {
    STORAGE: storage,
    DB: createSqliteD1(),
  };
}

describe('RemoteStorage Protocol Compliance', () => {
  describe('Section 2: Storage API', () => {
    describe('GET', () => {
      it('returns 200 with body for existing file', async () => {
        const storage = new MemoryStorage();
        const env = createEnv(storage);
        const app = createServer(env);
        const token = seedToken(env, 'alice');

        storage.seed('users/alice/storage/documents/test.txt', 'hello');

        const res = await app.request(
          'http://localhost/storage/alice/documents/test.txt',
          { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
          env
        );

        expect(res.status).toBe(200);
        expect(await res.text()).toBe('hello');
      });

      it('returns 503 when the DB binding is missing in production mode', async () => {
        const storage = new MemoryStorage();
        const env = { STORAGE: storage, RSILO_DEV_MODE: 'false', ...PRODUCTION_INSTANCE };
        const app = createServer(env);
        const token = 'opaque-token';

        const res = await app.request(
          'http://localhost/storage/alice/documents/test.txt',
          { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
          env
        );

        expect(res.status).toBe(503);
      });

      it('returns 404 for non-existent file', async () => {
        const storage = new MemoryStorage();
        const env = createEnv(storage);
        const app = createServer(env);
        const token = seedToken(env, 'alice');

        const res = await app.request(
          'http://localhost/storage/alice/documents/does-not-exist.txt',
          { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
          env
        );

        expect(res.status).toBe(404);
      });

      it('returns Content-Type header', async () => {
        const storage = new MemoryStorage();
        const env = createEnv(storage);
        const app = createServer(env);
        const token = seedToken(env, 'alice');

        storage.seed('users/alice/storage/pictures/photo.jpg', new Uint8Array(10), 'image/jpeg');

        const res = await app.request(
          'http://localhost/storage/alice/pictures/photo.jpg',
          { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
          env
        );

        expect(res.headers.get('Content-Type')).toBe('image/jpeg');
      });

      it('returns Content-Length header', async () => {
        const storage = new MemoryStorage();
        const env = createEnv(storage);
        const app = createServer(env);
        const token = seedToken(env, 'alice');
        const content = 'Hello, World!';
        storage.seed('users/alice/storage/documents/test.txt', content);

        const res = await app.request(
          'http://localhost/storage/alice/documents/test.txt',
          { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
          env
        );

        expect(res.headers.get('Content-Length')).toBe(content.length.toString());
      });

      it('returns ETag header', async () => {
        const storage = new MemoryStorage();
        const env = createEnv(storage);
        const app = createServer(env);
        const token = seedToken(env, 'alice');

        storage.seed('users/alice/storage/documents/test.txt', 'test');

        const res = await app.request(
          'http://localhost/storage/alice/documents/test.txt',
          { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
          env
        );

        const etag = res.headers.get('ETag');
        expect(etag).toMatch(/^"[^"]+"$/);
      });
    });

    describe('PUT', () => {
      it('creates new resource with 201', async () => {
        const storage = new MemoryStorage();
        const env = createEnv(storage);
        const app = createServer(env);
        const token = seedToken(env, 'alice');

        const res = await app.request(
          'http://localhost/storage/alice/documents/new.txt',
          { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: 'new content' },
          env
        );

        expect(res.status).toBeOneOf([200, 201]);
      });

      it('updates existing resource with 200', async () => {
        const storage = new MemoryStorage();
        const env = createEnv(storage);
        const app = createServer(env);
        const token = seedToken(env, 'alice');

        storage.seed('users/alice/storage/documents/existing.txt', 'original');

        const res = await app.request(
          'http://localhost/storage/alice/documents/existing.txt',
          { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: 'updated' },
          env
        );

        expect(res.status).toBe(200);
      });

      it('returns ETag on PUT', async () => {
        const storage = new MemoryStorage();
        const env = createEnv(storage);
        const app = createServer(env);
        const token = seedToken(env, 'alice');

        const res = await app.request(
          'http://localhost/storage/alice/documents/etag-test.txt',
          { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: 'content' },
          env
        );

        expect(res.headers.get('ETag')).toMatch(/^"[^"]+"$/);
      });

      it('returns 401 without authorization', async () => {
        const storage = new MemoryStorage();
        const env = createEnv(storage);
        const app = createServer(env);

        const res = await app.request(
          'http://localhost/storage/alice/documents/test.txt',
          { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'content' },
          env
        );

        expect(res.status).toBe(401);
        expect(res.headers.get('WWW-Authenticate')).toMatch(/^Bearer/);
      });

      it('returns 400 for folder path', async () => {
        const storage = new MemoryStorage();
        const env = createEnv(storage);
        const app = createServer(env);
        const token = seedToken(env, 'alice');

        const res = await app.request(
          'http://localhost/storage/alice/documents/folder/',
          { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: 'content' },
          env
        );

        expect(res.status).toBe(400);
      });

      it('If-None-Match: * prevents overwrite of existing', async () => {
        const storage = new MemoryStorage();
        const env = createEnv(storage);
        const app = createServer(env);
        const token = seedToken(env, 'alice');

        storage.seed('users/alice/storage/documents/immutable.txt', 'original');

        const res = await app.request(
          'http://localhost/storage/alice/documents/immutable.txt',
          { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain', 'If-None-Match': '*' }, body: 'new content' },
          env
        );

        expect(res.status).toBe(412);
      });

      it('If-Match succeeds with correct ETag', async () => {
        const storage = new MemoryStorage();
        const env = createEnv(storage);
        const app = createServer(env);
        const token = seedToken(env, 'alice');

        storage.seed('users/alice/storage/documents/match-test.txt', 'original');

        const headRes = await storage.head('users/alice/storage/documents/match-test.txt');
        const etag = headRes!.etag;

        const res = await app.request(
          'http://localhost/storage/alice/documents/match-test.txt',
          { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain', 'If-Match': etag }, body: 'updated' },
          env
        );

        expect(res.status).toBeOneOf([200, 201]);
      });
    });

    describe('DELETE', () => {
      it('deletes existing file and returns 200', async () => {
        const storage = new MemoryStorage();
        const env = createEnv(storage);
        const app = createServer(env);
        const token = seedToken(env, 'alice');

        storage.seed('users/alice/storage/documents/to-delete.txt', 'delete me');

        const res = await app.request(
          'http://localhost/storage/alice/documents/to-delete.txt',
          { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
          env
        );

        expect(res.status).toBe(200);
      });

      it('returns 404 when deleting non-existent', async () => {
        const storage = new MemoryStorage();
        const env = createEnv(storage);
        const app = createServer(env);
        const token = seedToken(env, 'alice');

        const res = await app.request(
          'http://localhost/storage/alice/documents/never-existed.txt',
          { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
          env
        );

        expect(res.status).toBe(404);
      });

      it('returns 400 for folder path', async () => {
        const storage = new MemoryStorage();
        const env = createEnv(storage);
        const app = createServer(env);
        const token = seedToken(env, 'alice');

        const res = await app.request(
          'http://localhost/storage/alice/documents/folder/',
          { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
          env
        );

        expect(res.status).toBe(400);
      });
    });

    describe('HEAD', () => {
      it('returns headers without body', async () => {
        const storage = new MemoryStorage();
        const env = createEnv(storage);
        const app = createServer(env);
        const token = seedToken(env, 'alice');

        storage.seed('users/alice/storage/documents/head-test.txt', 'content');

        const res = await app.request(
          'http://localhost/storage/alice/documents/head-test.txt',
          { method: 'HEAD', headers: { Authorization: `Bearer ${token}` } },
          env
        );

        expect(res.status).toBe(200);
        expect(await res.text()).toBe('');
        expect(res.headers.get('ETag')).toBeTruthy();
        expect(res.headers.get('Content-Type')).toBe('text/plain');
      });

      it('returns 404 for non-existent', async () => {
        const storage = new MemoryStorage();
        const env = createEnv(storage);
        const app = createServer(env);
        const token = seedToken(env, 'alice');

        const res = await app.request(
          'http://localhost/storage/alice/documents/does-not-exist.txt',
          { method: 'HEAD', headers: { Authorization: `Bearer ${token}` } },
          env
        );

        expect(res.status).toBe(404);
      });
    });
  });

  describe('Section 3: Folder Listing', () => {
    it('returns JSON-LD with @context', async () => {
      const storage = new MemoryStorage();
      const env = createEnv(storage);
      const app = createServer(env);
      const token = seedToken(env, 'alice');

      storage.seed('users/alice/storage/documents/file1.txt', 'content');

      const res = await app.request(
        'http://localhost/storage/alice/documents/',
        { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
        env
      );

      const json = await res.json() as any;
      expect(json['@context']).toBeTruthy();
      expect(json.items).toBeDefined();
    });

    it('returns items with ETag', async () => {
      const storage = new MemoryStorage();
      const env = createEnv(storage);
      const app = createServer(env);
      const token = seedToken(env, 'alice');

      storage.seed('users/alice/storage/documents/file1.txt', 'content');

      const res = await app.request(
        'http://localhost/storage/alice/documents/',
        { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
        env
      );

      const json = await res.json() as any;
      expect(json.items['file1.txt']).toBeDefined();
      expect(json.items['file1.txt'].ETag).toBeDefined();
    });

    it('shows nested folders with trailing slash', async () => {
      const storage = new MemoryStorage();
      const env = createEnv(storage);
      const app = createServer(env);
      const token = seedToken(env, 'alice');

      storage.seed('users/alice/storage/documents/subfolder/file.txt', 'content');

      const res = await app.request(
        'http://localhost/storage/alice/documents/',
        { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
        env
      );

      const json = await res.json() as any;
      expect(json.items['subfolder/']).toBeDefined();
      expect(json.items['file1.txt']).toBeUndefined();
    });

    it('returns empty items for empty folder', async () => {
      const storage = new MemoryStorage();
      const env = createEnv(storage);
      const app = createServer(env);
      const token = seedToken(env, 'alice');

      const res = await app.request(
        'http://localhost/storage/alice/documents/empty/',
        { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
        env
      );

      const json = await res.json() as any;
      expect(Object.keys(json.items).length).toBe(0);
    });

    it('returns folder ETag', async () => {
      const storage = new MemoryStorage();
      const env = createEnv(storage);
      const app = createServer(env);
      const token = seedToken(env, 'alice');

      storage.seed('users/alice/storage/documents/file1.txt', 'content');

      const res = await app.request(
        'http://localhost/storage/alice/documents/',
        { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
        env
      );

      expect(res.headers.get('ETag')).toMatch(/^"[^"]+"$/);
    });
  });

  describe('Section 4: Error Codes', () => {
    it('401 for missing auth', async () => {
      const storage = new MemoryStorage();
      const env = createEnv(storage);
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/storage/alice/documents/test.txt',
        { method: 'GET' },
        env
      );

      expect(res.status).toBe(401);
    });

    it('403 for insufficient scope', async () => {
      const storage = new MemoryStorage();
      const env = createEnv(storage);
      const app = createServer(env);
      const token = seedToken(env, 'alice', 'documents:rw');

      const res = await app.request(
        'http://localhost/storage/alice/pictures/photo.jpg',
        { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
        env
      );

      expect(res.status).toBe(403);
    });

    it('404 for non-existent', async () => {
      const storage = new MemoryStorage();
      const env = createEnv(storage);
      const app = createServer(env);
      const token = seedToken(env, 'alice');

      const res = await app.request(
        'http://localhost/storage/alice/documents/does-not-exist.txt',
        { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
        env
      );

      expect(res.status).toBe(404);
    });

    it('412 for stale If-Match', async () => {
      const storage = new MemoryStorage();
      const env = createEnv(storage);
      const app = createServer(env);
      const token = seedToken(env, 'alice');

      storage.seed('users/alice/storage/documents/stale.txt', 'content');

      const res = await app.request(
        'http://localhost/storage/alice/documents/stale.txt',
        { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain', 'If-Match': '"stale-etag"' }, body: 'updated' },
        env
      );

      expect(res.status).toBe(412);
    });

    it('412 for If-None-Match:* on existing', async () => {
      const storage = new MemoryStorage();
      const env = createEnv(storage);
      const app = createServer(env);
      const token = seedToken(env, 'alice');

      storage.seed('users/alice/storage/documents/existing.txt', 'content');

      const res = await app.request(
        'http://localhost/storage/alice/documents/existing.txt',
        { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain', 'If-None-Match': '*' }, body: 'updated' },
        env
      );

      expect(res.status).toBe(412);
    });

    it('400 for invalid path', async () => {
      const storage = new MemoryStorage();
      const env = createEnv(storage);
      const app = createServer(env);
      const token = seedToken(env, 'alice');

      const res = await app.request(
        'http://localhost/storage/alice/../etc/passwd',
        { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
        env
      );

      expect(res.status).toBeOneOf([400, 403, 404]);
    });
  });

  describe('Section 5: CORS', () => {
    it('OPTIONS returns Allow header', async () => {
      const storage = new MemoryStorage();
      const env = createEnv(storage);
      const app = createServer(env);

      const res = await app.request(
        'http://localhost/storage/alice/documents/test.txt',
        { method: 'OPTIONS' },
        env
      );

      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('DELETE');
    });

    it('CORS headers on response', async () => {
      const storage = new MemoryStorage();
      const env = createEnv(storage);
      const app = createServer(env);
      const token = seedToken(env, 'alice');

      storage.seed('users/alice/storage/documents/cors-test.txt', 'content');

      const res = await app.request(
        'http://localhost/storage/alice/documents/cors-test.txt',
        { method: 'GET', headers: { Authorization: `Bearer ${token}`, Origin: 'https://example.com' } },
        env
      );

      expect(res.headers.get('Access-Control-Allow-Origin')).toBeTruthy();
    });
  });

  describe('Section 6: Caching', () => {
    it('returns 304 when ETag matches If-None-Match', async () => {
      const storage = new MemoryStorage();
      const env = createEnv(storage);
      const app = createServer(env);
      const token = seedToken(env, 'alice');

      storage.seed('users/alice/storage/documents/immutable.txt', 'content');

      const getRes = await app.request(
        'http://localhost/storage/alice/documents/immutable.txt',
        { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
        env
      );

      const etag = getRes.headers.get('ETag');

      const res304 = await app.request(
        'http://localhost/storage/alice/documents/immutable.txt',
        { method: 'GET', headers: { Authorization: `Bearer ${token}`, 'If-None-Match': etag! } },
        env
      );

      expect(res304.status).toBe(304);
    });

    it('ETag changes on content update', async () => {
      const storage = new MemoryStorage();
      const env = createEnv(storage);
      const app = createServer(env);
      const token = seedToken(env, 'alice');

      storage.seed('users/alice/storage/documents/etag-change.txt', 'v1');
      const res1 = await app.request(
        'http://localhost/storage/alice/documents/etag-change.txt',
        { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
        env
      );
      const etag1 = res1.headers.get('ETag');

      storage.seed('users/alice/storage/documents/etag-change.txt', 'v2');
      const res2 = await app.request(
        'http://localhost/storage/alice/documents/etag-change.txt',
        { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
        env
      );
      const etag2 = res2.headers.get('ETag');

      expect(etag1).not.toBe(etag2);
    });
  });

  describe('Section 7: User Isolation', () => {
    it('user A cannot read user B data', async () => {
      const storage = new MemoryStorage();
      const env = createEnv(storage);
      const app = createServer(env);
      const bobToken = seedToken(env, 'bob');

      storage.seed('users/alice/storage/documents/private.txt', 'alice secret');

      const res = await app.request(
        'http://localhost/storage/alice/documents/private.txt',
        { method: 'GET', headers: { Authorization: `Bearer ${bobToken}` } },
        env
      );

      expect(res.status).toBe(403);
    });

    it('user A cannot write to user B storage', async () => {
      const storage = new MemoryStorage();
      const env = createEnv(storage);
      const app = createServer(env);
      // bob is not the Account, so his token cannot touch the Account's storage.
      const bobToken = seedToken(env, 'bob');

      const res = await app.request(
        'http://localhost/storage/alice/documents/bob-writing.txt',
        { method: 'PUT', headers: { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'text/plain' }, body: 'bob tries to write to alice' },
        env
      );

      expect(res.status).toBe(403);
    });

    it('storage of a user other than the Account is unreachable', async () => {
      const storage = new MemoryStorage();
      const env = createEnv(storage);
      const app = createServer(env);
      const aliceToken = seedToken(env, 'alice');

      const res = await app.request(
        'http://localhost/storage/bob/documents/alice-writing.txt',
        { method: 'PUT', headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'text/plain' }, body: 'alice tries to write to bob' },
        env
      );

      expect(res.status).toBe(403);
    });
  });

  describe('Section 8: Module Scopes', () => {
    it('scope: documents:rw allows read and write', async () => {
      const storage = new MemoryStorage();
      const env = createEnv(storage);
      const app = createServer(env);
      const token = seedToken(env, 'alice', 'documents:rw');

      const putRes = await app.request(
        'http://localhost/storage/alice/documents/test.txt',
        { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: 'content' },
        env
      );
      expect(putRes.status).toBeOneOf([200, 201]);

      const getRes = await app.request(
        'http://localhost/storage/alice/documents/test.txt',
        { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
        env
      );
      expect(getRes.status).toBe(200);
    });

    it('scope: documents:r blocks write', async () => {
      const storage = new MemoryStorage();
      const env = createEnv(storage);
      const app = createServer(env);
      const token = seedToken(env, 'alice', 'documents:r');

      const res = await app.request(
        'http://localhost/storage/alice/documents/test.txt',
        { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: 'content' },
        env
      );

      expect(res.status).toBe(403);
    });

    it('scope: documents:r allows read', async () => {
      const storage = new MemoryStorage();
      const env = createEnv(storage);
      const app = createServer(env);
      const token = seedToken(env, 'alice', 'documents:r');

      storage.seed('users/alice/storage/documents/readable.txt', 'content');

      const res = await app.request(
        'http://localhost/storage/alice/documents/readable.txt',
        { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
        env
      );

      expect(res.status).toBe(200);
    });

    // §9: the root scope is `*:rw` (or `*:r`). A bare `*` is not a scope and
    // grants nothing (it used to grant full read-write).
    it('bare * scope grants nothing', async () => {
      const env = createEnv(new MemoryStorage());
      const token = seedToken(env, 'alice', '*');
      const res = await createServer(env).request(
        'http://localhost/storage/alice/documents/test.txt',
        { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: 'content' },
        env
      );
      expect(res.status).toBe(403);
    });

    it('wildcard scope: *:rw grants access to all modules', async () => {
      const storage = new MemoryStorage();
      const env = createEnv(storage);
      const app = createServer(env);
      const token = seedToken(env, 'alice', '*:rw');

      const docRes = await app.request(
        'http://localhost/storage/alice/documents/test.txt',
        { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: 'content' },
        env
      );
      expect(docRes.status).toBeOneOf([200, 201]);

      const picRes = await app.request(
        'http://localhost/storage/alice/pictures/test.jpg',
        { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' }, body: new ArrayBuffer(10) },
        env
      );
      expect(picRes.status).toBeOneOf([200, 201]);
    });
  });
});
