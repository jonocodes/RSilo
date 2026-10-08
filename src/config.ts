import type { AppEnv } from './types';

const DEV_SESSION_SECRET = 'dev-session-secret-change-in-production';

type SecurityEnv = Partial<Pick<AppEnv, 'SESSION_SECRET' | 'ADMIN_SECRET' | 'RSILO_DEV_MODE'>>;

function securityEnv(env: unknown): SecurityEnv {
  return typeof env === 'object' && env !== null ? env as SecurityEnv : {};
}

export function isLocalDevelopment(env?: unknown): boolean {
  const bindings = securityEnv(env);
  if (bindings.RSILO_DEV_MODE !== undefined) {
    return bindings.RSILO_DEV_MODE === 'true';
  }
  return typeof process !== 'undefined' && process.env.RSILO_DEV_MODE === 'true';
}

export function getSessionSecret(env?: unknown): string | null {
  const secret = securityEnv(env).SESSION_SECRET;
  if (secret) return secret;
  return isLocalDevelopment(env) ? DEV_SESSION_SECRET : null;
}

export function getAdminSecret(env?: unknown): string | null {
  return securityEnv(env).ADMIN_SECRET || null;
}

// Per-Instance identity: the one Account it serves and the one origin every
// advertised URL is built from. Both are required outside dev mode; in dev mode
// they default to the values below so local servers and tests work unconfigured.
export const DEV_ACCOUNT_USERNAME = 'alice';
export const DEV_PUBLIC_BASE_URL = 'http://localhost:8787';

const ACCOUNT_USERNAME_PATTERN = /^[a-z0-9_.-]+$/;

export interface InstanceConfig {
  /** The Account's username; storage keys and token subjects use it verbatim. */
  accountUsername: string;
  /** Origin advertised in every URL, without a trailing slash. */
  publicBaseUrl: string;
  /** Normalised host of publicBaseUrl: lowercase, non-default port included. */
  publicHost: string;
}

export type InstanceConfigResult =
  | { ok: true; config: InstanceConfig }
  | { ok: false; problems: string[] };

type InstanceEnv = Partial<Pick<AppEnv, 'ACCOUNT_USERNAME' | 'PUBLIC_BASE_URL'>>;

function parsePublicBaseUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null;
  return url;
}

export function getInstanceConfig(env?: unknown): InstanceConfigResult {
  const bindings = (typeof env === 'object' && env !== null ? env : {}) as InstanceEnv;
  const dev = isLocalDevelopment(env);
  const problems: string[] = [];

  const accountUsername = bindings.ACCOUNT_USERNAME?.trim() || (dev ? DEV_ACCOUNT_USERNAME : '');
  if (!accountUsername) {
    problems.push('ACCOUNT_USERNAME is not set');
  } else if (!ACCOUNT_USERNAME_PATTERN.test(accountUsername) || accountUsername === '.' || accountUsername === '..') {
    problems.push('ACCOUNT_USERNAME must match [a-z0-9_.-]+');
  }

  const rawBaseUrl = bindings.PUBLIC_BASE_URL?.trim() || (dev ? DEV_PUBLIC_BASE_URL : '');
  const baseUrl = rawBaseUrl ? parsePublicBaseUrl(rawBaseUrl) : null;
  if (!rawBaseUrl) {
    problems.push('PUBLIC_BASE_URL is not set');
  } else if (!baseUrl) {
    problems.push('PUBLIC_BASE_URL must be an http(s) origin such as https://rsilo.example.workers.dev');
  }

  if (problems.length > 0 || !baseUrl) return { ok: false, problems };
  return {
    ok: true,
    config: { accountUsername, publicBaseUrl: baseUrl.origin, publicHost: baseUrl.host },
  };
}

/** Plain-text explanation of why the Instance cannot serve requests yet. */
export function configurationMessage(problems: string[]): string {
  return `RSilo is not configured: ${problems.join('; ')}.`;
}
