// LocalStorage specifics beyond the shared contract (storage-contract.test.ts):
// regressions for the offline backend's on-disk layout.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalStorage } from '../src/services/local-storage';
import { PathConflictError } from '../src/services/storage-errors';

const P = 'users/alice/storage/documents/';
const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

describe('LocalStorage', () => {
  let root: string;
  let dir: string;
  let storage: LocalStorage;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rsilo-local-'));
    dir = join(root, 'storage');
    storage = new LocalStorage(dir);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('keeps metadata out of reach of user keys, so x.meta is just another document', async () => {
    const etag = await storage.put(P + 'x', bytes('x'), 'text/plain');
    expect(await storage.get(P + 'x.meta')).toBeNull();

    await storage.put(P + 'x.meta', bytes('mine'), 'application/json');
    expect(await storage.head(P + 'x')).toMatchObject({ contentType: 'text/plain', etag });
    expect((await storage.list(P)).objects.map(o => o.key)).toEqual([P + 'x', P + 'x.meta']);
    // The metadata tree itself is not a key either.
    expect(await storage.list('.meta/')).toEqual({ objects: [] });
    expect(await storage.get('.meta/' + P + 'x')).toBeNull();
  });

  it('gives a file without metadata the same ETag on every read, changing when the file does', async () => {
    mkdirSync(join(dir, 'users/alice/storage/documents'), { recursive: true });
    const file = join(dir, 'users/alice/storage/documents/copied.txt');
    writeFileSync(file, 'by hand');

    const first = (await storage.head(P + 'copied.txt'))!;
    expect(first).toMatchObject({ contentType: 'application/octet-stream', contentLength: 7 });
    expect((await storage.head(P + 'copied.txt'))!.etag).toBe(first.etag);
    expect((await storage.list(P)).objects[0].etag).toBe(first.etag);

    writeFileSync(file, 'by hand, again');
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect((await storage.head(P + 'copied.txt'))!.etag).not.toBe(first.etag);
  });

  it('never aliases a..b and ab, and never writes outside its directory', async () => {
    await storage.put(P + 'a..b', bytes('1'), 'text/plain');
    expect(await storage.get(P + 'ab')).toBeNull();

    await storage.put('../escape', bytes('2'), 'text/plain');
    await storage.put('users/../../escape2', bytes('3'), 'text/plain');
    expect(readdirSync(root)).toEqual(['storage']);
    expect(new TextDecoder().decode((await storage.get('../escape'))!.body)).toBe('2');
  });

  it('removes folders that a delete leaves empty', async () => {
    await storage.put(P + 'sub/deep/a.txt', bytes('a'), 'text/plain');
    await storage.put(P + 'b.txt', bytes('b'), 'text/plain');

    await storage.delete(P + 'sub/deep/a.txt');
    expect(existsSync(join(dir, 'users/alice/storage/documents/sub'))).toBe(false);
    expect(existsSync(join(dir, 'users/alice/storage/documents/b.txt'))).toBe(true);

    await storage.delete(P + 'b.txt');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses a document and a folder of one name with PathConflictError, not a filesystem error', async () => {
    await storage.put(P + 'a', bytes('a'), 'text/plain');
    await storage.put(P + 'b/c', bytes('c'), 'text/plain');

    await expect(storage.put(P + 'a/x', bytes('x'), 'text/plain')).rejects.toBeInstanceOf(PathConflictError);
    await expect(storage.put(P + 'b', bytes('b'), 'text/plain')).rejects.toBeInstanceOf(PathConflictError);
    expect((await storage.list(P)).objects.map((o) => o.key)).toEqual([P + 'a', P + 'b/c']);
  });

  it('refuses keys with empty segments rather than guessing a file', async () => {
    await expect(storage.put('users//a', bytes('a'), 'text/plain')).rejects.toThrow('empty segments');
  });
});
