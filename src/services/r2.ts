import type { R2Bucket } from '@cloudflare/workers-types';
import type { StorageInterface } from '../types';

// Normalises the storage binding to the StorageInterface the routes expect.
// In the Worker runtime STORAGE is a raw R2Bucket; offline it is a LocalStorage
// instance (or a test double) that already implements the interface.
export function getStorage(c: any): StorageInterface {
  const raw = c.env.STORAGE;
  if (raw && typeof raw.createMultipartUpload === 'function') {
    return new R2Storage(raw as R2Bucket);
  }
  return raw as StorageInterface;
}

export interface BlobMetadata {
  contentType: string;
  contentLength: number;
  etag: string;
  lastModified?: string;
}

export class R2Storage {
  constructor(private bucket: R2Bucket) {}

  async get(key: string): Promise<{ body: ArrayBuffer | ReadableStream<Uint8Array>; metadata: BlobMetadata } | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;

    const body = object.body || await object.arrayBuffer();
    const metadata: BlobMetadata = {
      contentType: (object as any).contentType || (object as any).metadata?.contentType || (object as any).httpMetadata?.contentType || 'application/octet-stream',
      contentLength: object.size ?? (object as any).metadata?.contentLength ?? (body instanceof ArrayBuffer ? body.byteLength : 0),
      etag: (object as any).etag ?? (object as any).metadata?.etag ?? null,
      lastModified: (object as any).uploaded?.toISOString?.() ?? (object as any).lastModified,
    };

    return { body, metadata };
  }

  async put(key: string, body: ArrayBuffer, contentType: string): Promise<string> {
    const object = await this.bucket.put(key, body, {
      httpMetadata: { contentType },
      customMetadata: { uploaded: new Date().toISOString() },
    });
    return object.etag;
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async head(key: string): Promise<BlobMetadata | null> {
    const object = await this.bucket.head(key);
    if (!object) return null;
    return {
      contentType: object.httpMetadata?.contentType || 'application/octet-stream',
      contentLength: object.size,
      etag: object.etag,
      lastModified: (object as any).uploaded?.toISOString?.() ?? (object as any).lastModified,
    };
  }

  async list(prefix: string): Promise<{ objects: { key: string; size: number; etag: string; contentType?: string; lastModified?: string }[] }> {
    const objects: { key: string; size: number; etag: string; contentType?: string; lastModified?: string }[] = [];
    let cursor: string | undefined;

    do {
      const listed = await this.bucket.list({ prefix, cursor });
      objects.push(...listed.objects.map(obj => ({
        key: obj.key,
        size: obj.size,
        etag: obj.etag,
        contentType: obj.httpMetadata?.contentType,
        lastModified: (obj as any).uploaded?.toISOString?.(),
      })));

      if (!listed.truncated) break;
      if (!listed.cursor) throw new Error('R2 returned a truncated listing without a cursor');
      cursor = listed.cursor;
    } while (cursor);

    return { objects };
  }
}

export function buildKey(userId: string, path: string): string {
  return `users/${userId}/storage/${path}`;
}