export interface TokenPayload {
  sub: string; // username
  aud?: string;
  scopes: string;
  iat: number;
  exp: number;
}

function toBase64Url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function fromBase64Url(str: string): Uint8Array {
  const padding = '='.repeat((4 - (str.length % 4)) % 4);
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/') + padding;
  const binary = atob(base64);
  return Uint8Array.from(binary.split('').map(c => c.charCodeAt(0)));
}

export async function signToken(payload: TokenPayload, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  
  const signatureB64 = toBase64Url(signature);
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

export async function verifyToken(token: string, secret?: string): Promise<TokenPayload | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;
    
    // Verify signature if secret provided
    if (secret) {
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify']
      );
      
      const signature = fromBase64Url(signatureB64);
      const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
      
      const valid = await crypto.subtle.verify('HMAC', key, signature, data);
      if (!valid) return null;
      
      // Verify algorithm is HS256
      const header = JSON.parse(atob(headerB64));
      if (header.alg !== 'HS256') return null;
    }

    const payload = JSON.parse(atob(payloadB64)) as TokenPayload;
    if (!payload.sub || !payload.scopes) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}

// Dev-only: creates unsigned JWT for testing. Do not use in production.
export function createTestToken(username: string, scopes = 'documents:rw pictures:rw'): string {
  const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({
    sub: username,
    scopes,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 86400 * 30,
  }));
  return `${header}.${payload}.`;
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
  return header.slice(7);
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
