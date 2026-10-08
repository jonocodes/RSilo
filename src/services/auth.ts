// The resolved form of an opaque bearer token row in oauth_tokens.
export interface TokenPayload {
  sub: string; // username
  scopes: string;
  iat: number;
  exp: number;
}

// Opaque bearer token value, as stored in oauth_tokens.access_token.
export function generateToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const array = new Uint8Array(48);
  crypto.getRandomValues(array);
  return Array.from(array).map(b => chars[b % chars.length]).join('');
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
  const module = segments.length > categoryIdx ? segments[categoryIdx] : '*';
  return { module, permission: 'rw' };
}

export function parseAuthHeader(header: string | null): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}
