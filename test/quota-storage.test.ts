import { describe, expect, it } from 'vitest';
import { createSqliteD1 } from '../src/services/db/sqlite';
import { deleteUserObject, putUserObject, QuotaExceededError, StorageAccountingError } from '../src/services/quota-storage';
import { MemoryStorage } from './helpers/memory-storage';

// Accounting runs the same predicate UPDATE against the SQLite shim as against
// D1 in production.
function fixture(quota = 100, used = 0) {
  const db = createSqliteD1();
  db.sqlite.prepare('INSERT INTO users (id, username, storage_quota_bytes, used_storage_bytes) VALUES (?, ?, ?, ?)')
    .run('u1', 'alice', quota, used);
  const storage = new MemoryStorage();
  const usedBytes = () => (db.sqlite.prepare('SELECT used_storage_bytes AS used FROM users').get() as { used: number }).used;
  return { db, storage, used: usedBytes };
}

type Fixture = ReturnType<typeof fixture>;

async function put(f: Fixture, key: string, size: number, username = 'alice') {
  const existing = await f.storage.head(key);
  return putUserObject({
    storage: f.storage,
    db: f.db,
    username,
    key,
    body: new ArrayBuffer(size),
    contentType: 'text/plain',
    existing,
  });
}

async function remove(f: Fixture, key: string) {
  const existing = await f.storage.head(key);
  return deleteUserObject({ storage: f.storage, db: f.db, username: 'alice', key, existing: existing! });
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

    await remove(f, 'file.txt');
    expect(f.used()).toBe(0);
  });

  it('allows growth up to exactly the quota', async () => {
    const f = fixture(20);
    await put(f, 'file.txt', 20);
    expect(f.used()).toBe(20);
  });

  it('rejects growth beyond quota without changing the object', async () => {
    const f = fixture(20);
    await put(f, 'file.txt', 15);

    await expect(put(f, 'file.txt', 25)).rejects.toBeInstanceOf(QuotaExceededError);
    expect(f.used()).toBe(15);
    expect(f.storage.objects.get('file.txt')?.body.byteLength).toBe(15);
  });

  it('never lets recorded usage go below zero', async () => {
    const f = fixture(100, 5);
    f.storage.seed('untracked.txt', 'x'.repeat(50));
    await remove(f, 'untracked.txt');
    expect(f.used()).toBe(0);
  });

  it('rolls back reserved usage when object storage fails', async () => {
    const f = fixture();
    f.storage.put = async () => { throw new Error('R2 failed'); };

    await expect(put(f, 'file.txt', 12)).rejects.toThrow('R2 failed');
    expect(f.used()).toBe(0);
  });

  it('restores usage when a delete fails, even past a since-lowered quota', async () => {
    const f = fixture(20);
    await put(f, 'file.txt', 15);
    f.db.sqlite.prepare('UPDATE users SET storage_quota_bytes = 10').run();
    f.storage.delete = async () => { throw new Error('R2 failed'); };

    await expect(remove(f, 'file.txt')).rejects.toThrow('R2 failed');
    expect(f.used()).toBe(15);
  });

  it('refuses writes for an Account with no users row', async () => {
    const f = fixture();
    await expect(put(f, 'file.txt', 1, 'nobody')).rejects.toBeInstanceOf(QuotaExceededError);
    expect(f.storage.objects.size).toBe(0);
  });

  it('prevents concurrent writes from exceeding quota', async () => {
    const f = fixture(15);
    const results = await Promise.allSettled([
      put(f, 'a.txt', 10),
      put(f, 'b.txt', 10),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(f.used()).toBe(10);
  });

  it('reports a failing database as an accounting failure and leaves storage alone', async () => {
    const storage = new MemoryStorage();
    const db = { prepare: () => { throw new Error('D1 unavailable'); } };
    await expect(putUserObject({ storage, db, username: 'alice', key: 'k', body: new ArrayBuffer(1), contentType: 't', existing: null }))
      .rejects.toBeInstanceOf(StorageAccountingError);
    expect(storage.objects.size).toBe(0);
  });

  it('requires a database unless unaccounted writes are allowed', async () => {
    const storage = new MemoryStorage();
    const options = { storage, db: undefined, username: 'alice', key: 'k', body: new ArrayBuffer(1), contentType: 't', existing: null };
    await expect(putUserObject(options)).rejects.toBeInstanceOf(StorageAccountingError);
    await putUserObject({ ...options, allowUnaccounted: true });
    expect(storage.objects.has('k')).toBe(true);
  });
});
