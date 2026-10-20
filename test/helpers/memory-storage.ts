// In-memory StorageInterface for route tests: keys are stored verbatim, list()
// filters by prefix like R2/S3, and get() honours a byte range like they do.

import type { StorageGetOptions } from '../../src/types';

interface Item { body: Uint8Array; etag: string; contentType: string; lastModified: string }

export function createMemoryStorage() {
  const items = new Map<string, Item>();
  let n = 0;
  return {
    items,
    async get(key: string, options?: StorageGetOptions) {
      const item = items.get(key);
      if (!item) return null;
      const body = options?.range
        ? item.body.slice(options.range.offset, options.range.offset + options.range.length)
        : item.body;
      return {
        body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
        metadata: { contentType: item.contentType, contentLength: item.body.byteLength, etag: item.etag, lastModified: item.lastModified },
      };
    },
    async put(key: string, body: ArrayBuffer, contentType: string) {
      const etag = `"etag-${++n}"`;
      items.set(key, { body: new Uint8Array(body.slice(0)), etag, contentType, lastModified: new Date().toISOString() });
      return etag;
    },
    async delete(key: string) {
      items.delete(key);
    },
    async head(key: string) {
      const item = items.get(key);
      if (!item) return null;
      return { contentType: item.contentType, contentLength: item.body.byteLength, etag: item.etag, lastModified: item.lastModified };
    },
    async list(prefix: string) {
      return {
        objects: [...items.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, item]) => ({ key, size: item.body.byteLength, etag: item.etag, contentType: item.contentType, lastModified: item.lastModified })),
      };
    },
  };
}
