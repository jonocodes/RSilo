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
export const ADMIN = [{ adminSecret: [] }];

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
    summary: 'Login and consent form',
    tags: ['OAuth'],
    description: '404 unless {user} is ACCOUNT_USERNAME.',
    parameters: [
      { name: 'client_id', in: 'query', required: true, schema: { type: 'string' } },
      { name: 'redirect_uri', in: 'query', required: true, schema: { type: 'string' } },
      { name: 'response_type', in: 'query', required: true, schema: { type: 'string', enum: ['code', 'token'] } },
      { name: 'scope', in: 'query', required: true, schema: { type: 'string' }, description: 'Space-separated scopes, e.g. documents:rw' },
    ],
  },
  'POST /oauth/{user}/authorize': {
    summary: 'Submit login or consent',
    tags: ['OAuth'],
    responses: {
      '302': { description: 'Redirect back to the client with a code or token.' },
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
    summary: 'Login page',
    tags: ['Account'],
  },
  'GET /account/client.js': {
    summary: 'Account UI script',
    tags: ['Account'],
  },
  'POST /account/login': {
    summary: 'Sign in with username/password',
    tags: ['Account'],
    responses: {
      '302': { description: 'Sets the session cookie and redirects.' },
      '401': { description: 'Invalid credentials.' },
    },
  },
  'POST /account/logout': {
    summary: 'Sign out',
    tags: ['Account'],
    responses: { '302': { description: 'Clears the session cookie.' } },
  },
  'GET /account/browse': {
    summary: 'Browse the storage root',
    tags: ['Account'],
  },
  'GET /account/browse/{path}': {
    summary: 'Browse a folder',
    tags: ['Account'],
  },
  'GET /account/download/{path}': {
    summary: 'Download a file',
    tags: ['Account'],
  },
  'GET /account/view/{path}': {
    summary: 'View a text file',
    tags: ['Account'],
  },
  'POST /account/save/{path}': {
    summary: 'Save edits to a text file',
    tags: ['Account'],
  },
  'POST /account/upload/{path}': {
    summary: 'Upload files to a folder',
    tags: ['Account'],
  },
  'POST /account/delete/{path}': {
    summary: 'Delete a file',
    tags: ['Account'],
  },
  'GET /account/tokens': {
    summary: 'View OAuth tokens',
    tags: ['Account'],
  },
  'POST /account/tokens/{id}/revoke': {
    summary: 'Revoke a token',
    tags: ['Account'],
  },

  'GET /admin': {
    summary: 'Dashboard',
    tags: ['Admin'],
    security: ADMIN,
  },
  'GET /admin/login': {
    summary: 'Admin login page',
    tags: ['Admin'],
  },
  'POST /admin/login': {
    summary: 'Sign in (sets session cookie)',
    tags: ['Admin'],
  },
  'POST /admin/logout': {
    summary: 'Sign out',
    tags: ['Admin'],
  },
  'GET /admin/health': {
    summary: 'Health check',
    tags: ['Admin'],
    security: ADMIN,
  },
  'GET /admin/stats': {
    summary: 'Usage statistics',
    tags: ['Admin'],
    security: ADMIN,
  },
  'GET /admin/users': {
    summary: 'List all users',
    tags: ['Admin'],
    security: ADMIN,
  },
  'POST /admin/users': {
    summary: 'Create a user',
    tags: ['Admin'],
    security: ADMIN,
    responses: { '201': { description: 'User created.' } },
  },
  'GET /admin/users/{username}': {
    summary: 'Get user details',
    tags: ['Admin'],
    security: ADMIN,
  },
  'DELETE /admin/users/{username}': {
    summary: 'Delete a user',
    tags: ['Admin'],
    security: ADMIN,
    description: 'Immediate purge: deletes every stored object, then revokes OAuth state and removes the user.',
  },
  'DELETE /admin/tokens/{id}': {
    summary: 'Revoke a token',
    tags: ['Admin'],
    security: ADMIN,
  },
  'PATCH /admin/users/{username}/quota': {
    summary: 'Update storage quota',
    tags: ['Admin'],
    security: ADMIN,
  },
  'PATCH /admin/users/{username}/password': {
    summary: 'Change a user password',
    tags: ['Admin'],
    security: ADMIN,
  },

  'GET /admin/debug/token': {
    summary: 'Introspect a storage/OAuth token',
    tags: ['Debug'],
    security: ADMIN,
    parameters: [{ name: 'token', in: 'query', required: true, schema: { type: 'string' } }],
    description: 'Returns whoami and scopes. Secret values are never returned.',
  },
  'POST /admin/debug/token': {
    summary: 'Introspect a token (body)',
    tags: ['Debug'],
    security: ADMIN,
  },
  'GET /admin/debug/storage/{username}': {
    summary: 'Actual storage vs DB counter',
    tags: ['Debug'],
    security: ADMIN,
    description: 'Recomputes usage by listing objects (an R2 Class A operation); call on demand, not on a timer.',
  },
  'GET /admin/debug/health/deep': {
    summary: 'Live round-trip check of each binding',
    tags: ['Debug'],
    security: ADMIN,
  },
  'GET /admin/debug/env': {
    summary: 'Redacted runtime and bindings',
    tags: ['Debug'],
    security: ADMIN,
  },
  'GET /admin/debug/oauth': {
    summary: 'OAuth clients, tokens and pending codes',
    tags: ['Debug'],
    security: ADMIN,
  },
  'GET /admin/debug/echo': {
    summary: 'Echo a request; parse a storage path scope',
    tags: ['Debug'],
    security: ADMIN,
    parameters: [{ name: 'path', in: 'query', required: false, schema: { type: 'string' } }],
  },
  'POST /admin/debug/echo': {
    summary: 'Echo a request body',
    tags: ['Debug'],
    security: ADMIN,
  },
};
