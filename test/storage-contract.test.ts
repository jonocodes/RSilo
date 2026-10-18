// One StorageInterface contract, run against every backend the routes can be
// given: the in-memory test fake, R2Storage over a fake R2 binding, S3Storage
// over a fake S3 endpoint and LocalStorage on a temporary directory. The fakes
// page listings two keys at a time, so pagination is exercised too.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StorageInterface } from '../src/types';
import { LocalStorage } from '../src/services/local-storage';
import { R2Storage } from '../src/services/r2';
import { S3Storage } from '../src/services/s3';
import { createFakeR2 } from './helpers/fake-r2';
import { createFakeS3 } from './helpers/fake-s3';
import { MemoryStorage } from './helpers/memory-storage';

interface Backend {
  storage: StorageInterface;
  /** S3's ListObjectsV2 carries no content type (ADR-0005). */
  listsContentType: boolean;
  done(): void;
}

const S3_CONFIG = { endpoint: 'https://s3.example.test', bucket: 'rsilo-test', accessKeyId: 'AKIDTEST', secretAccessKey: 'secret' };

const backends: [string, () => Backend][] = [
  ['MemoryStorage', () => ({ storage: new MemoryStorage(), listsContentType: true, done() {} })],
  ['R2Storage', () => ({ storage: new R2Storage(createFakeR2({ pageSize: 2 }).bucket), listsContentType: true, done() {} })],
  ['S3Storage', () => {
    const s3 = createFakeS3({ bucket: S3_CONFIG.bucket, accessKeyId: S3_CONFIG.accessKeyId, pageSize: 2 });
    return { storage: new S3Storage(S3_CONFIG, s3.fetch), listsContentType: false, done() {} };
  }],
  ['LocalStorage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rsilo-contract-'));
    return { storage: new LocalStorage(dir), listsContentType: true, done: () => rmSync(dir, { recursive: true, force: true }) };
  }],
];

const P = 'users/alice/storage/';
const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const unquoted = (etag: string) => etag.replace(/^"|"$/g, '');

async function text(body: ArrayBuffer | ReadableStream<Uint8Array>): Promise<string> {
  return new Response(body).text();
}

describe.each(backends)('StorageInterface contract: %s', (_name, make) => {
  let backend: Backend;
  let storage: StorageInterface;
  beforeEach(() => {
    backend = make();
    storage = backend.storage;
  });
  afterEach(() => backend.done());

  const keys = async (prefix: string) => (await storage.list(prefix)).objects.map((o) => o.key);

  it('round-trips body, content type, size and the ETag put returned', async () => {
    const etag = await storage.put(P + 'documents/a.json', bytes('{"a":1}'), 'application/json');

    const got = await storage.get(P + 'documents/a.json');
    expect(got).not.toBeNull();
    expect(await text(got!.body)).toBe('{"a":1}');
    expect(got!.metadata).toMatchObject({ contentType: 'application/json', contentLength: 7 });
    expect(unquoted(got!.metadata.etag)).toBe(unquoted(etag));

    const head = await storage.head(P + 'documents/a.json');
    expect(head).toMatchObject({ contentType: 'application/json', contentLength: 7 });
    expect(unquoted(head!.etag)).toBe(unquoted(etag));
    expect(new Date(head!.lastModified!).toISOString()).toBe(head!.lastModified);
  });

  it('keeps an ETag stable across reads and changes it with the content', async () => {
    const first = await storage.put(P + 'a.txt', bytes('one'), 'text/plain');
    expect((await storage.head(P + 'a.txt'))!.etag).toBe((await storage.head(P + 'a.txt'))!.etag);

    const second = await storage.put(P + 'a.txt', bytes('two'), 'text/markdown');
    expect(unquoted(second)).not.toBe(unquoted(first));
    expect(await storage.head(P + 'a.txt')).toMatchObject({ contentType: 'text/markdown', contentLength: 3 });
    expect(await text((await storage.get(P + 'a.txt'))!.body)).toBe('two');
  });

  it('stores an empty document', async () => {
    await storage.put(P + 'empty', new ArrayBuffer(0), 'text/plain');
    expect(await storage.head(P + 'empty')).toMatchObject({ contentLength: 0 });
    expect(await text((await storage.get(P + 'empty'))!.body)).toBe('');
  });

  it('answers null for a missing key and ignores deleting one', async () => {
    expect(await storage.get(P + 'missing')).toBeNull();
    expect(await storage.head(P + 'missing')).toBeNull();
    await expect(storage.delete(P + 'missing')).resolves.toBeUndefined();
    expect(await keys(P)).toEqual([]);
  });

  it('lists every key under a prefix, recursively and in order, with size and ETag', async () => {
    const etags: Record<string, string> = {};
    for (const key of ['documents/b.txt', 'documents/a.txt', 'documents/sub/deep/c.txt', 'pictures/p.png', 'documents-old/x']) {
      etags[key] = await storage.put(P + key, bytes(key), key.endsWith('.png') ? 'image/png' : 'text/plain');
    }
    await storage.put('users/bob/storage/documents/b.txt', bytes('bob'), 'text/plain');

    const { objects } = await storage.list(P + 'documents/');
    expect(objects.map((o) => o.key)).toEqual([P + 'documents/a.txt', P + 'documents/b.txt', P + 'documents/sub/deep/c.txt']);
    for (const object of objects) {
      const key = object.key.slice(P.length);
      expect(object.size).toBe(key.length);
      expect(unquoted(object.etag)).toBe(unquoted(etags[key]));
      if (backend.listsContentType) expect(object.contentType).toBe('text/plain');
    }

    // A prefix is a string prefix, not only a folder.
    expect(await keys(P + 'documents')).toEqual([
      P + 'documents-old/x', P + 'documents/a.txt', P + 'documents/b.txt', P + 'documents/sub/deep/c.txt',
    ].sort());
    expect(await keys(P + 'documents/sub/deep/c')).toEqual([P + 'documents/sub/deep/c.txt']);
    expect(await keys(P + 'nothing/')).toEqual([]);
    expect(await keys('users/')).toHaveLength(6);
  });

  it('leaves no trace of deleted documents or their folders in a listing', async () => {
    await storage.put(P + 'documents/sub/a.txt', bytes('a'), 'text/plain');
    await storage.put(P + 'documents/keep.txt', bytes('k'), 'text/plain');
    await storage.delete(P + 'documents/sub/a.txt');

    expect(await storage.get(P + 'documents/sub/a.txt')).toBeNull();
    expect(await keys(P)).toEqual([P + 'documents/keep.txt']);
    await storage.delete(P + 'documents/keep.txt');
    expect(await keys('')).toEqual([]);
  });

  it('keeps keys distinct that differ in case, dots, spaces or escapes', async () => {
    const names = ['ab', 'a..b', 'Ab', 'a b', 'a%20b', 'a+b', 'é', 'é', 'x.meta', 'x', '~a!*\'()'];
    for (const name of names) await storage.put(P + 'd/' + name, bytes(name), 'text/plain');

    for (const name of names) {
      expect(await text((await storage.get(P + 'd/' + name))!.body)).toBe(name);
      expect(await storage.head(P + 'd/' + name)).toMatchObject({ contentType: 'text/plain' });
    }
    expect(await keys(P + 'd/')).toEqual(names.map((name) => P + 'd/' + name).sort());
  });
});
