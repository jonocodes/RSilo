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

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const pairs = hex.match(/.{2}/g);
  if (!pairs) return new Uint8Array(0);
  return Uint8Array.from(pairs.map(b => parseInt(b, 16)));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return `pbkdf2:100000:${toHex(salt.buffer)}:${toHex(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1]);
  const salt = fromHex(parts[2]);
  const expectedHex = parts[3];

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return toHex(hash) === expectedHex;
}

export async function signSessionToken(username: string, secret: string, expirySeconds = 600): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + expirySeconds;
  const data = JSON.stringify({ username, exp });
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return btoa(data) + '.' + toHex(sig);
}

export async function verifySessionToken(token: string, secret: string): Promise<string | null> {
  const dotIdx = token.lastIndexOf('.');
  if (dotIdx === -1) return null;
  const dataPart = token.slice(0, dotIdx);
  const sigPart = token.slice(dotIdx + 1);

  let data: { username: string; exp: number };
  try {
    data = JSON.parse(atob(dataPart));
  } catch {
    return null;
  }

  if (data.exp < Math.floor(Date.now() / 1000)) return null;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const sigBytes = fromHex(sigPart);
  const rawData = new TextEncoder().encode(JSON.stringify({ username: data.username, exp: data.exp }));
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, rawData);
  return valid ? data.username : null;
}
