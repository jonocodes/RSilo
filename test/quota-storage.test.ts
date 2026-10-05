import { describe, expect, it } from 'vitest';
import { deleteUserObject, putUserObject, QuotaExceededError } from '../src/services/quota-storage';

function fixture(quota = 100) {
  let used = 0;
  const objects = new Map<string, ArrayBuffer>();
  const db = {
    prepare: () => ({}),
    async adjustStorageUsage(_username: string, delta: number, enforceQuota: boolean) {
      const next = Math.max(0, used + delta);
      if (enforceQuota && delta > 0 && next > quota) return false;
      used = next;
      return true;
    },
  };
  const storage = {
    async head(key: string) {
      const body = objects.get(key);
      return body
        ? { contentType: 'text/plain', contentLength: body.byteLength, etag: 'etag' }
        : null;
    },
    async put(key: string, body: ArrayBuffer) {
      objects.set(key, body);
      return 'etag';
    },
    async delete(key: string) {
      objects.delete(key);
    },
  } as any;
  return { db, storage, objects, used: () => used };
}

async function put(f: ReturnType<typeof fixture>, key: string, size: number) {
  const existing = await f.storage.head(key);
  return putUserObject({
    storage: f.storage,
    db: f.db,
    username: 'alice',
    key,
    body: new ArrayBuffer(size),
    contentType: 'text/plain',
    existing,
  });
}

describe('quota-aware storage', () => {
  it('accounts for create, grow, shrink, and delete using size deltas', async () => {
    const f = fixture();
    await put(f, 'file.txt', 30);
    expect(f.used()).toBe(30);

    await put(f, 'file.txt', 45);
    expect(f.used()).toBe(45);

    await put(f, 'file.txt', 10);
    expect(f.used()).toBe(10);

    const existing = await f.storage.head('file.txt');
    await deleteUserObject({
      storage: f.storage,
      db: f.db,
      username: 'alice',
      key: 'file.txt',
      existing: existing!,
    });
    expect(f.used()).toBe(0);
  });

  it('rejects growth beyond quota without changing the object', async () => {
    const f = fixture(20);
    await put(f, 'file.txt', 15);

    await expect(put(f, 'file.txt', 25)).rejects.toBeInstanceOf(QuotaExceededError);
    expect(f.used()).toBe(15);
    expect(f.objects.get('file.txt')?.byteLength).toBe(15);
  });

  it('rolls back reserved usage when object storage fails', async () => {
    const f = fixture();
    f.storage.put = async () => { throw new Error('R2 failed'); };

    await expect(put(f, 'file.txt', 12)).rejects.toThrow('R2 failed');
    expect(f.used()).toBe(0);
  });

  it('atomically prevents concurrent writes from exceeding quota', async () => {
    const f = fixture(15);
    const results = await Promise.allSettled([
      put(f, 'a.txt', 10),
      put(f, 'b.txt', 10),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(f.used()).toBe(10);
  });
});
