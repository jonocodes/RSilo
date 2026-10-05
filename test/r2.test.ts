import { describe, expect, it, vi } from 'vitest';
import { R2Storage } from '../src/services/r2';

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
      { prefix: 'users/alice/storage/', cursor: undefined },
      { prefix: 'users/alice/storage/', cursor: 'page-2' },
    ]);
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
