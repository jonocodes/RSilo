import { Hono } from 'hono';
import { verifyToken, hasScope, scopeFromPath } from '../services/auth';
import { buildKey, getStorage } from '../services/r2';
import pkg from '../../package.json';

export const debugRouter = new Hono();

const VERSION = (pkg as { version?: string }).version || 'unknown';

function storageBackend(env: any): 'r2' | 'local' | 'unknown' {
  const raw = env?.STORAGE;
  if (raw && typeof raw.createMultipartUpload === 'function') return 'r2';
  if (raw && typeof raw.list === 'function') return 'local';
  return 'unknown';
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isUnsignedToken(token: string): boolean {
  try {
    const [headerB64] = token.split('.');
    const header = JSON.parse(atob(headerB64));
    return header?.alg === 'none';
  } catch {
    return false;
  }
}

function parseScopes(scopes: string): { raw: string; module: string; permissions: string }[] {
  return scopes
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => {
      const idx = raw.indexOf(':');
      return idx === -1
        ? { raw, module: raw, permissions: '' }
        : { raw, module: raw.slice(0, idx), permissions: raw.slice(idx + 1) };
    });
}

interface Introspection {
  valid: boolean;
  source: 'oauth_token' | 'jwt' | 'dev_token' | null;
  sub?: string;
  scopes?: string;
  parsed_scopes?: { raw: string; module: string; permissions: string }[];
  iat?: number;
  exp?: number;
  expires_in?: number;
  expired?: boolean;
  jwt_secret_set: boolean;
  scope_checks?: Record<string, boolean>;
  reason?: string;
}

function buildIntrospection(
  source: 'oauth_token' | 'jwt' | 'dev_token',
  sub: string,
  scopes: string,
  iat: number | undefined,
  exp: number | undefined,
  jwtSecretSet: boolean,
  valid: boolean,
): Introspection {
  const result: Introspection = {
    valid,
    source,
    sub,
    scopes,
    parsed_scopes: parseScopes(scopes),
    iat,
    exp,
    jwt_secret_set: jwtSecretSet,
  };
  if (typeof exp === 'number') {
    result.expired = exp <= nowSeconds();
    result.expires_in = exp - nowSeconds();
  }
  if (!valid) result.reason = 'token expired';
  return result;
}

// Mirrors the resolution order of the storage auth middleware so the report
// reflects exactly what a storage request would see.
async function introspectToken(c: any, token: string): Promise<Introspection> {
  const env = c.env as any;
  const jwtSecret = env?.JWT_SECRET as string | undefined;
  const jwtSecretSet = typeof jwtSecret === 'string' && jwtSecret.length > 0;

  const db = env?.DB;
  if (db && typeof db.prepare === 'function') {
    const row = await db.prepare('SELECT * FROM oauth_tokens WHERE access_token = ?').bind(token).first() as any;
    if (row) {
      return buildIntrospection(
        'oauth_token',
        row.user_id,
        row.scopes,
        row.created_at,
        row.expires_at,
        jwtSecretSet,
        row.expires_at > nowSeconds(),
      );
    }
  }

  const payload = jwtSecretSet ? await verifyToken(token, jwtSecret) : await verifyToken(token);
  if (payload) {
    return buildIntrospection(
      isUnsignedToken(token) ? 'dev_token' : 'jwt',
      payload.sub,
      payload.scopes,
      payload.iat,
      payload.exp,
      jwtSecretSet,
      true,
    );
  }

  return {
    valid: false,
    source: null,
    jwt_secret_set: jwtSecretSet,
    reason: jwtSecretSet
      ? 'invalid or expired token'
      : 'invalid, expired, or unsigned dev token (JWT_SECRET not set)',
  };
}

