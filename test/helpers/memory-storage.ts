// An in-memory StorageInterface (src/types.ts) for route tests: the shape every
// backend presents to the routes, with content types kept, content-derived
// quoted ETags (as S3 gives) and recursive, prefix-filtered, sorted listings.
// test/storage-contract.test.ts holds it to the same contract as the real
// backends. Tests can inspect `objects`, seed it with seed(), and replace a
// method on an instance to simulate a failing backend.

import { createHash } from 'node:crypto';
import type { StorageInterface } from '../../src/types';

export interface MemoryObject {
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
  etag: string;
  lastModified: Date;
}

type Metadata = NonNullable<Awaited<ReturnType<StorageInterface['head']>>>;
type Listing = Awaited<ReturnType<StorageInterface['list']>>;

function metadata(object: MemoryObject): Metadata {
  return {
    contentType: object.contentType,
    contentLength: object.body.byteLength,
    etag: object.etag,
    lastModified: object.lastModified.toISOString(),
  };
}

export class MemoryStorage implements StorageInterface {
  readonly objects = new Map<string, MemoryObject>();

  async get(key: string): ReturnType<StorageInterface['get']> {
    const object = this.objects.get(key);
    return object ? { body: object.body.slice().buffer, metadata: metadata(object) } : null;
  }

  async put(key: string, body: ArrayBuffer, contentType: string): Promise<string> {
    return this.seed(key, new Uint8Array(body), contentType);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async head(key: string): Promise<Metadata | null> {
    const object = this.objects.get(key);
    return object ? metadata(object) : null;
  }

  async list(prefix: string): Promise<Listing> {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    return {
      objects: keys.map((key) => {
        const object = this.objects.get(key)!;
        return { key, size: object.body.byteLength, etag: object.etag, contentType: object.contentType, lastModified: object.lastModified.toISOString() };
      }),
    };
  }

  /** Stores a copy of `body` synchronously, as put() does, and returns its ETag. */
  seed(key: string, body: string | Uint8Array, contentType = 'text/plain'): string {
    const bytes = Uint8Array.from(typeof body === 'string' ? new TextEncoder().encode(body) : body);
    const etag = `"${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}"`;
    this.objects.set(key, { body: bytes, contentType, etag, lastModified: new Date() });
    return etag;
  }

  /** The stored body as text, or undefined when the key is absent. */
  text(key: string): string | undefined {
    const object = this.objects.get(key);
    return object && new TextDecoder().decode(object.body);
  }
}
