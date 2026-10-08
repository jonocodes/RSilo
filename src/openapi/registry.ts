export interface OperationParameter {
  name: string;
  in: 'query' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
}

export interface OperationMeta {
  summary: string;
  tags: string[];
  description?: string;
  security?: Array<Record<string, string[]>>;
  parameters?: OperationParameter[];
  responses?: Record<string, { description: string }>;
}

export const BEARER = [{ bearerAuth: [] }];
export const ACCESS = [{ cloudflareAccess: [] }];

const ACCOUNT_RESOURCE = 'acct:<ACCOUNT_USERNAME>@<host>, or http(s)://<host> with or without a trailing slash, '
  + 'where <host> is the PUBLIC_BASE_URL host (including a non-default port; acct: may omit it). Case-insensitive.';

/**
 * Metadata keyed by "METHOD /normalized/path". The spec's paths and methods are
 * derived from `app.routes`; this registry only supplies the human-facing
 * detail. `test/openapi.test.ts` fails if a route lacks an entry here, or if an
 * entry here matches no route — that is what keeps the docs honest.
 */
export const ROUTE_METADATA: Record<string, OperationMeta> = {
  'GET /': {
    summary: 'Landing page',
    tags: ['Meta'],
    description: 'Small HTML page describing the server.',
  },
  'GET /health': {
    summary: 'Liveness check',
    tags: ['Meta'],
  },

  'GET /.well-known/host-meta': {
    summary: 'host-meta XRD document',
    tags: ['WebFinger'],
    description: 'Legacy host-meta discovery, pointing at the JRD endpoint. Built from PUBLIC_BASE_URL.',
  },
  'GET /.well-known/webfinger': {
    summary: 'WebFinger discovery',
    tags: ['WebFinger'],
    description: 'Resolves the Account to its storage root and consent URL, built from PUBLIC_BASE_URL. '
      + 'Without a resource, returns the lrdd template.',
    parameters: [{ name: 'resource', in: 'query', required: false, schema: { type: 'string' }, description: ACCOUNT_RESOURCE }],
    responses: {
      '200': { description: 'JRD for the Account.' },
      '404': { description: 'The resource is not the Account.' },
    },
  },
  'GET /webfinger/jrd': {
    summary: 'JRD discovery',
    tags: ['WebFinger'],
    parameters: [{ name: 'resource', in: 'query', required: true, schema: { type: 'string' }, description: ACCOUNT_RESOURCE }],
    responses: {
      '200': { description: 'JRD for the Account.' },
      '404': { description: 'The resource is not the Account.' },
    },
  },
  'GET /webfinger/xrd': {
    summary: 'XRD discovery',
    tags: ['WebFinger'],
    parameters: [{ name: 'resource', in: 'query', required: false, schema: { type: 'string' }, description: ACCOUNT_RESOURCE }],
    responses: {
      '200': { description: 'XRD for the Account.' },
      '404': { description: 'The resource is not the Account.' },
    },
  },

  'GET /oauth/{user}': {
    summary: 'OAuth discovery document',
    tags: ['OAuth'],
    description: 'Advertises the auth and token endpoints plus supported scopes, built from PUBLIC_BASE_URL. '
      + '404 unless {user} is ACCOUNT_USERNAME.',
  },
  'GET /oauth/{user}/authorize': {
    summary: 'Legacy consent URL (redirect)',
    tags: ['OAuth'],
    description: 'Redirects to /account/oauth/authorize on PUBLIC_BASE_URL with the query string unchanged, '
      + 'for apps that cached the old discovery result.',
    responses: {
      '302': { description: 'To the consent page under /account.' },
      '404': { description: '{user} is not ACCOUNT_USERNAME.' },
    },
  },
  'POST /oauth/{user}/authorize': {
    summary: 'Legacy consent URL (no longer accepts submissions)',
    tags: ['OAuth'],
    responses: {
      '405': { description: 'Consent is submitted at /account/oauth/authorize.' },
      '404': { description: '{user} is not ACCOUNT_USERNAME.' },
    },
  },
  'POST /oauth/{user}/token': {
    summary: 'Exchange code or refresh token',
    tags: ['OAuth'],
    description: 'Supports grant_type=authorization_code and grant_type=refresh_token. Tokens are issued for the Account only.',
    responses: {
      '200': { description: 'Access token (and refresh token).' },
      '400': { description: 'invalid_grant.' },
      '404': { description: '{user} is not ACCOUNT_USERNAME.' },
    },
  },

  'GET /storage/{username}/public': {
    summary: 'Redirect to the public folder',
    tags: ['Public files'],
    responses: { '301': { description: 'Redirect to /storage/{username}/public/.' } },
  },
  'GET /storage/{username}/public/{path}': {
    summary: 'Read a public file',
    tags: ['Public files'],
    description: 'No authentication required for files under the public/ folder.',
  },
  'GET /storage/{username}/{path}': {
    summary: 'Get a file or folder listing',
    tags: ['Storage'],
    description: 'Paths ending in / return a folder listing. Supports If-None-Match.',
    security: BEARER,
    responses: {
      '200': { description: 'File body, or a folder listing.' },
      '304': { description: 'Not modified (If-None-Match).' },
      '404': { description: 'Not found.' },
    },
  },
  'PUT /storage/{username}/{path}': {
    summary: 'Create or update a file',
    tags: ['Storage'],
    security: BEARER,
    responses: {
      '200': { description: 'Stored.' },
      '412': { description: 'Precondition failed (If-Match).' },
    },
  },
  'DELETE /storage/{username}/{path}': {
    summary: 'Delete a file',
    tags: ['Storage'],
    security: BEARER,
    responses: { '200': { description: 'Deleted.' }, '404': { description: 'Not found.' } },
  },
  'HEAD /storage/{username}/{path}': {
    summary: 'Get file metadata only',
    tags: ['Storage'],
    security: BEARER,
    responses: { '200': { description: 'Headers only.' }, '404': { description: 'Not found.' } },
  },

  'GET /account': {
    summary: 'Dashboard',
    tags: ['Account'],
    security: ACCESS,
    description: 'Storage address, quota usage and setting, apps with access, and sign-out. '
      + 'Shows a finish-setup page (503) until config and Cloudflare Access are in place, '
      + 'and a 403 page for a signed-in identity other than OWNER_EMAIL.',
  },
  'GET /account/client.js': {
    summary: 'Account UI script',
    tags: ['Account'],
    security: ACCESS,
  },
  'POST /account/quota': {
    summary: 'Set the storage quota',
    tags: ['Account'],
    security: ACCESS,
    description: 'Form field quota_gb. Lowering it below current usage is allowed and blocks further writes.',
    responses: {
      '302': { description: 'Back to the dashboard.' },
      '400': { description: 'quota_gb is not a number of GB, 0 or more.' },
      '403': { description: 'Cross-site request.' },
    },
  },
  'POST /account/apps/revoke': {
    summary: 'Revoke an app',
    tags: ['Account'],
    security: ACCESS,
    description: 'Form field client_id. Deletes all of the client\'s tokens and pending codes, and its client record.',
    responses: {
      '302': { description: 'Back to the dashboard.' },
      '403': { description: 'Cross-site request.' },
    },
  },
  'GET /account/oauth/authorize': {
    summary: 'OAuth consent page',
    tags: ['OAuth'],
    security: ACCESS,
    description: 'Shows the requesting app\'s origin host, the requested Modules and the redirect target, '
      + 'for the Account. Rendered entirely from the query string, so it can be reloaded to retry. '
      + 'Advertised by WebFinger and /oauth/{user}.',
    parameters: [
      { name: 'client_id', in: 'query', required: true, schema: { type: 'string' }, description: 'The app\'s http(s) URL. Clients are not pre-registered.' },
      { name: 'redirect_uri', in: 'query', required: true, schema: { type: 'string' }, description: 'An http(s) URL on the same origin as client_id.' },
      { name: 'response_type', in: 'query', required: true, schema: { type: 'string', enum: ['code', 'token'] } },
      { name: 'scope', in: 'query', required: false, schema: { type: 'string' }, description: 'Space-separated scopes, e.g. documents:rw. Defaults to documents:rw.' },
      { name: 'state', in: 'query', required: false, schema: { type: 'string' } },
    ],
    responses: {
      '200': { description: 'The consent page.' },
      '400': { description: 'Invalid request, including a redirect_uri origin other than the client_id origin. Never redirects.' },
      '403': { description: 'A signed-in identity other than OWNER_EMAIL.' },
    },
  },
  'POST /account/oauth/authorize': {
    summary: 'Approve or deny an app',
    tags: ['OAuth'],
    security: ACCESS,
    description: 'Form fields: action (approve or deny) plus the request parameters. Approving with response_type=token '
      + 'redirects with the access token in the fragment; with code, with a code for /oauth/{user}/token. '
      + 'Deny redirects with error=access_denied.',
    responses: {
      '302': { description: 'Back to the app\'s redirect_uri.' },
      '400': { description: 'Invalid request, including a redirect_uri origin other than the client_id origin. Never redirects.' },
      '403': { description: 'Cross-site request, or an identity other than OWNER_EMAIL.' },
    },
  },
  'GET /account/tokens': {
    summary: 'Redirect to the dashboard',
    tags: ['Account'],
    responses: { '302': { description: 'App authorizations are listed on /account.' } },
  },
  'GET /account/browse': {
    summary: 'Browse the storage root',
    tags: ['Account'],
    security: ACCESS,
  },
  'GET /account/browse/{path}': {
    summary: 'Browse a folder',
    tags: ['Account'],
    security: ACCESS,
  },
  'GET /account/download/{path}': {
    summary: 'Download a file',
    tags: ['Account'],
    security: ACCESS,
  },
  'GET /account/view/{path}': {
    summary: 'View a text file',
    tags: ['Account'],
    security: ACCESS,
  },
  'POST /account/save/{path}': {
    summary: 'Save edits to a text file',
    tags: ['Account'],
    security: ACCESS,
  },
  'POST /account/upload/{path}': {
    summary: 'Upload files to a folder',
    tags: ['Account'],
    security: ACCESS,
  },
  'POST /account/delete/{path}': {
    summary: 'Delete a file',
    tags: ['Account'],
    security: ACCESS,
  },

  'GET /admin': {
    summary: 'Redirect to /account',
    tags: ['Account'],
    responses: { '301': { description: 'The admin console was merged into /account.' } },
  },
  'GET /admin/{path}': {
    summary: 'Redirect to /account',
    tags: ['Account'],
    responses: { '301': { description: 'The admin console was merged into /account.' } },
  },

  'GET /debug/token': {
    summary: 'Introspect a storage token',
    tags: ['Debug'],
    parameters: [{ name: 'token', in: 'query', required: true, schema: { type: 'string' } }],
    description: 'Returns whoami and scopes. Secret values are never returned.',
  },
  'POST /debug/token': {
    summary: 'Introspect a token (body)',
    tags: ['Debug'],
  },
  'GET /debug/storage': {
    summary: 'Actual storage vs DB counter',
    tags: ['Debug'],
    description: 'Recomputes the Account\'s usage by listing objects (an R2 Class A operation); call on demand, not on a timer.',
  },
  'GET /debug/health/deep': {
    summary: 'Live round-trip check of each binding',
    tags: ['Debug'],
  },
  'GET /debug/env': {
    summary: 'Redacted runtime, bindings and config',
    tags: ['Debug'],
  },
  'GET /debug/oauth': {
    summary: 'OAuth clients, tokens and pending codes',
    tags: ['Debug'],
  },
  'GET /debug/echo': {
    summary: 'Echo a request; parse a storage path scope',
    tags: ['Debug'],
    parameters: [{ name: 'path', in: 'query', required: false, schema: { type: 'string' } }],
  },
  'POST /debug/echo': {
    summary: 'Echo a request body',
    tags: ['Debug'],
  },
};
