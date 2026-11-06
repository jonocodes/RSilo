// An in-memory Cloudflare API for the Access endpoints `bun run setup` uses
// (src/scripts/cloudflare-access.ts): the Zero Trust organization, identity
// providers, self-hosted apps with app-scoped policies, and reusable policies.
// It answers in Cloudflare's { success, errors, result } envelope, refuses any
// other bearer token with 403 / code 10000 as Cloudflare does, and shapes app
// policies the way GET /access/apps returns them (checked against the real API
// in the #61 spike), paginating that list as Cloudflare's list endpoints do
// (page / per_page, default 25, with result_info). It does not validate
// request bodies beyond what it stores.

export interface FakeIdentityProvider {
  id: string;
  name: string;
  type: string;
}

export interface FakePolicy {
  [setting: string]: unknown;
  id: string;
  name: string;
  decision: string;
  include: unknown[];
  exclude: unknown[];
  require: unknown[];
}

export interface FakeApp {
  id: string;
  name: string;
  type: string;
  domain: string;
  self_hosted_domains: string[];
  destinations: { type: string; uri: string }[];
  allowed_idps: string[];
  auto_redirect_to_identity: boolean;
  /** App-scoped (non-reusable) policies, in precedence order. */
  policies: FakePolicy[];
  /** Ids of reusable policies, in precedence order after the app-scoped ones. */
  reusablePolicyIds: string[];
}

export interface FakeCloudflareState {
  token: string;
  accountId: string;
  /** null: Zero Trust was never set up on the account. */
  organization: { name: string; auth_domain: string } | null;
  identityProviders: FakeIdentityProvider[];
  apps: FakeApp[];
  reusablePolicies: FakePolicy[];
}

export interface FakeCloudflareApi {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  state: FakeCloudflareState;
  /** "METHOD /path-after-the-account" of each authenticated request. */
  requests: string[];
  /** The same, without GETs. */
  writes: () => string[];
}

export const FAKE_TOKEN = 'fake-access-token';
export const FAKE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
export const FAKE_API_BASE = 'https://api.cloudflare.test/client/v4';

let nextId = 1;
const newId = (prefix: string) => `${prefix}-${String(nextId++).padStart(4, '0')}`;

function envelope(status: number, result: unknown, errors: { code: number; message: string }[] = [], resultInfo?: unknown): Response {
  return Response.json({ success: errors.length === 0, errors, messages: [], result, result_info: resultInfo }, { status });
}

