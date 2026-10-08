import type { R2Bucket, RateLimit } from '@cloudflare/workers-types';
import type { TokenPayload } from './services/auth';

export interface AppEnv {
  STORAGE: R2Bucket;
  DB: D1Database;
  LOGIN_LIMITER?: RateLimit;
  STORAGE_LIMITER?: RateLimit;
  ADMIN_SECRET?: string;
  SESSION_SECRET?: string;
  RSILO_DEV_MODE?: string;
  PUBLIC_BASE_URL?: string;
  MAX_OBJECT_SIZE_BYTES?: string;
}

export interface StorageInterface {
  get(key: string): Promise<{ body: ArrayBuffer | ReadableStream<Uint8Array>; metadata: { contentType: string; contentLength: number; etag: string; lastModified?: string } } | null>;
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