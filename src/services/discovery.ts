import type { InstanceConfig } from '../config';

// Every URL the Instance advertises is built here, from PUBLIC_BASE_URL only.
// The request's Host / X-Forwarded-Proto are never consulted: Cloudflare Access
// applications are hostname-bound, so advertising another host could route the
// Owner around the Access gate.

export interface AccountUrls {
  base: string;
  storageRoot: string;
  authorize: string;
  token: string;
  lrddTemplate: string;
}

export function accountUrls(config: InstanceConfig): AccountUrls {
  const base = config.publicBaseUrl;
  const user = config.accountUsername;
  return {
    base,
    storageRoot: `${base}/storage/${user}`,
    // The consent page lives under the Access-guarded /account prefix and is
    // always for the Account, so it carries no username (ADR-0004).
    authorize: `${base}/account/oauth/authorize`,
    token: `${base}/oauth/${user}/token`,
    lrddTemplate: `${base}/webfinger/jrd?resource={uri}`,
  };
}

// Lowercases the host and drops the scheme's default port, so `RS.example:443`
// and `rs.example` compare equal for https while a non-default port must match.
function normaliseHost(host: string, protocol: string): string | null {
  if (!host || /[\s/?#@\\]/.test(host)) return null;
  try {
    const url = new URL(`${protocol}//${host}`);
    return url.host;
  } catch {
    return null;
  }
}

/**
 * True when a WebFinger `resource` names the Account. Accepted forms:
 * - `acct:<ACCOUNT_USERNAME>@<host>` (scheme, username and host case-insensitive);
 *   the port may be omitted, since clients often build it from the bare hostname
 * - `http://<host>` / `https://<host>`, with or without a trailing slash
 * where `<host>` equals the PUBLIC_BASE_URL host, including a non-default port.
 */
export function isAccountResource(resource: string, config: InstanceConfig): boolean {
  const { protocol, hostname } = new URL(config.publicBaseUrl);

  const acct = /^acct:([^@]+)@([^@]+)$/i.exec(resource);
  if (acct) {
    const [, user, host] = acct;
    const normalised = normaliseHost(host, protocol);
    return user.toLowerCase() === config.accountUsername
      && (normalised === config.publicHost || normalised === hostname);
  }

  const hostOnly = /^(https?:)\/\/([^/?#]+)\/?$/i.exec(resource);
  if (hostOnly) {
    const [, scheme, host] = hostOnly;
    // A host-only resource carries its own scheme, so that scheme's default
    // port is the one dropped before comparing.
    return normaliseHost(host, scheme.toLowerCase()) === config.publicHost;
  }

  return false;
}
