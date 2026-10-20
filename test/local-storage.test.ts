// The offline stand-in for R2 (services/local-storage.ts) must store any item
// name and list like R2: object keys only, no empty folders.

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorage } from '../src/services/local-storage';

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (b: ArrayBuffer) => new TextDecoder().decode(b);
const P = 'users/alice/storage/documents/';

describe('LocalStorage', () => {
  let dir: string;
  let storage: LocalStorage;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rsilo-local-'));
    storage = new LocalStorage(dir);
  });

  it('stores names the old layout mangled or hid', async () => {
    for (const name of ['x.meta', 'back\\slash', '..double..dots..', '.hidden']) {
      await storage.put(P + name, enc(name), 'text/plain');
    }
    const keys = (await storage.list(P)).objects.map(o => o.key).sort();
    expect(keys).toEqual([P + '..double..dots..', P + '.hidden', P + 'back\\slash', P + 'x.meta'].sort());
    expect(dec((await storage.get(P + 'x.meta'))!.body)).toBe('x.meta');
    expect((await storage.head(P + 'back\\slash'))!.contentType).toBe('text/plain');
  });

  it('returns a byte range with the full size in metadata', async () => {
    await storage.put(P + 'digits', enc('0123456789'), 'text/plain');
    const result = await storage.get(P + 'digits', { range: { offset: 2, length: 3 } });
    expect(dec(result!.body)).toBe('234');
    expect(result!.metadata.contentLength).toBe(10);
  });

  it('lists objects only and forgets emptied folders', async () => {
    await storage.put(P + 'a/b/c.txt', enc('x'), 'text/plain');
    await storage.put(P + 'keep.txt', enc('x'), 'text/plain');
    expect((await storage.list(P)).objects.map(o => o.key).sort()).toEqual([P + 'a/b/c.txt', P + 'keep.txt']);
    await storage.delete(P + 'a/b/c.txt');
    expect((await storage.list(P)).objects.map(o => o.key)).toEqual([P + 'keep.txt']);
    expect(existsSync(join(dir, P, 'a'))).toBe(false);
  });

  it('refuses keys that would escape the storage directory', async () => {
    await expect(storage.put('users/alice/../../etc/x', enc('x'), 'text/plain')).rejects.toThrow('invalid storage key');
    await expect(storage.get('users/alice/./x')).rejects.toThrow('invalid storage key');
  });

  it('moves legacy <file>.meta sidecars into the metadata tree', async () => {
    const legacy = mkdtempSync(join(tmpdir(), 'rsilo-legacy-'));
    mkdirSync(join(legacy, P), { recursive: true });
    writeFileSync(join(legacy, P, 'note.txt'), 'hello');
    writeFileSync(join(legacy, P, 'note.txt.meta'), JSON.stringify({ contentType: 'text/markdown', etag: '"abc"' }));
    const migrated = new LocalStorage(legacy);
    expect(readdirSync(join(legacy, P))).toEqual(['note.txt']);
    expect(await migrated.head(P + 'note.txt')).toMatchObject({ contentType: 'text/markdown', etag: '"abc"', contentLength: 5 });
    expect((await migrated.list(P)).objects.map(o => o.key)).toEqual([P + 'note.txt']);
  });
});
