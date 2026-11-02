// LocalStorage specifics beyond the shared contract (storage-contract.test.ts):
// regressions for the offline backend's on-disk layout.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalStorage } from '../src/services/local-storage';
import { KeyTooLongError, PathConflictError } from '../src/services/storage-errors';

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

  it('keeps every file name within 255 bytes, however long the key segment', async () => {
    const long = 'ကခဂဃငစဆဇဈဉညဋဌဍဎဏတထဒဓနပဖဗဘမယရလဝသဟ.txt'; // 292 bytes percent-encoded
    await storage.put(P + long + '/' + long, bytes('x'), 'text/plain');

    const names = (path: string): string[] => readdirSync(path, { withFileTypes: true })
      .flatMap((entry) => [entry.name, ...(entry.isDirectory() ? names(join(path, entry.name)) : [])]);
    const onDisk = names(dir);
    expect(Math.max(...onDisk.map((name) => Buffer.byteLength(name)))).toBeLessThanOrEqual(255);
    // Still recognisable on disk.
    expect(onDisk.filter((name) => name.startsWith('%E1%80%80%E1%80%81'))).toHaveLength(4);

    await storage.delete(P + long + '/' + long);
    expect(readdirSync(dir)).toEqual(['.meta']);
    expect(readdirSync(join(dir, '.meta'))).toEqual(['.names']);
  });

  it('ignores a shortened name whose record is missing or damaged, and repairs it on the next write', async () => {
    const key = P + 'a'.repeat(300);
    await storage.put(key, bytes('x'), 'text/plain');
    const names = join(dir, '.meta', '.names');
    const [record] = readdirSync(names);
    writeFileSync(join(names, record), 'a'.repeat(100)); // e.g. cut short by a crash
    expect((await storage.list(P)).objects).toEqual([]);
    rmSync(names, { recursive: true });
    expect((await storage.list(P)).objects).toEqual([]);

    await storage.put(key, bytes('y'), 'text/plain');
    expect((await storage.list(P)).objects.map((o) => o.key)).toEqual([key]);
    expect(readdirSync(names)).toEqual([record]);
  });

  it('refuses a key whose path the filesystem cannot hold with KeyTooLongError, leaving nothing behind', async () => {
    const key = P + Array(20).fill('a'.repeat(250)).join('/'); // over Linux's 4096-byte PATH_MAX
    await expect(storage.put(key, bytes('x'), 'text/plain')).rejects.toBeInstanceOf(KeyTooLongError);
    expect(await storage.get(key)).toBeNull();
    expect(await storage.head(key)).toBeNull();
    await storage.delete(key);
    expect(await storage.list(key.slice(0, key.lastIndexOf('/') + 1))).toEqual({ objects: [] });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses keys with empty segments rather than guessing a file', async () => {
    await expect(storage.put('users//a', bytes('a'), 'text/plain')).rejects.toThrow('empty segments');
  });
});

describe('LocalStorage ranges and item names', () => {
  let root: string;
  let storage: LocalStorage;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rsilo-local-'));
    storage = new LocalStorage(join(root, 'storage'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('returns a byte range with the full size in metadata', async () => {
    await storage.put(P + 'digits', bytes('0123456789'), 'text/plain');
    const result = await storage.get(P + 'digits', { range: { offset: 2, length: 3 } });
    expect(new TextDecoder().decode(result!.body)).toBe('234');
    expect(result!.metadata.contentLength).toBe(10);
  });

  it('stores and lists names the storage API now allows', async () => {
    const names = ['back\\slash', '.hidden', '..double..dots..', 'a?b#c%d', '\nleading LF'];
    for (const name of names) await storage.put(P + name, bytes(name), 'text/plain');
    expect((await storage.list(P)).objects.map(o => o.key).sort()).toEqual(names.map(n => P + n).sort());
    for (const name of names) expect(new TextDecoder().decode((await storage.get(P + name))!.body)).toBe(name);
  });
});