async function tokenHandler(c: any) {
  let token = c.req.query('token') || c.req.header('X-RS-Token') || '';

  if (!token && c.req.method === 'POST') {
    const contentType = c.req.header('Content-Type') || '';
    try {
      if (contentType.includes('application/json')) {
        const body = await c.req.json();
        token = body?.token || body?.access_token || '';
      } else {
        const body = await c.req.parseBody();
        token = (body?.token as string) || '';
      }
    } catch {
      // fall through to the missing-token error
    }
  }

  if (!token) {
    return c.json({ error: 'token is required (query ?token=, header X-RS-Token, or POST body {token})' }, 400);
  }

  const result = await introspectToken(c, token);

  const requested = (c.req.queries('scope') || [])
    .flatMap((s: string) => s.split(/[\s,]+/))
    .filter(Boolean);
  if (requested.length) {
    result.scope_checks = Object.fromEntries(
      requested.map((scope: string) => [scope, !!result.scopes && hasScope(result.scopes, scope)]),
    );
  }

  return c.json(result, 200);
}

debugRouter.get('/token', tokenHandler);
debugRouter.post('/token', tokenHandler);

// Recomputes what is actually in storage for a user and compares it to the
// denormalised counter the dashboard reads. Listing objects is a Class A
// operation, so this is an on-demand admin action, not something to poll.
debugRouter.get('/storage/:username', async (c) => {
  const username = c.req.param('username');
  const env = c.env as any;
  const db = env?.DB;
  if (!db || typeof db.prepare !== 'function') {
    return c.json({ error: 'Database not available' }, 503);
  }

  const user = await db
    .prepare('SELECT username, storage_quota_bytes, used_storage_bytes FROM users WHERE username = ?')
    .bind(username)
    .first() as any;
  if (!user) return c.json({ error: 'User not found' }, 404);

  const storage = getStorage(c);
  const prefix = buildKey(username, '');

  let objects: any[] = [];
  try {
    const listed = await storage.list(prefix);
    objects = listed.objects || [];
  } catch (e: any) {
    return c.json({ error: 'Storage list failed', detail: String(e?.message || e) }, 502);
  }

  let actualBytes = 0;
  let actualObjects = 0;
  const byModule: Record<string, { objects: number; bytes: number }> = {};

  for (const obj of objects) {
    if (!obj?.key || obj.key.endsWith('/')) continue;
    actualObjects += 1;
    actualBytes += obj.size || 0;

    const rel = obj.key.slice(prefix.length);
    const segments = rel.split('/').filter(Boolean);
    const module = segments.length <= 1
      ? '(root)'
      : segments[0] === 'public' && segments.length > 2
        ? `public/${segments[1]}`
        : segments[0];

    const bucket = (byModule[module] ||= { objects: 0, bytes: 0 });
    bucket.objects += 1;
    bucket.bytes += obj.size || 0;
  }

  const dbUsed = user.used_storage_bytes || 0;
  const quota = user.storage_quota_bytes || 0;

  return c.json({
    username,
    quota_bytes: quota,
    db_used_storage_bytes: dbUsed,
    actual_bytes: actualBytes,
    actual_objects: actualObjects,
    drift_bytes: actualBytes - dbUsed,
    percent_used: quota > 0 ? (dbUsed / quota) * 100 : null,
    by_module: byModule,
    note: 'actual_bytes is recomputed from storage (one Class A list operation); drift_bytes = actual_bytes - db_used_storage_bytes.',
    checked_at: new Date().toISOString(),
  });
});

