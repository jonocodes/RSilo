import type { R2Bucket, R2ListOptions } from '@cloudflare/workers-types';
import type { StorageGetOptions, StorageInterface, WriteCondition } from '../types';
import { configurationMessage, getStorageConfig } from '../config';
import { stripQuotes } from '../protocol/constants';
import { S3Storage } from './s3';
import { conditionHolds, PreconditionFailedError } from './storage-errors';

// Normalises the storage backend to the StorageInterface the routes expect.
// S3_* vars select an S3-compatible bucket (ADR-0005). Otherwise, in the Worker
// runtime STORAGE is a raw R2Bucket; offline it is a LocalStorage instance (or
// a test double) that already implements the interface.
export function getStorage(c: any): StorageInterface {
  const config = getStorageConfig(c.env);
  // Routes resolve getInstanceConfig() first, which answers 503 for these.
  if ('problems' in config) throw new Error(configurationMessage(config.problems));
  if (config.s3) return new S3Storage(config.s3);

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

  async get(key: string, options?: StorageGetOptions): Promise<{ body: ArrayBuffer | ReadableStream<Uint8Array>; metadata: BlobMetadata } | null> {
    const object = await this.bucket.get(key, options?.range ? { range: options.range } : undefined);
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

  async put(key: string, body: ArrayBuffer, contentType: string, condition?: WriteCondition): Promise<string> {
    const object = await this.bucket.put(key, body, {
      httpMetadata: { contentType },
      onlyIf: r2OnlyIf(condition),
    });
    // R2 checks onlyIf atomically and answers a failed one with null, storing nothing.
    if (!object) throw new PreconditionFailedError();
    return object.etag;
  }

  async delete(key: string, condition?: { ifMatch: string }): Promise<void> {
    // R2's delete takes no onlyIf, so a condition is checked with a HEAD
    // first: a write that lands between the two is deleted anyway.
    if (condition && !conditionHolds(await this.bucket.head(key), condition)) throw new PreconditionFailedError();
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

  async list(prefix: string, options: { limit?: number } = {}): Promise<{ objects: { key: string; size: number; etag: string; contentType?: string; lastModified?: string }[] }> {
    const objects: { key: string; size: number; etag: string; contentType?: string; lastModified?: string }[] = [];
    let cursor: string | undefined;
    const { limit } = options;

    do {
      // R2 omits httpMetadata (the content type) from listings unless asked.
      // `include` is missing from the default (oldest compatibility date)
      // R2ListOptions type, though this Worker's compatibility date needs it.
      const pageLimit = limit ? Math.min(1000, limit - objects.length) : undefined;
      const listed = await this.bucket.list({ prefix, cursor, limit: pageLimit, include: ['httpMetadata'] } as R2ListOptions);
      objects.push(...listed.objects.map(obj => ({
        key: obj.key,
        size: obj.size,
        etag: obj.etag,
        contentType: obj.httpMetadata?.contentType,
        lastModified: (obj as any).uploaded?.toISOString?.(),
      })));

      if (!listed.truncated || (limit && objects.length >= limit)) break;
      if (!listed.cursor) throw new Error('R2 returned a truncated listing without a cursor');
      cursor = listed.cursor;
    } while (cursor);

    return { objects };
  }
}

// R2 takes conditional request headers as onlyIf, with the ETag quoted.
function r2OnlyIf(condition: WriteCondition | undefined): Headers | undefined {
  if (condition?.ifMatch !== undefined) return new Headers({ 'If-Match': `"${stripQuotes(condition.ifMatch)}"` });
  if (condition?.ifNoneMatch === '*') return new Headers({ 'If-None-Match': '*' });
  return undefined;
}

export function buildKey(userId: string, path: string): string {
  return `users/${userId}/storage/${path}`;
}