function page<T>(url: URL, all: T[]): Response {
  const perPage = Number(url.searchParams.get('per_page') ?? 25);
  const n = Number(url.searchParams.get('page') ?? 1);
  const items = all.slice((n - 1) * perPage, n * perPage);
  const totalPages = Math.max(1, Math.ceil(all.length / perPage));
  return envelope(200, items, [], { page: n, per_page: perPage, count: items.length, total_count: all.length, total_pages: totalPages });
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const notFound = () => envelope(404, null, [{ code: 7003, message: 'Could not route to the requested path' }]);

export function fakeCloudflareApi(init: Partial<FakeCloudflareState> = {}): FakeCloudflareApi {
  const state: FakeCloudflareState = {
    token: FAKE_TOKEN,
    accountId: FAKE_ACCOUNT_ID,
    organization: { name: 'team.cloudflareaccess.com', auth_domain: 'team.cloudflareaccess.com' },
    identityProviders: [{ id: 'otp-idp', name: '', type: 'onetimepin' }],
    apps: [],
    reusablePolicies: [],
    ...init,
  };
  const requests: string[] = [];

  const reusable = (id: string) => state.reusablePolicies.find((p) => p.id === id);
  const appCount = (id: string) => state.apps.filter((a) => a.reusablePolicyIds.includes(id)).length;

  function appView(app: FakeApp) {
    const { reusablePolicyIds, policies, ...rest } = app;
    const all = [
      ...policies.map((p) => ({ ...p, reusable: false })),
      ...reusablePolicyIds.map((id) => ({ ...reusable(id)!, reusable: true })),
    ];
    return { ...rest, policies: all.map((p, i) => ({ ...p, uid: p.id, precedence: i + 1 })) };
  }

  // Keeps any other policy settings (session_duration, approvals, …) as given.
  function policyFrom(body: Record<string, unknown>, id: string): FakePolicy {
    return {
      ...body,
      id,
      name: str(body.name),
      decision: str(body.decision),
      include: (body.include as unknown[]) ?? [],
      exclude: (body.exclude as unknown[]) ?? [],
      require: (body.require as unknown[]) ?? [],
    };
  }

  async function handle(request: Request): Promise<Response> {
    if (request.headers.get('authorization') !== `Bearer ${state.token}`) {
      return envelope(403, null, [{ code: 10000, message: 'Authentication error' }]);
    }
    const url = new URL(request.url);
    const prefix = `${new URL(FAKE_API_BASE).pathname}/accounts/${state.accountId}`;
    if (!url.pathname.startsWith(prefix)) {
      // Another account: Cloudflare refuses the token rather than saying "not found".
      return envelope(403, null, [{ code: 9109, message: 'Unauthorized to access requested resource' }]);
    }
    const path = url.pathname.slice(prefix.length);
    const method = request.method;
    requests.push(`${method} ${path}`);
    const body = method === 'GET' ? {} : (await request.json<Record<string, unknown>>());
    const parts = path.split('/').filter(Boolean); // access, <resource>, ...

    if (parts[0] !== 'access') return notFound();
    const [, resource, id, sub, subId] = parts;

    if (resource === 'organizations' && method === 'GET' && !id) {
      return state.organization
        ? envelope(200, state.organization)
        : envelope(404, null, [{ code: 9999, message: 'access.api.error.not_found' }]);
    }

    if (resource === 'identity_providers' && !id) {
      if (method === 'GET') return envelope(200, state.identityProviders);
      if (method === 'POST') {
        const idp = { id: newId('idp'), name: str(body.name), type: str(body.type) };
        state.identityProviders.push(idp);
        return envelope(200, idp);
      }
    }

    if (resource === 'apps') {
      if (!id && method === 'GET') return page(url, state.apps.map(appView));
      if (!id && method === 'POST') {
        const appId = newId('app');
        const destinations = (body.destinations as { type: string; uri: string }[]) ?? [];
        const app: FakeApp = {
          id: appId,
          name: str(body.name),
          type: str(body.type),
          domain: str(body.domain),
          self_hosted_domains: [str(body.domain)],
          destinations,
          allowed_idps: (body.allowed_idps as string[]) ?? [],
          auto_redirect_to_identity: Boolean(body.auto_redirect_to_identity),
          policies: ((body.policies as Record<string, unknown>[]) ?? []).map((p) => policyFrom(p, newId('policy'))),
          reusablePolicyIds: [],
        };
        state.apps.push(app);
        return envelope(201, appView(app));
      }
      const app = state.apps.find((a) => a.id === id);
      if (!app) return notFound();
      if (sub === 'policies' && !subId && method === 'POST') {
        const policy = policyFrom(body, newId('policy'));
        app.policies.push(policy);
        return envelope(200, policy);
      }
      if (sub === 'policies' && subId && method === 'PUT') {
        const i = app.policies.findIndex((p) => p.id === subId);
        if (i === -1) return notFound();
        app.policies[i] = policyFrom(body, subId);
        return envelope(200, app.policies[i]);
      }
    }

    if (resource === 'policies' && id) {
      const policy = reusable(id);
      if (!policy) return notFound();
      if (method === 'GET') return envelope(200, { ...policy, reusable: true, app_count: appCount(id) });
      if (method === 'PUT') {
        Object.assign(policy, policyFrom(body, id));
        return envelope(200, { ...policy, reusable: true, app_count: appCount(id) });
      }
    }

    return notFound();
  }

  return {
    fetch: (input, init) => handle(input instanceof Request ? input : new Request(input, init)),
    state,
    requests,
    writes: () => requests.filter((r) => !r.startsWith('GET ')),
  };
}

/** A self-hosted app as the dashboard would have made it by hand from the printed steps. */
export function manualApp(host: string, policies: FakePolicy[], reusablePolicyIds: string[] = []): FakeApp {
  const domain = `${host}/account`;
  return {
    id: newId('app'),
    name: 'RSilo',
    type: 'self_hosted',
    domain,
    self_hosted_domains: [domain],
    destinations: [{ type: 'public', uri: domain }],
    allowed_idps: [],
    auto_redirect_to_identity: false,
    policies,
    reusablePolicyIds,
  };
}

export function emailPolicy(email: string, name = 'Allow me'): FakePolicy {
  return { id: newId('policy'), name, decision: 'allow', include: [{ email: { email } }], exclude: [], require: [] };
}
