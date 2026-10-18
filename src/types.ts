import type { R2Bucket, RateLimit } from '@cloudflare/workers-types';

export interface AppEnv {
  /** R2 bucket. Unused, and may be absent, when the S3_* vars are set (ADR-0005). */
  STORAGE?: R2Bucket;
  DB: D1Database;
  STORAGE_LIMITER?: RateLimit;
  RSILO_DEV_MODE?: string;
  /** Dev mode only: email of the local dev identity. Defaults to OWNER_EMAIL. */
  RSILO_DEV_EMAIL?: string;
  /** The one Account this Instance serves. Optional; defaults to "me" ("alice" in dev mode). */
  ACCOUNT_USERNAME?: string;
  /** The Owner's email as Cloudflare Access reports it. The only required setting; gates /account only. */
  OWNER_EMAIL?: string;
  /** Canonical origin for advertised URLs (e.g. a custom domain). Optional; defaults to the request's origin. */
  PUBLIC_BASE_URL?: string;
  MAX_OBJECT_SIZE_BYTES?: string;
  /** S3-compatible storage instead of R2 (ADR-0005). All but S3_REGION are required once any is set. */
  S3_ENDPOINT?: string;
  S3_BUCKET?: string;
  S3_REGION?: string;
  S3_ACCESS_KEY_ID?: string;
  /** The only secret RSilo reads; set with `wrangler secret put`, never in [vars]. */
  S3_SECRET_ACCESS_KEY?: string;
}

/**
 * A precondition on a write. `ifMatch` is a stored object's ETag, as head()
 * returns it (quoted or not); `ifNoneMatch: '*'` means "only if absent".
 */
export interface WriteCondition {
  ifMatch?: string;
  ifNoneMatch?: '*';
}

export interface StorageInterface {
  get(key: string): Promise<{ body: ArrayBuffer | ReadableStream<Uint8Array>; metadata: { contentType: string; contentLength: number; etag: string; lastModified?: string } } | null>;
  /**
   * Stores the object and returns its ETag. With a condition that does not
   * hold, stores nothing and throws PreconditionFailedError
   * (services/storage-errors.ts). R2Storage and LocalStorage check it
   * atomically; S3Storage checks it with a HEAD first (see s3.ts).
   */
  put(key: string, body: ArrayBuffer, contentType: string, condition?: WriteCondition): Promise<string>;
  /** Deletes the object (a no-op when absent); with a condition, as put(). Never atomic on R2 or S3. */
  delete(key: string, condition?: { ifMatch: string }): Promise<void>;
  head(key: string): Promise<{ contentType: string; contentLength: number; etag: string; lastModified?: string } | null>;
  /** Every object whose key starts with `prefix`, in key order; with `limit`, only the first that many. */
  list(prefix: string, options?: { limit?: number }): Promise<{ objects: { key: string; size: number; etag: string; contentType?: string; lastModified?: string }[] }>;
}

export type Context = import('hono').Context;
export type Next = import('hono').Next;
