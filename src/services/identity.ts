// The human identity resolver (ADR-0001). Every human-facing surface asks it
// one question: is this request from the Owner?
//
// - Production: Cloudflare Access validates the Owner before the request
//   reaches the Worker and exposes the result as `ctx.access` on the Workers
//   ExecutionContext. It is set by the platform and cannot be forged by the
//   client. RSilo does no JWT parsing and ignores the Cf-Access-Jwt-Assertion
//   header and the CF_Authorization cookie entirely.
// - Development: a configured dev identity, reachable only when RSILO_DEV_MODE
//   is "true", `ctx.access` is absent and the request host is local. Access,
//   when present, always wins.
//
// Authorization is the identity's email equalling OWNER_EMAIL
// (case-insensitive). That check, not the Access policy, is what keeps an
// over-broad policy or another Access application from opening /account.

import type { Context } from '../types';
import { getInstanceConfig, getOwnerEmail, isLocalDevelopment } from '../config';
import type { InstanceConfig } from '../config';

/** The part of the Workers `ctx.access` RSilo uses. */
export interface AccessContext {
  aud: string;
  getIdentity(): Promise<{ email?: string } | undefined>;
}

/**
 * What the finish-setup page needs to know. Holds only config names, problem
 * descriptions that never echo a configured value, and the visitor's own
 * Access email.
 */
export interface SetupState {
  /** Invalid ACCOUNT_USERNAME / PUBLIC_BASE_URL values. */
  configProblems: string[];
  /** Why OWNER_EMAIL is unusable, or null when it is fine. */
  ownerEmail: { problem: string; missing: boolean } | null;
  /** No Cloudflare Access in front of /account (and no dev identity). */
  accessMissing: boolean;
  /** The visitor's email as Cloudflare Access reports it, when there is one. */
  accessEmail: string | null;
}

export type OwnerResolution =
  | { status: 'owner'; email: string; config: InstanceConfig }
  | { status: 'forbidden'; email: string | null }
  | { status: 'not_configured'; setup: SetupState };

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

// Hono's c.executionCtx throws when the runtime supplied none (for example
// app.request() in tests, or the offline Node server).
function accessContext(c: Context): AccessContext | null {
  let ctx: unknown;
  try {
    ctx = c.executionCtx;
  } catch {
    return null;
  }
  const access = (ctx as { access?: Partial<AccessContext> } | undefined)?.access;
  return access && typeof access.getIdentity === 'function' ? access as AccessContext : null;
}

/**
 * True only when the dev identity may be used: dev mode, no Access context,
 * and a request to localhost / 127.0.0.1 / [::1]. Also gates /debug/*.
 */
export function devIdentityAllowed(c: Context): boolean {
  if (!isLocalDevelopment(c.env)) return false;
  if (accessContext(c)) return false;
  return LOCAL_HOSTNAMES.has(new URL(c.req.url).hostname);
}

/**
 * The signed-in email: from Access, else the dev identity. `null` when Access
 * is present but reports no email; `undefined` when there is no identity
 * source at all (Access is not protecting this request).
 */
async function identityEmail(c: Context, ownerEmail: string | null): Promise<string | null | undefined> {
  const access = accessContext(c);
  if (access) {
    try {
      const identity = await access.getIdentity();
      return identity?.email?.trim() || null;
    } catch {
      return null;
    }
  }
  if (devIdentityAllowed(c)) {
    const devEmail = (c.env as { RSILO_DEV_EMAIL?: string } | undefined)?.RSILO_DEV_EMAIL?.trim();
    return devEmail || ownerEmail;
  }
  return undefined;
}

export async function resolveOwner(c: Context): Promise<OwnerResolution> {
  const instance = getInstanceConfig(c.env, c.req.url);
  const owner = getOwnerEmail(c.env);
  const ownerEmail = 'email' in owner ? owner.email : null;
  const email = await identityEmail(c, ownerEmail);

  const setup: SetupState = {
    configProblems: 'problems' in instance ? instance.problems : [],
    ownerEmail: 'problem' in owner ? { problem: owner.problem, missing: owner.missing } : null,
    accessMissing: email === undefined,
    accessEmail: accessContext(c) ? email ?? null : null,
  };
  if ('problems' in instance || !ownerEmail || email === undefined) return { status: 'not_configured', setup };

  if (email === null || email.toLowerCase() !== ownerEmail) {
    return { status: 'forbidden', email };
  }
  return { status: 'owner', email, config: instance.config };
}

/**
 * CSRF check for state-changing requests on the human surfaces: the browser
 * must say the request is same-origin, or, for browsers that do not send
 * Sec-Fetch-Site, send an Origin equal to the resolved public origin
 * (PUBLIC_BASE_URL, or the request's own origin when unset). The Access
 * cookie's SameSite setting is configurable in the Zero Trust dashboard, so it
 * is not relied on.
 */
export function isSameOriginRequest(c: Context, publicBaseUrl: string): boolean {
  const site = c.req.header('Sec-Fetch-Site');
  if (site !== undefined) return site === 'same-origin';
  return c.req.header('Origin') === publicBaseUrl;
}
