import type { R2Bucket, RateLimit } from '@cloudflare/workers-types';
import type { TokenPayload } from './services/auth';

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

/** A byte range of an object: `length` bytes starting at `offset`. */
export interface StorageGetOptions {
  range?: { offset: number; length: number };
}

export interface StorageInterface {
  /** With `options.range` only those bytes are returned; metadata.contentLength stays the full size. */
  get(key: string, options?: StorageGetOptions): Promise<{ body: ArrayBuffer | ReadableStream<Uint8Array>; metadata: { contentType: string; contentLength: number; etag: string; lastModified?: string } } | null>;
  put(key: string, body: ArrayBuffer, contentType: string): Promise<string>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<{ contentType: string; contentLength: number; etag: string; lastModified?: string } | null>;
  list(prefix: string): Promise<{ objects: { key: string; size: number; etag: string; contentType?: string; lastModified?: string }[] }>;
}

export interface StorageContext {
  username: string;
  path: string;
  payload: TokenPayload;
}

declare module 'hono' {
  interface ContextVariableMap {
    tokenPayload: TokenPayload;
  }
}

export type Context = import('hono').Context;
export type Next = import('hono').Next;
