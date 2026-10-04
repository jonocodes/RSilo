import type { R2Bucket } from '@cloudflare/workers-types';

export interface BlobMetadata {
  contentType: string;
  contentLength: number;
  etag: string;
  lastModified?: string;
}

export class R2Storage {
  constructor(private bucket: R2Bucket) {}

  async get(key: string): Promise<{ body: ArrayBuffer; metadata: BlobMetadata } | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;

    let body: ArrayBuffer;
    if (typeof object.arrayBuffer === 'function') {
      body = await object.arrayBuffer();
    } else {
      body = (object as any).body;
    }

    const metadata: BlobMetadata = {
      contentType: (object as any).contentType || (object as any).metadata?.contentType || 'application/octet-stream',
      contentLength: object.size ?? (object as any).metadata?.contentLength ?? body.byteLength,
      etag: (object as any).etag ?? (object as any).metadata?.etag ?? null,
      lastModified: (object as any).lastModified,
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
      lastModified: (object as any).lastModified,
    };
  }

  async list(prefix: string): Promise<{ objects: { key: string; size: number; etag: string }[] }> {
    const listed = await this.bucket.list({ prefix });
    return {
      objects: listed.objects.map(obj => ({
        key: obj.key,
        size: obj.size,
        etag: obj.etag,
      })),
    };
  }
}

export function buildKey(userId: string, path: string): string {
  return `users/${userId}/storage/${path}`;
}