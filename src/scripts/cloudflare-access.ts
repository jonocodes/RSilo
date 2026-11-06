// Cloudflare Access for `bun run setup` (#61): makes sure a self-hosted Access
// app protects <host>/account and lets only OWNER_EMAIL in, by one-time PIN.
// Talks to the Cloudflare API with an API token (wrangler's OAuth login has no
// Access scope); the fetch is injectable, so it is unit-tested against
// test/helpers/fake-cloudflare-api.ts.

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
/** The only path behind Access (ADR-0001); /storage and WebFinger must stay open. */
export const ACCESS_PATH = 'account';
export const ACCESS_APP_NAME = 'RSilo';
export const OWNER_POLICY_NAME = 'RSilo owner';

export class CloudflareApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }

  /** The token was refused: wrong, expired, or without the Access permissions. */
  get refused(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface CloudflareApi {
  /** Calls an account-level endpoint (`path` is relative to /accounts/:id) and returns `result`. */
  call<T>(method: string, path: string, body?: unknown): Promise<T>;
}

export function cloudflareApi(options: {
  token: string;
  accountId: string;
  baseUrl?: string;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
}): CloudflareApi {
  const { token, accountId, baseUrl = CLOUDFLARE_API_BASE, fetch = globalThis.fetch } = options;
  return {
    async call<T>(method: string, path: string, body?: unknown): Promise<T> {
      const res = await fetch(`${baseUrl}/accounts/${accountId}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as
        | { success?: boolean; errors?: { code?: number; message?: string }[]; result?: T }
        | null;
      if (!res.ok || !json?.success) {
        const detail = json?.errors?.map((e) => `${e.message ?? 'error'}${e.code ? ` (${e.code})` : ''}`).join('; ');
        throw new CloudflareApiError(res.status, `${method} ${path}: HTTP ${res.status}${detail ? `, ${detail}` : ''}`);
      }
      return json.result as T;
    },
  };
}

interface IdentityProvider {
  id: string;
  type: string;
}

interface AccessPolicy {
  id: string;
  name: string;
  decision: string;
  include?: unknown[];
  exclude?: unknown[];
  require?: unknown[];
  reusable?: boolean;
  precedence?: number;
}

interface AccessApp {
  id: string;
  type: string;
  domain?: string;
  self_hosted_domains?: string[];
  destinations?: { type?: string; uri?: string }[];
  policies?: AccessPolicy[];
}

export type AccessResult =
  | { status: 'created' | 'updated' | 'unchanged'; appId: string }
  /** The app's Allow policy is a reusable one other apps use too, so it was left as is. */
  | { status: 'shared-policy'; appId: string; policyName: string }
  /** The account has no Zero Trust organization: the Owner must pick a team name and plan in the dashboard. */
  | { status: 'no-zero-trust'; detail: string };

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/** Every hostname+path the app protects, normalized. */
function appDomains(app: AccessApp): string[] {
  const all = [app.domain, ...(app.self_hosted_domains ?? []), ...(app.destinations ?? []).map((d) => d.uri)];
  return all.filter((d): d is string => Boolean(d)).map(normalizeDomain);
}

/** True when the policy includes exactly `ownerEmail` (case-insensitive) and nothing else. */
function includesOnly(policy: AccessPolicy, ownerEmail: string): boolean {
  const include = policy.include ?? [];
  if (include.length !== 1) return false;
  const email = (include[0] as { email?: { email?: unknown } }).email?.email;
  return typeof email === 'string' && email.toLowerCase() === ownerEmail.toLowerCase();
}

/** The id of the account's one-time PIN login method, created if missing. */
async function oneTimePinId(api: CloudflareApi): Promise<string> {
  const idps = await api.call<IdentityProvider[]>('GET', '/access/identity_providers');
  const existing = idps.find((idp) => idp.type === 'onetimepin');
  if (existing) return existing.id;
  return (await api.call<IdentityProvider>('POST', '/access/identity_providers', { name: 'One-time PIN', type: 'onetimepin', config: {} })).id;
}

function ownerInclude(ownerEmail: string) {
  return [{ email: { email: ownerEmail } }];
}

/**
 * Points the app's Allow policy at `ownerEmail`, keeping its name and any
 * exclude/require rules. A reusable policy is edited only when no other app
 * uses it: changing it would change who may open those apps too.
 */
async function updateOwnerPolicy(api: CloudflareApi, appId: string, owner: AccessPolicy, ownerEmail: string): Promise<AccessResult> {
  const body = {
    name: owner.name,
    decision: owner.decision,
    include: ownerInclude(ownerEmail),
    exclude: owner.exclude ?? [],
    require: owner.require ?? [],
  };
  if (owner.reusable) {
    const { app_count: appCount } = await api.call<{ app_count?: number }>('GET', `/access/policies/${owner.id}`);
    if ((appCount ?? 1) > 1) return { status: 'shared-policy', appId, policyName: owner.name };
    await api.call('PUT', `/access/policies/${owner.id}`, body);
  } else {
    await api.call('PUT', `/access/apps/${appId}/policies/${owner.id}`, { ...body, precedence: owner.precedence });
  }
  return { status: 'updated', appId };
}

/**
 * Makes sure Access protects `<host>/account` for `ownerEmail`. Safe to re-run:
 * it finds the app by hostname and path and never creates a second one.
 * Throws CloudflareApiError when the API refuses or fails.
 */
export async function ensureAccessApp(api: CloudflareApi, opts: { host: string; ownerEmail: string }): Promise<AccessResult> {
  const domain = `${opts.host.toLowerCase()}/${ACCESS_PATH}`;
  try {
    await api.call('GET', '/access/organizations');
  } catch (err) {
    // What a never-onboarded account answers is not documented; anything but
    // a refused token is reported as "set up Zero Trust", with Cloudflare's words.
    if (err instanceof CloudflareApiError && !err.refused) return { status: 'no-zero-trust', detail: err.message };
    throw err;
  }
  const apps =await api.call<AccessApp[]>('GET', '/access/apps');
  const existing = apps.find((app) => app.type === 'self_hosted' && appDomains(app).includes(domain));
  if (existing) {
    const owner = (existing.policies ?? []).find((p) => p.decision === 'allow');
    if (owner && includesOnly(owner, opts.ownerEmail)) return { status: 'unchanged', appId: existing.id };
    if (owner) return updateOwnerPolicy(api, existing.id, owner, opts.ownerEmail);
    const last = Math.max(0, ...(existing.policies ?? []).map((p) => p.precedence ?? 0));
    await api.call('POST', `/access/apps/${existing.id}/policies`, {
      name: OWNER_POLICY_NAME,
      decision: 'allow',
      include: ownerInclude(opts.ownerEmail),
      precedence: last + 1,
    });
    return { status: 'updated', appId: existing.id };
  }

  const idp = await oneTimePinId(api);
  const app = await api.call<AccessApp>('POST', '/access/apps', {
    name: ACCESS_APP_NAME,
    type: 'self_hosted',
    domain,
    destinations: [{ type: 'public', uri: domain }],
    allowed_idps: [idp],
    auto_redirect_to_identity: true,
    policies: [{ name: OWNER_POLICY_NAME, decision: 'allow', include: ownerInclude(opts.ownerEmail), precedence: 1 }],
  });
  return { status: 'created', appId: app.id };
}