// Does a real round-trip against each binding instead of reporting a static
// status, so a misconfigured deployment is obvious in one request.
debugRouter.get('/health/deep', async (c) => {
  const env = c.env as any;
  const checks: Record<string, any> = {};

  const storage = getStorage(c);
  const key = `_healthcheck/${crypto.randomUUID()}`;
  const storageStart = Date.now();
  try {
    const payload = new TextEncoder().encode('ok').buffer as ArrayBuffer;
    await storage.put(key, payload, 'text/plain');
    const got = await storage.get(key);
    const ok = !!got && new TextDecoder().decode(got.body) === 'ok';
    await storage.delete(key);
    checks.storage = {
      ok,
      latency_ms: Date.now() - storageStart,
      backend: storageBackend(env),
      ...(ok ? {} : { error: 'round-trip body mismatch' }),
    };
  } catch (e: any) {
    try { await storage.delete(key); } catch { /* best effort cleanup */ }
    checks.storage = {
      ok: false,
      latency_ms: Date.now() - storageStart,
      backend: storageBackend(env),
      error: String(e?.message || e),
    };
  }

  const db = env?.DB;
  if (!db || typeof db.prepare !== 'function') {
    checks.database = { ok: false, skipped: true, error: 'DB binding not available' };
  } else {
    const dbStart = Date.now();
    try {
      const row = await db.prepare('SELECT 1 as ok').first() as any;
      checks.database = { ok: row?.ok === 1, latency_ms: Date.now() - dbStart };
    } catch (e: any) {
      checks.database = { ok: false, latency_ms: Date.now() - dbStart, error: String(e?.message || e) };
    }
  }

  const kv = env?.RATE_LIMIT_KV;
  if (!kv || typeof kv.get !== 'function') {
    checks.rate_limit_kv = { ok: true, skipped: true, reason: 'KV binding not configured' };
  } else {
    const kvStart = Date.now();
    const kvKey = `healthcheck:${crypto.randomUUID()}`;
    try {
      await kv.put(kvKey, 'ok', { expirationTtl: 60 });
      const value = await kv.get(kvKey);
      await kv.delete(kvKey);
      checks.rate_limit_kv = { ok: value === 'ok', latency_ms: Date.now() - kvStart };
    } catch (e: any) {
      checks.rate_limit_kv = { ok: false, latency_ms: Date.now() - kvStart, error: String(e?.message || e) };
    }
  }

  const criticalFailed = !checks.storage.ok || !checks.database.ok;
  const optionalFailed = !checks.rate_limit_kv.ok;
  const status = criticalFailed ? 'error' : optionalFailed ? 'degraded' : 'ok';

  return c.json({ status, checks, timestamp: new Date().toISOString() }, criticalFailed ? 503 : 200);
});

// Redacted capability report. Never returns secret values — booleans only.
debugRouter.get('/env', (c) => {
  const env = c.env as any;
  const secretSet = (name: string) => typeof env?.[name] === 'string' && env[name].length > 0;
  const backend = storageBackend(env);

  return c.json({
    runtime: backend === 'r2' ? 'cloudflare-worker' : 'offline-or-custom',
    version: VERSION,
    git_sha: env?.GIT_SHA ?? null,
    storage_backend: backend,
    bindings: {
      STORAGE: !!env?.STORAGE,
      DB: !!(env?.DB && typeof env.DB.prepare === 'function'),
      RATE_LIMIT_KV: !!(env?.RATE_LIMIT_KV && typeof env.RATE_LIMIT_KV.get === 'function'),
    },
    secrets_set: {
      ADMIN_SECRET: secretSet('ADMIN_SECRET'),
      SESSION_SECRET: secretSet('SESSION_SECRET'),
      JWT_SECRET: secretSet('JWT_SECRET'),
    },
    timestamp: new Date().toISOString(),
  });
});

// Read-only view of the OAuth tables. Token and code secrets are never
// returned (refresh tokens are reduced to a boolean, codes to a prefix).
debugRouter.get('/oauth', async (c) => {
  const env = c.env as any;
  const db = env?.DB;
  if (!db || typeof db.prepare !== 'function') {
    return c.json({ error: 'Database not available' }, 503);
  }

  const now = nowSeconds();
  let clients: any[] = [];
  let tokens: any[] = [];
  let codes: any[] = [];
  try {
    clients = (await db.prepare('SELECT * FROM oauth_clients').all()).results || [];
    tokens = (await db.prepare('SELECT * FROM oauth_tokens').all()).results || [];
    codes = (await db.prepare('SELECT * FROM oauth_codes').all()).results || [];
  } catch (e: any) {
    return c.json({ error: 'Failed to read OAuth tables', detail: String(e?.message || e) }, 502);
  }

  const tokenRows = tokens.map((t) => ({
    id: t.id,
    user_id: t.user_id,
    client_id: t.client_id,
    scopes: t.scopes,
    created_at: t.created_at,
    expires_at: t.expires_at,
    expired: (t.expires_at || 0) <= now,
    has_refresh_token: !!t.refresh_token,
  }));

  const codeRows = codes.map((code) => ({
    code_prefix: typeof code.code === 'string' ? code.code.slice(0, 8) : null,
    client_id: code.client_id,
    user_id: code.user_id,
    scope: code.scope,
    redirect_uri: code.redirect_uri,
    created_at: code.created_at,
    expires_at: code.expires_at,
    expired: (code.expires_at || 0) <= now,
  }));

  const clientRows = clients.map((client) => ({
    id: client.id,
    name: client.name,
    user_id: client.user_id,
    redirect_uris: client.redirect_uris,
    created_at: client.created_at,
    token_count: tokenRows.filter((t) => t.client_id === client.id).length,
  }));

  return c.json({
    summary: {
      clients: clientRows.length,
      tokens: tokenRows.length,
      active_tokens: tokenRows.filter((t) => !t.expired).length,
      expired_tokens: tokenRows.filter((t) => t.expired).length,
      pending_codes: codeRows.filter((code) => !code.expired).length,
    },
    clients: clientRows,
    tokens: tokenRows,
    codes: codeRows,
    timestamp: new Date().toISOString(),
  });
});

