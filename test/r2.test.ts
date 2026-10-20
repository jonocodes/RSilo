import { describe, expect, it, vi } from 'vitest';
import { R2Storage } from '../src/services/r2';
import { createServer } from '../src/index';
import { createSqliteD1 } from '../src/services/db/sqlite';
import { seedToken } from './helpers/tokens';

describe('R2Storage.list', () => {
  it('follows every cursor until the listing is complete', async () => {
    const calls: Array<{ prefix?: string; cursor?: string }> = [];
    const bucket = {
      list: async (options: { prefix?: string; cursor?: string }) => {
        calls.push(options);
        if (!options.cursor) {
          return {
            objects: [{ key: 'users/alice/storage/a.txt', size: 1, etag: 'a' }],
            truncated: true,
            cursor: 'page-2',
          };
        }
        return {
          objects: [{ key: 'users/alice/storage/b.txt', size: 2, etag: 'b' }],
          truncated: false,
        };
      },
    } as any;

    const result = await new R2Storage(bucket).list('users/alice/storage/');

    expect(result.objects.map((object) => object.key)).toEqual([
      'users/alice/storage/a.txt',
      'users/alice/storage/b.txt',
    ]);
    expect(calls).toEqual([
      { prefix: 'users/alice/storage/', cursor: undefined, include: ['httpMetadata'] },
      { prefix: 'users/alice/storage/', cursor: 'page-2', include: ['httpMetadata'] },
    ]);
  });

  it("gives folder listings each document's Content-Type", async () => {
    const env = {
      // An R2 binding (createMultipartUpload marks it) that, like R2, returns
      // httpMetadata in a listing only when asked to.
      STORAGE: {
        createMultipartUpload() {},
        list: async (options: { include?: string[] }) => ({
          objects: [{
            key: 'users/alice/storage/documents/note.txt',
            size: 2,
            etag: 'n',
            ...(options.include?.includes('httpMetadata') ? { httpMetadata: { contentType: 'text/plain' } } : {}),
          }],
          truncated: false,
        }),
      },
      DB: createSqliteD1(),
    };
    const token = seedToken(env, 'alice');

    const res = await createServer(env).request(
      'http://localhost/storage/alice/documents/',
      { headers: { 'Authorization': `Bearer ${token}` } },
      env
    );

    expect(res.status).toBe(200);
    expect((await res.json() as any).items['note.txt']['Content-Type']).toBe('text/plain');
  });

  it('rejects an incomplete truncated response without a cursor', async () => {
    const bucket = {
      list: async () => ({ objects: [], truncated: true }),
    } as any;

    await expect(new R2Storage(bucket).list('users/alice/storage/'))
      .rejects.toThrow('truncated listing without a cursor');
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
    } as any;

    const result = await new R2Storage(bucket).get('users/alice/storage/file.bin');
    expect(result?.body).toBe(stream);
    expect(result?.metadata.contentLength).toBe(123);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});
