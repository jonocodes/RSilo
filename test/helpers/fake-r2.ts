// An in-memory R2 binding for tests: the slice of R2Bucket that R2Storage and
// getStorage use, answering the way R2 does. ETags are the body's MD5 hex,
// unquoted (httpEtag is the quoted form); get() streams the body; list() is
// sorted, pages by cursor and, like R2, leaves httpMetadata out of each
// listed object unless asked with include: ['httpMetadata'].

import { createHash } from 'node:crypto';
import type { R2Bucket } from '@cloudflare/workers-types';

export interface FakeR2Object {
  body: Uint8Array<ArrayBuffer>;
  httpMetadata: { contentType?: string };
  customMetadata: Record<string, string>;
  etag: string;
  uploaded: Date;
}

interface ListOptions {
  prefix?: string;
  cursor?: string;
  limit?: number;
  include?: ('httpMetadata' | 'customMetadata')[];
}

export interface FakeR2 {
  /** The fake as the binding type R2Storage takes. */
  bucket: R2Bucket;
  objects: Map<string, FakeR2Object>;
  /** Every list() call's options, in order. */
  listCalls: ListOptions[];
}

function r2Object(key: string, object: FakeR2Object, include: ListOptions['include'] = ['httpMetadata', 'customMetadata']) {
  return {
    key,
    version: object.etag,
    size: object.body.byteLength,
    etag: object.etag,
    httpEtag: `"${object.etag}"`,
    uploaded: object.uploaded,
    storageClass: 'Standard',
    ...(include.includes('httpMetadata') ? { httpMetadata: { ...object.httpMetadata } } : {}),
    ...(include.includes('customMetadata') ? { customMetadata: { ...object.customMetadata } } : {}),
  };
}

export function createFakeR2(options: { pageSize?: number } = {}): FakeR2 {
  const objects = new Map<string, FakeR2Object>();
  const listCalls: ListOptions[] = [];

  const bucket = {
    createMultipartUpload() {
      throw new Error('multipart uploads are not part of the fake');
    },
    async put(key: string, value: ArrayBuffer, put: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> } = {}) {
      const body = Uint8Array.from(new Uint8Array(value));
      const object: FakeR2Object = {
        body,
        httpMetadata: { ...put.httpMetadata },
        customMetadata: { ...put.customMetadata },
        etag: createHash('md5').update(body).digest('hex'),
        uploaded: new Date(),
      };
      objects.set(key, object);
      return r2Object(key, object);
    },
    async head(key: string) {
      const object = objects.get(key);
      return object ? r2Object(key, object) : null;
    },
    async get(key: string) {
      const object = objects.get(key);
      if (!object) return null;
      const copy = object.body.slice();
      return {
        ...r2Object(key, object),
        body: new Blob([copy]).stream(),
        bodyUsed: false,
        arrayBuffer: async () => copy.buffer,
        text: async () => new TextDecoder().decode(copy),
      };
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    async list(list: ListOptions = {}) {
      listCalls.push(list);
      const limit = Math.min(list.limit ?? 1000, options.pageSize ?? 1000);
      const keys = [...objects.keys()].filter((key) => key.startsWith(list.prefix ?? '')).sort();
      const start = list.cursor ? Number(list.cursor) : 0;
      const page = keys.slice(start, start + limit);
      const truncated = start + limit < keys.length;
      return {
        objects: page.map((key) => r2Object(key, objects.get(key)!, list.include ?? [])),
        truncated,
        ...(truncated ? { cursor: String(start + limit) } : {}),
        delimitedPrefixes: [],
      };
    },
  };

  // The fake covers only the methods RSilo calls, so it is not a full R2Bucket.
  return { bucket: bucket as unknown as R2Bucket, objects, listCalls };
}
