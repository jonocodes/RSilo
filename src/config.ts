import type { AppEnv } from './types';

type DevModeEnv = Partial<Pick<AppEnv, 'RSILO_DEV_MODE'>>;

export function isLocalDevelopment(env?: unknown): boolean {
  const bindings = (typeof env === 'object' && env !== null ? env : {}) as DevModeEnv;
  if (bindings.RSILO_DEV_MODE !== undefined) {
    return bindings.RSILO_DEV_MODE === 'true';
  }
  return typeof process !== 'undefined' && process.env.RSILO_DEV_MODE === 'true';
}

// Per-Instance identity: the one Account it serves, the Owner allowed into
// /account, and the one origin every advertised URL is built from.
//
// - OWNER_EMAIL is the only required setting. Without a valid one the human
//   surfaces (/account, including consent) show the finish-setup page, while
//   storage, discovery and the token endpoint keep working, so apps already
//   connected keep syncing.
// - ACCOUNT_USERNAME defaults to DEFAULT_ACCOUNT_USERNAME ("me").
// - PUBLIC_BASE_URL defaults to the request's own origin. On Cloudflare
//   Workers that is trustworthy: the edge answers 403 to a Host that is not
//   one of the Worker's own hostnames, so such a request never reaches the
//   Worker. X-Forwarded-* and the raw Host header are never consulted.
//
// Dev mode (RSILO_DEV_MODE=true) keeps fixed defaults instead: username
// "alice", Owner alice@example.com and origin http://localhost:8787, so local
// servers (where nothing vets the Host header) and tests work unconfigured.
export const DEFAULT_ACCOUNT_USERNAME = 'me';
export const DEV_ACCOUNT_USERNAME = 'alice';
export const DEV_OWNER_EMAIL = 'alice@example.com';
export const DEV_PUBLIC_BASE_URL = 'http://localhost:8787';

const ACCOUNT_USERNAME_PATTERN = /^[a-z0-9_.-]+$/;
const OWNER_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

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

export type OwnerEmailResult =
  | { ok: true; email: string }
  | { ok: false; problem: string; missing: boolean };

type InstanceEnv = Partial<Pick<AppEnv, 'ACCOUNT_USERNAME' | 'OWNER_EMAIL' | 'PUBLIC_BASE_URL'>>;

function instanceEnv(env: unknown): InstanceEnv {
  return (typeof env === 'object' && env !== null ? env : {}) as InstanceEnv;
}

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

// Per-field rules for a present (trimmed, non-empty) value: each returns the
// problem, or null if valid. The setup script reuses them so it accepts exactly
// what the Worker accepts. The messages never echo the value.
export function accountUsernameProblem(value: string): string | null {
  return ACCOUNT_USERNAME_PATTERN.test(value) && value !== '.' && value !== '..'
    ? null
    : 'ACCOUNT_USERNAME must match [a-z0-9_.-]+';
}

export function ownerEmailProblem(value: string): string | null {
  return OWNER_EMAIL_PATTERN.test(value) ? null : 'OWNER_EMAIL must be an email address';
}

export function publicBaseUrlProblem(value: string): string | null {
  return parsePublicBaseUrl(value)
    ? null
    : 'PUBLIC_BASE_URL must be an http(s) origin such as https://rsilo.example.workers.dev';
}

export const OWNER_EMAIL_NOT_SET = 'OWNER_EMAIL is not set';

/**
 * The Account username and public origin for one request; the only place
 * either is decided. `requestUrl` is the request's own URL (c.req.url), whose
 * origin is used when PUBLIC_BASE_URL is unset. Unset values have defaults, so
 * only an invalid value is a problem.
 */
export function getInstanceConfig(env: unknown, requestUrl: string): InstanceConfigResult {
  const bindings = instanceEnv(env);
  const problems: string[] = [];

  const accountUsername = bindings.ACCOUNT_USERNAME?.trim()
    || (isLocalDevelopment(env) ? DEV_ACCOUNT_USERNAME : DEFAULT_ACCOUNT_USERNAME);
  const usernameProblem = accountUsernameProblem(accountUsername);
  if (usernameProblem) problems.push(usernameProblem);

  const rawBaseUrl = bindings.PUBLIC_BASE_URL?.trim() || (isLocalDevelopment(env) ? DEV_PUBLIC_BASE_URL : '');
  const baseUrl = rawBaseUrl ? parsePublicBaseUrl(rawBaseUrl) : new URL(new URL(requestUrl).origin);
  if (!baseUrl) problems.push(publicBaseUrlProblem(rawBaseUrl) ?? 'PUBLIC_BASE_URL is invalid');

  if (problems.length > 0 || !baseUrl) return { ok: false, problems };
  return {
    ok: true,
    config: { accountUsername, publicBaseUrl: baseUrl.origin, publicHost: baseUrl.host },
  };
}

/**
 * The Owner's email, lowercased (see services/identity.ts). Required outside
 * dev mode, but it gates only the human surfaces.
 */
export function getOwnerEmail(env: unknown): OwnerEmailResult {
  const raw = instanceEnv(env).OWNER_EMAIL?.trim() || (isLocalDevelopment(env) ? DEV_OWNER_EMAIL : '');
  if (!raw) return { ok: false, problem: OWNER_EMAIL_NOT_SET, missing: true };
  const email = raw.toLowerCase();
  const problem = ownerEmailProblem(email);
  return problem ? { ok: false, problem, missing: false } : { ok: true, email };
}

/** Plain-text explanation of why the Instance cannot serve requests yet. */
export function configurationMessage(problems: string[]): string {
  return `RSilo is not configured: ${problems.join('; ')}.`;
}
