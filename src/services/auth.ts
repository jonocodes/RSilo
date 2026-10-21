import { isValidItemName } from '../protocol/item-path';

// The resolved form of an opaque bearer token row in oauth_tokens.
export interface TokenPayload {
  sub: string; // username
  scopes: string;
  iat: number;
  exp: number;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

// A fresh secret (access token, refresh token or authorization code): 256
// random bits as base64url. Only its hash is ever stored.
export function generateToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

// How a secret is stored and looked up: base64url SHA-256. The secrets are
// 256-bit random values, so an unsalted fast hash is enough.
export function hashToken(token: string): Promise<string> {
  return sha256(token);
}

export type Access = 'r' | 'rw';

/** One access scope: a Module (`*` for the whole storage root) and its access level. */
export interface Scope {
  module: string;
  access: Access;
}

// `<module>:<r|rw>`. The protocol (§9) only says module names SHOULD be
// lower-case alphanumeric, and remoteStorage.js accepts any name without a
// `/`, so a module is any valid item name (the top-level folder it grants)
// other than the reserved `public`; `*` is the whole storage root. Names are
// case-sensitive, like paths.
export function parseScope(item: string): Scope | null {
  const colon = item.lastIndexOf(':');
  if (colon === -1) return null;
  const module = item.slice(0, colon);
  const access = item.slice(colon + 1);
  if (access !== 'r' && access !== 'rw') return null;
  if (module !== '*' && (module === 'public' || !isValidItemName(module))) return null;
  return { module, access };
}

/** A scope parameter: space-separated scopes. Null if it is empty or any item is malformed. */
export function parseScopes(scope: string): Scope[] | null {
  const scopes = scope.split(' ').filter(Boolean).map(parseScope);
  return scopes.length && scopes.every(s => s !== null) ? scopes as Scope[] : null;
}

/**
 * The Module a storage path (relative to the Account's root) belongs to:
 * `<module>/…` and `public/<module>/…`. Everything else (the root folder,
 * root-level documents, `public/` and documents directly in it) is `*`.
 */
export function moduleOf(path: string): string {
  const segments = path.split('/');
  const inModule = segments[0] === 'public' ? segments.slice(1) : segments;
  return inModule.length > 1 && inModule[0] ? inModule[0] : '*';
}

/** Whether a token's scopes give `access` to `module`. `rw` includes `r`; malformed items grant nothing. */
export function grants(tokenScopes: string, module: string, access: Access): boolean {
  return tokenScopes.split(' ').map(parseScope).some(scope =>
    scope !== null
    && (scope.module === '*' || scope.module === module)
    && (scope.access === 'rw' || scope.access === access));
}

/** Why a storage request is refused: no valid token (401), or not for this token (403). */
export interface Denial {
  status: 401 | 403;
  /** Set when the token lacks this scope. */
  requiredScope?: string;
}

/**
 * The storage authorization decision, for every storage request: may this
 * token (null when none, or an unknown one, was presented) have `access` to
 * `path` under `username`'s storage root? Null when it may. Public documents
 * (not folders) are readable by anyone; everything else needs a token for the
 * Account whose scopes cover the path's Module.
 */
export function authorize(payload: TokenPayload | null, username: string, path: string, access: Access): Denial | null {
  if (access === 'r' && path.startsWith('public/') && !path.endsWith('/')) return null;
  if (!payload) return { status: 401 };
  if (payload.sub !== username) return { status: 403 };
  const module = moduleOf(path);
  if (!grants(payload.scopes, module, access)) return { status: 403, requiredScope: `${module}:${access}` };
  return null;
}

export function parseAuthHeader(header: string | null): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}
