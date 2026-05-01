import type { R2Bucket, KVNamespace } from '@cloudflare/workers-types';
import type { TokenPayload } from './services/auth';

export interface AppEnv {
  STORAGE: R2Bucket;
  DB: D1Database;
  RATE_LIMIT_KV?: KVNamespace;
  ADMIN_SECRET?: string;
  SESSION_SECRET?: string;
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