const REDACTED_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization', 'x-rs-token']);
const REDACTED_QUERY = new Set(['token', 'access_token', 'refresh_token']);
const BODY_PREVIEW_BYTES = 2048;

function isTextualContentType(contentType: string): boolean {
  return (
    contentType.startsWith('text/') ||
    contentType.includes('json') ||
    contentType.includes('xml') ||
    contentType.includes('x-www-form-urlencoded')
  );
}

function redactHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    out[key] = REDACTED_HEADERS.has(key.toLowerCase()) ? '[redacted]' : value;
  }
  return out;
}

// Echoes what the server received so a client-side bug (wrong header, wrong
// scope, wrong method) is visible without guesswork. Pass a storage token via
// ?token= or X-RS-Token to introspect it — never via Authorization, which the
// admin gate consumes.
debugRouter.all('/echo', async (c) => {
  const url = new URL(c.req.url);

  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    query[key] = REDACTED_QUERY.has(key) ? '[redacted]' : value;
  }

  const bodyBuffer = await c.req.arrayBuffer();
  const bytes = bodyBuffer.byteLength;
  const contentType = c.req.header('Content-Type') || '';
  const preview = bytes > 0 && isTextualContentType(contentType)
    ? new TextDecoder().decode(bodyBuffer.slice(0, BODY_PREVIEW_BYTES))
    : null;

  const token = c.req.query('token') || c.req.header('X-RS-Token') || '';
  const tokenInfo = token ? await introspectToken(c, token) : null;

  const storagePath = c.req.query('path') || (url.pathname.startsWith('/storage/') ? url.pathname : null);
  let storage: any = null;
  if (storagePath) {
    const segments = storagePath.split('/').filter(Boolean);
    const start = segments[0] === 'storage' ? 1 : 0;
    const username = segments[start] || '';
    const relSegments = segments.slice(start + 1);
    const path = relSegments.join('/');
    const { module } = scopeFromPath(storagePath);
    const method = (c.req.query('method') || c.req.method).toUpperCase();
    const permission = method === 'GET' || method === 'HEAD' ? 'r' : method === 'PUT' || method === 'DELETE' ? 'rw' : null;

    storage = {
      username,
      path,
      module,
      is_public: relSegments[0] === 'public',
      required_scope: { read: `${module}:r`, write: `${module}:rw` },
      method_required_scope: permission ? `${module}:${permission}` : null,
    };
  }

  return c.json({
    method: c.req.method,
    path: url.pathname,
    query,
    headers: redactHeaders(c.req.raw.headers),
    body: { content_type: contentType || null, bytes, preview, truncated: bytes > BODY_PREVIEW_BYTES },
    storage,
    token: tokenInfo,
    note: 'Authorization/Cookie/X-RS-Token headers are redacted. Pass a storage token via ?token= or X-RS-Token to introspect it; ?path= parses a storage URL and reports the scope it requires.',
    timestamp: new Date().toISOString(),
  });
});


