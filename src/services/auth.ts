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

export function hasScope(tokenScopes: string, requiredScope: string): boolean {
  const colonIdx = requiredScope.indexOf(':');
  if (colonIdx === -1) return false;
  const requiredName = requiredScope.slice(0, colonIdx);
  const requiredPerm = requiredScope.slice(colonIdx + 1);

  const scopes = tokenScopes.split(/\s+/);
  for (const scope of scopes) {
    if (scope === '*') {
      return true;
    }
    const scopeColonIdx = scope.indexOf(':');
    if (scopeColonIdx === -1) continue;

    const name = scope.slice(0, scopeColonIdx);
    const perms = scope.slice(scopeColonIdx + 1);

    if (name === requiredName && perms.startsWith(requiredPerm)) {
      return true;
    }
    if (name === '*' && perms.startsWith(requiredPerm)) {
      return true;
    }
  }
  return false;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function scopeFromPath(fullPath: string): { module: string; permission: string } {
  const segments = fullPath.split('/').filter(Boolean);
  let startIdx = 0;
  if (segments[0] === 'storage') {
    startIdx = 1;
  }
  let categoryIdx = startIdx + 1;
  if (segments[categoryIdx] === 'public') {
    categoryIdx += 1;
  }
  // Paths arrive raw (percent-encoded, see protocol/item-path.ts); the
  // category is compared with scopes by name.
  const module = segments.length > categoryIdx ? safeDecode(segments[categoryIdx]) : '*';
  return { module, permission: 'rw' };
}

export function parseAuthHeader(header: string | null): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}
