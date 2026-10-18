import { describe, expect, it, vi } from 'vitest';
import type { R2Bucket } from '@cloudflare/workers-types';
import { R2Storage } from '../src/services/r2';
import { createServer } from '../src/index';
import { createSqliteD1 } from '../src/services/db/sqlite';
import { createFakeR2 } from './helpers/fake-r2';
import { seedToken } from './helpers/tokens';

describe('R2Storage.list', () => {
  it('follows every cursor until the listing is complete, asking for content types', async () => {
    const r2 = createFakeR2({ pageSize: 1 });
    const storage = new R2Storage(r2.bucket);
    await storage.put('users/alice/storage/a.txt', new ArrayBuffer(1), 'text/plain');
    await storage.put('users/alice/storage/b.txt', new ArrayBuffer(2), 'text/plain');

    const result = await storage.list('users/alice/storage/');

    expect(result.objects.map((object) => [object.key, object.contentType])).toEqual([
      ['users/alice/storage/a.txt', 'text/plain'],
      ['users/alice/storage/b.txt', 'text/plain'],
    ]);
    expect(r2.listCalls).toEqual([
      { prefix: 'users/alice/storage/', cursor: undefined, include: ['httpMetadata'] },
      { prefix: 'users/alice/storage/', cursor: '1', include: ['httpMetadata'] },
    ]);
  });

  it('rejects an incomplete truncated response without a cursor', async () => {
    const bucket = {
      list: async () => ({ objects: [], truncated: true }),
    } as unknown as R2Bucket;

    await expect(new R2Storage(bucket).list('users/alice/storage/'))
      .rejects.toThrow('truncated listing without a cursor');
  });
});

describe('R2 binding through the routes', () => {
  it('serves documents and folder listings with their content types', async () => {
    const r2 = createFakeR2();
    const env = { STORAGE: r2.bucket, DB: createSqliteD1() };
    const token = seedToken(env, 'alice');
    const auth = { 'Authorization': `Bearer ${token}` };
    const app = createServer(env);
    const url = 'http://localhost/storage/alice/documents/note.json';

    const put = await app.request(url, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' }, env);
    expect(put.status).toBe(201);
    expect(r2.objects.get('users/alice/storage/documents/note.json')?.httpMetadata).toEqual({ contentType: 'application/json' });

    const got = await app.request(url, { headers: auth }, env);
    expect(got.headers.get('Content-Type')).toBe('application/json');
    expect(got.headers.get('ETag')).toBe(put.headers.get('ETag'));
    expect(await got.text()).toBe('{}');

    const folder = await app.request('http://localhost/storage/alice/documents/', { headers: auth }, env);
    const listing = await folder.json() as { items: Record<string, { 'Content-Type': string; 'Content-Length': number }> };
    expect(listing.items).toEqual({ 'note.json': expect.objectContaining({ 'Content-Type': 'application/json', 'Content-Length': 2 }) });

    expect((await app.request(url, { method: 'DELETE', headers: auth }, env)).status).toBe(200);
    expect(r2.objects.size).toBe(0);
  });
});

describe('R2Storage.get', () => {
  it('returns the R2 body stream without buffering it', async () => {
    const stream = new ReadableStream<Uint8Array>();
    const arrayBuffer = vi.fn();
    const bucket = {
      get: async () => ({
        body: stream,
        size: 123,
        etag: 'etag',
        httpMetadata: { contentType: 'application/octet-stream' },
        arrayBuffer,
      }),
    } as unknown as R2Bucket;

    const result = await new R2Storage(bucket).get('users/alice/storage/file.bin');
    expect(result?.body).toBe(stream);
    expect(result?.metadata.contentLength).toBe(123);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});
