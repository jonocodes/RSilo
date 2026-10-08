import { Hono } from 'hono';
import { isLocalDevelopment } from '../config';
import { buildKey, getStorage } from '../services/r2';
import { ACCOUNT_CLIENT_SCRIPT } from '../ui/account-client';
import { setupMessagePage } from '../ui/setup-pages';
import { deleteUserObject, putUserObject, QuotaExceededError, StorageAccountingError } from '../services/quota-storage';
import { maxObjectSize, ObjectTooLargeError, rejectOversizedContentLength } from '../services/object-size';
import { requireAccountRow } from '../middleware/instance';
import { requireOwner, requireSameOrigin } from '../middleware/owner';

export const accountRouter = new Hono();

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

accountRouter.use('*', async (c, next) => {
  await next();
  c.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
});

// The whole surface is the Owner's (ADR-0001, ADR-0004): Cloudflare Access
// signs them in, and requireOwner() checks the identity against OWNER_EMAIL on
// every request, whatever paths the Access application covers. State changes
// must also be same-origin.
accountRouter.use('*', requireOwner(), requireSameOrigin(), requireAccountRow(setupMessagePage));

accountRouter.get('/client.js', (_c) => new Response(ACCOUNT_CLIENT_SCRIPT, {
  headers: {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
  },
}));

function getDb(c: any) {
  return c.env.DB;
}

async function listFolder(storage: any, username: string, storagePath: string): Promise<{ name: string; isDir: boolean; size: number; etag: string }[]> {
  const prefixPath = storagePath ? (storagePath.endsWith('/') ? storagePath : storagePath + '/') : '';
  const prefix = buildKey(username, prefixPath);
  const raw = await storage.list(prefix);
  const objects: { key: string; size: number; etag: string }[] = raw.objects;

  const files: { name: string; isDir: boolean; size: number; etag: string }[] = [];
  const seenDirs = new Set<string>();

  for (const obj of objects) {
    const rel = obj.key.slice(prefix.length);
    if (!rel) continue;
    const segments = rel.split('/').filter(Boolean);
    if (segments.length === 1 && !rel.endsWith('/')) {
      files.push({ name: segments[0], isDir: false, size: obj.size, etag: obj.etag });
    } else if (segments.length >= 1) {
      const dir = segments[0];
      if (!seenDirs.has(dir)) {
        seenDirs.add(dir);
        files.push({ name: dir, isDir: true, size: 0, etag: '' });
      }
    }
  }

  files.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return files;
}

function formatBytes(n: number): string {
  if (n === 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

const COMMON_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #222; min-height: 100vh; }
a { color: #0066cc; text-decoration: none; }
a:hover { text-decoration: underline; }
header { background: #1a1a1a; color: white; padding: 0 1.5rem; display: flex; align-items: center; gap: 1rem; height: 52px; }
header h1 { font-size: 1rem; font-weight: 600; flex: 1; }
header nav a { color: #aaa; font-size: 0.875rem; padding: 0.25rem 0.5rem; border-radius: 4px; }
header nav a:hover { color: white; background: rgba(255,255,255,0.1); text-decoration: none; }
header nav a.active { color: white; }
header .user { font-size: 0.875rem; color: #ccc; }
.container { max-width: 960px; margin: 0 auto; padding: 1.5rem; }
.breadcrumb { font-size: 0.875rem; margin-bottom: 1.25rem; color: #666; }
.breadcrumb a { color: #0066cc; }
.breadcrumb span { margin: 0 0.35rem; }
.card { background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); overflow: hidden; }
table { width: 100%; border-collapse: collapse; }
th { background: #fafafa; font-size: 0.75rem; text-transform: uppercase; letter-spacing: .5px; color: #888; font-weight: 600; text-align: left; padding: 0.625rem 1rem; border-bottom: 1px solid #eee; }
td { padding: 0.75rem 1rem; border-bottom: 1px solid #f0f0f0; font-size: 0.9rem; vertical-align: middle; }
tr:last-child td { border-bottom: none; }
tr:hover td { background: #fafafa; }
.icon { margin-right: 0.5rem; }
.size { color: #888; font-size: 0.8rem; }
.actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
.btn { display: inline-flex; align-items: center; padding: 0.35rem 0.75rem; border-radius: 4px; font-size: 0.8rem; cursor: pointer; border: none; font-family: inherit; }
.btn-primary { background: #0066cc; color: white; }
.btn-primary:hover { background: #0052a3; }
.btn-danger { background: #fff; color: #dc3545; border: 1px solid #dc3545; }
.btn-danger:hover { background: #dc3545; color: white; }
.btn-sm { padding: 0.25rem 0.6rem; font-size: 0.75rem; }
.upload-section { padding: 1rem 1.25rem; border-top: 1px solid #eee; background: #fafafa; display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
.upload-section label { font-size: 0.875rem; color: #555; }
input[type=file] { font-size: 0.875rem; }
.empty { padding: 2.5rem; text-align: center; color: #aaa; font-size: 0.9rem; }
.error { color: #dc3545; font-size: 0.875rem; padding: 0.5rem 0.75rem; background: #fff5f5; border-radius: 4px; margin-bottom: 1rem; }
.section + .section { margin-top: 1.5rem; }
.section h2 { font-size: 0.95rem; margin-bottom: 0.6rem; }
.panel { padding: 1rem 1.25rem; font-size: 0.9rem; line-height: 1.5; }
.panel p + p { margin-top: 0.5rem; }
.address { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
.address code { font-size: 1rem; background: #f0f0f0; padding: 0.3rem 0.6rem; border-radius: 4px; }
.usage-bar { height: 8px; background: #eee; border-radius: 4px; overflow: hidden; margin: 0.5rem 0; }
.usage-bar div { height: 100%; background: #0066cc; }
.usage-bar div.full { background: #dc3545; }
.quota-form { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.75rem; flex-wrap: wrap; }
.quota-form input { padding: .35rem .6rem; border: 1px solid #ddd; border-radius: 4px; font-size: .875rem; width: 110px; }
.muted { color: #777; font-size: 0.8rem; }
`;

function renderPage(title: string, ownerEmail: string, body: string, activePage = 'files'): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — RSilo</title>
  <style>${COMMON_CSS}</style>
</head>
<body>
  <header>
    <h1><a href="/account" style="color:white">RSilo</a></h1>
    <nav>
      <a href="/account" class="${activePage === 'dashboard' ? 'active' : ''}">Dashboard</a>
      <a href="/account/browse" class="${activePage === 'files' ? 'active' : ''}">Files</a>
    </nav>
    <span class="user">${escapeHtml(ownerEmail)}</span>
    <nav><a href="/cdn-cgi/access/logout" title="Ends your RSilo sign-in (the Cloudflare Access session), not your email or identity-provider login">Sign out</a></nav>
  </header>
  ${body}
  <script src="/account/client.js" defer></script>
</body>
</html>`;
}

// ── Dashboard ────────────────────────────────────────────────────────────────

const GIB = 1024 * 1024 * 1024;

interface AppGrant {
  clientId: string;
  host: string;
  scopes: string[];
  firstGranted: number;
  lastUsed: number;
}

// The protocol carries no app name, and oauth_clients.name is whatever the
// client sent, so an app is shown by its client_id's origin host.
function clientHost(clientId: string): string {
  try {
    return new URL(clientId).host || clientId;
  } catch {
    return clientId;
  }
}

// One App authorization per client_id: all of that client's token rows. Token
// rows do not record use, so "last used" is when the newest token was issued.
function groupGrants(tokens: { client_id: string; scopes: string; created_at: number }[]): AppGrant[] {
  const byClient = new Map<string, AppGrant & { scopeSet: Set<string> }>();
  for (const token of tokens) {
    let grant = byClient.get(token.client_id);
    if (!grant) {
      grant = {
        clientId: token.client_id,
        host: clientHost(token.client_id),
        scopes: [],
        scopeSet: new Set(),
        firstGranted: token.created_at,
        lastUsed: token.created_at,
      };
      byClient.set(token.client_id, grant);
    }
    for (const scope of String(token.scopes || '').split(/\s+/).filter(Boolean)) grant.scopeSet.add(scope);
    grant.firstGranted = Math.min(grant.firstGranted, token.created_at);
    grant.lastUsed = Math.max(grant.lastUsed, token.created_at);
  }
  return [...byClient.values()]
    .map(({ scopeSet, ...grant }) => ({ ...grant, scopes: [...scopeSet].sort() }))
    .sort((a, b) => b.lastUsed - a.lastUsed);
}

function formatDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function formatUsage(n: number): string {
  return n === 0 ? '0 B' : formatBytes(n);
}

accountRouter.get('/', async (c) => {
  const instance = c.get('instance');
  const username = instance.accountUsername;
  const db = getDb(c);

  const usage = await db?.prepare?.('SELECT storage_quota_bytes, used_storage_bytes FROM users WHERE username = ?')
    ?.bind?.(username)?.first?.() as { storage_quota_bytes?: number; used_storage_bytes?: number } | null;
  const quota = Number(usage?.storage_quota_bytes ?? 0);
  const used = Number(usage?.used_storage_bytes ?? 0);
  const percent = quota > 0 ? Math.min(100, (used / quota) * 100) : 100;

  const tokensResult = await db?.prepare?.('SELECT client_id, scopes, created_at FROM oauth_tokens WHERE user_id = ?')
    ?.bind?.(username)?.all?.() || { results: [] };
  const grants = groupGrants(tokensResult.results || []);

  const address = `${username}@${instance.publicHost}`;
  const appRows = grants.length
    ? grants.map(grant => `
      <tr>
        <td><strong>${escapeHtml(grant.host)}</strong>${grant.host !== grant.clientId ? `<div class="muted">${escapeHtml(grant.clientId)}</div>` : ''}</td>
        <td><span style="font-size:.8rem;color:#555">${grant.scopes.map(escapeHtml).join(' ')}</span></td>
        <td class="size">${formatDate(grant.firstGranted)}</td>
        <td class="size">${formatDate(grant.lastUsed)}</td>
        <td class="actions">
          <form method="POST" action="/account/apps/revoke" style="margin:0" data-confirm-message="Revoke ${escapeHtml(grant.host)}? It loses access immediately.">
            <input type="hidden" name="client_id" value="${escapeHtml(grant.clientId)}">
            <button class="btn btn-sm btn-danger">Revoke</button>
          </form>
        </td>
      </tr>`).join('')
    : `<tr><td colspan="5" class="empty">No apps have access yet.</td></tr>`;

  const body = `
  <div class="container">
    <div class="section">
      <h2>Storage address</h2>
      <div class="card panel">
        <div class="address">
          <code id="storage-address">${escapeHtml(address)}</code>
          <button class="btn btn-sm btn-primary" data-copy-target="storage-address">Copy</button>
        </div>
        <p class="muted" style="margin-top:.5rem">Enter this in a remoteStorage app to connect it to your storage.</p>
      </div>
    </div>
    <div class="section">
      <h2>Storage used</h2>
      <div class="card panel">
        <div>${formatUsage(used)} of ${formatUsage(quota)} used</div>
        <div class="usage-bar"><div class="${used >= quota ? 'full' : ''}" style="width:${percent.toFixed(1)}%"></div></div>
        <form method="POST" action="/account/quota" class="quota-form">
          <label for="quota-gb">Quota (GB):</label>
          <input type="number" id="quota-gb" name="quota_gb" min="0" step="any" value="${Number((quota / GIB).toFixed(3))}">
          <button class="btn btn-sm btn-primary">Save</button>
        </form>
        <p class="muted" style="margin-top:.5rem">A limit you set for yourself, for example to stay within the R2 free tier. Setting it below what is already stored keeps your files but blocks new writes.</p>
      </div>
    </div>
    <div class="section">
      <h2>Apps with access</h2>
      <div class="card">
        <table>
          <thead><tr><th>App</th><th>Access</th><th>First granted</th><th>Last used</th><th></th></tr></thead>
          <tbody>${appRows}</tbody>
        </table>
      </div>
    </div>
    <div class="section">
      <h2>Public files</h2>
      <div class="card panel">
        <p>Anything an app stores under a <code>public/</code> folder (for example <code>/storage/${escapeHtml(username)}/public/documents/…</code>) can be read by anyone who has the link, without signing in. Folder listings there stay private.</p>
        <p>Everything else is readable only by you and the apps you have granted access.</p>
      </div>
    </div>
    <div class="section">
      <p class="muted"><a href="/cdn-cgi/access/logout">Sign out</a> ends your RSilo sign-in (the Cloudflare Access session). It does not sign you out of your email or identity provider.</p>
    </div>
  </div>`;

  return new Response(renderPage('Dashboard', c.get('ownerEmail'), body, 'dashboard'), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
});

// Lowering the quota below current usage is allowed: it blocks further writes.
accountRouter.post('/quota', async (c) => {
  const body = await c.req.parseBody() as Record<string, unknown>;
  const raw = typeof body.quota_gb === 'string' ? body.quota_gb.trim() : '';
  const gb = raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(gb) || gb < 0) return c.text('quota_gb must be a number of GB, 0 or more', 400);

  const db = getDb(c);
  if (!db || typeof db.prepare !== 'function') return c.text('Server database is not configured', 503);
  await db.prepare('UPDATE users SET storage_quota_bytes = ? WHERE username = ?')
    .bind(Math.round(gb * GIB), c.get('instance').accountUsername)
    .run();
  return c.redirect('/account', 302);
});

// Revoking an app removes its whole App authorization: every token row and
// pending code for the client, then the client row itself (kept only while a
// pre-migration token row of another account still references it).
accountRouter.post('/apps/revoke', async (c) => {
  const body = await c.req.parseBody() as Record<string, unknown>;
  const clientId = typeof body.client_id === 'string' ? body.client_id : '';
  if (!clientId) return c.text('client_id is required', 400);

  const db = getDb(c);
  if (!db || typeof db.prepare !== 'function') return c.text('Server database is not configured', 503);
  const username = c.get('instance').accountUsername;
  await db.prepare('DELETE FROM oauth_tokens WHERE client_id = ? AND user_id = ?').bind(clientId, username).run();
  await db.prepare('DELETE FROM oauth_codes WHERE client_id = ? AND user_id = ?').bind(clientId, username).run();
  await db.prepare('DELETE FROM oauth_clients WHERE id = ? AND NOT EXISTS (SELECT 1 FROM oauth_tokens WHERE client_id = ?)')
    .bind(clientId, clientId)
    .run();
  return c.redirect('/account', 302);
});

// App authorizations used to have their own page.
accountRouter.get('/tokens', (c) => c.redirect('/account', 302));

// ── Browse ───────────────────────────────────────────────────────────────────

accountRouter.get('/browse', async (c) => {
  const username = c.get('instance').accountUsername;

  const storage = getStorage(c);
  const items = await listFolder(storage, username, '');

  const rows = items.length
    ? items.map(item => `
      <tr>
        <td><span class="icon">${item.isDir ? '📁' : '📄'}</span>
          ${item.isDir
            ? `<a href="/account/browse/${encodeURIComponent(item.name)}">${escapeHtml(item.name)}</a>`
            : `<a href="/account/download/${encodeURIComponent(item.name)}">${escapeHtml(item.name)}</a>`}
        </td>
        <td class="size">${item.isDir ? '—' : formatBytes(item.size)}</td>
        <td class="actions">
          ${!item.isDir ? `
            <a href="/account/view/${encodeURIComponent(item.name)}" class="btn btn-sm">View</a>
            <a href="/account/download/${encodeURIComponent(item.name)}" class="btn btn-sm" download>Download</a>
            <form method="POST" action="/account/delete/${encodeURIComponent(item.name)}" style="margin:0" data-confirm-message="Delete ${escapeHtml(item.name)}?">
              <button class="btn btn-sm btn-danger">Delete</button>
            </form>` : ''}
        </td>
      </tr>`).join('')
    : `<tr><td colspan="3" class="empty">No files yet. Upload some files to get started.</td></tr>`;

  const body = `
  <div class="container">
    <div class="breadcrumb"><a href="/account/browse">Home</a></div>
    <div class="card">
      <table>
        <thead><tr><th>Name</th><th>Size</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="upload-section">
        <label>Folder (optional):</label>
        <input type="text" id="upload-module" placeholder="documents" style="padding:.35rem .6rem;border:1px solid #ddd;border-radius:4px;font-size:.875rem;width:140px">
        <label for="upload-files">Files:</label>
        <input type="file" id="upload-files" multiple>
        <button class="btn btn-primary btn-sm" data-upload-path="" data-folder-input="upload-module" data-file-input="upload-files">Upload</button>
      </div>
    </div>
  </div>`;

  return new Response(renderPage('Files', c.get('ownerEmail'), body), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
});

accountRouter.get('/browse/*', async (c) => {
  const username = c.get('instance').accountUsername;

  const browsePath = c.req.path.replace(/^\/account\/browse\/?/, '') || '';
  const storage = getStorage(c);
  const items = await listFolder(storage, username, browsePath);

  const pathSegments = browsePath.split('/').filter(Boolean);
  const breadcrumb = ['<a href="/account/browse">Home</a>'];
  let cumPath = '';
  for (const seg of pathSegments) {
    cumPath += (cumPath ? '/' : '') + seg;
    breadcrumb.push(`<span>/</span><a href="/account/browse/${encodeURIComponent(cumPath)}">${escapeHtml(seg)}</a>`);
  }

  const rows = items.length
    ? items.map(item => {
        const itemPath = browsePath ? `${browsePath}/${item.name}` : item.name;
        return `
        <tr>
          <td><span class="icon">${item.isDir ? '📁' : '📄'}</span>
            ${item.isDir
              ? `<a href="/account/browse/${encodePath(itemPath)}">${escapeHtml(item.name)}</a>`
              : `<a href="/account/download/${encodePath(itemPath)}">${escapeHtml(item.name)}</a>`}
          </td>
          <td class="size">${item.isDir ? '—' : formatBytes(item.size)}</td>
          <td class="actions">
            ${!item.isDir ? `
              <a href="/account/view/${encodePath(itemPath)}" class="btn btn-sm">View</a>
              <a href="/account/download/${encodePath(itemPath)}" class="btn btn-sm" download="${escapeHtml(item.name)}">Download</a>
              <form method="POST" action="/account/delete/${encodePath(itemPath)}" style="margin:0" data-confirm-message="Delete ${escapeHtml(item.name)}?">
                <button class="btn btn-sm btn-danger">Delete</button>
              </form>` : ''}
          </td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="3" class="empty">Empty folder.</td></tr>`;

  const body = `
  <div class="container">
    <div class="breadcrumb">${breadcrumb.join('')}</div>
    <div class="card">
      <table>
        <thead><tr><th>Name</th><th>Size</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="upload-section">
        <label>Subfolder (optional):</label>
        <input type="text" id="upload-sub" placeholder="new-folder" style="padding:.35rem .6rem;border:1px solid #ddd;border-radius:4px;font-size:.875rem;width:140px">
        <label>Files:</label>
        <input type="file" id="upload-files-sub" multiple>
        <button class="btn btn-primary btn-sm" data-upload-path="${escapeHtml(browsePath)}" data-folder-input="upload-sub" data-file-input="upload-files-sub">Upload</button>
      </div>
    </div>
  </div>`;

  return new Response(renderPage(browsePath || 'Files', c.get('ownerEmail'), body), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
});

// ── Download ─────────────────────────────────────────────────────────────────

accountRouter.get('/download/*', async (c) => {
  const username = c.get('instance').accountUsername;

  const filePath = c.req.path.replace(/^\/account\/download\/?/, '');
  if (!filePath) return c.text('Not found', 404);

  const storage = getStorage(c);
  const key = buildKey(username, filePath);
  const result = await storage.get(key);

  if (!result) return c.text('Not found', 404);

  const filename = filePath.split('/').pop() || 'download';
  return new Response(result.body, {
    headers: {
      'Content-Type': result.metadata.contentType || 'application/octet-stream',
      'Content-Length': String(result.metadata.contentLength),
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      'ETag': result.metadata.etag || '',
    },
  });
});

// ── View ─────────────────────────────────────────────────────────────────────

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'json', 'ts', 'js', 'jsx', 'tsx', 'css', 'html', 'xml',
  'yaml', 'yml', 'toml', 'sh', 'py', 'rb', 'go', 'rs', 'csv', 'log',
  'env', 'sql', 'graphql', 'svelte', 'vue', 'c', 'h', 'cpp', 'java',
]);

accountRouter.get('/view/*', async (c) => {
  const username = c.get('instance').accountUsername;

  const filePath = c.req.path.replace(/^\/account\/view\/?/, '');
  if (!filePath) return c.text('Not found', 404);

  const storage = getStorage(c);
  const key = buildKey(username, filePath);
  const result = await storage.get(key);

  if (!result) return c.text('Not found', 404);

  const contentType = result.metadata.contentType || 'application/octet-stream';
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const isText = contentType.startsWith('text/') || contentType === 'application/json' || TEXT_EXTENSIONS.has(ext);

  if (!isText) {
    return c.redirect(`/account/download/${encodePath(filePath)}`, 302);
  }

  const maximum = maxObjectSize(c.env);
  if (result.metadata.contentLength > maximum) return c.text(`Object exceeds the ${maximum}-byte limit`, 413);
  const buffer = result.body instanceof ArrayBuffer ? result.body : await new Response(result.body).arrayBuffer();
  const text = new TextDecoder().decode(buffer);
  const filename = filePath.split('/').pop() || filePath;

  const pathSegments = filePath.split('/').filter(Boolean);
  const breadcrumb = ['<a href="/account/browse">Home</a>'];
  let cumPath = '';
  for (let i = 0; i < pathSegments.length - 1; i++) {
    cumPath += (cumPath ? '/' : '') + pathSegments[i];
    breadcrumb.push(`<span>/</span><a href="/account/browse/${encodeURIComponent(cumPath)}">${escapeHtml(pathSegments[i])}</a>`);
  }
  breadcrumb.push(`<span>/</span>${escapeHtml(filename)}`);

  const body = `
  <div class="container">
    <div class="breadcrumb">${breadcrumb.join('')}</div>
    <div class="card" style="padding:0">
      <div style="padding:0.75rem 1rem;border-bottom:1px solid #eee;display:flex;align-items:center;gap:0.5rem;background:#fafafa">
        <span style="font-weight:500;font-size:0.9rem;flex:1">${escapeHtml(filename)}</span>
        <a href="/account/download/${encodePath(filePath)}" class="btn btn-sm" download="${escapeHtml(filename)}">Download</a>
        <button id="edit-btn" class="btn btn-sm btn-primary">Edit</button>
        <button id="save-btn" class="btn btn-sm btn-primary" style="display:none" data-save-path="/account/save/${encodePath(filePath)}">Save</button>
        <button id="cancel-btn" class="btn btn-sm" style="display:none;border:1px solid #ddd">Cancel</button>
      </div>
      <pre id="view-pre" style="padding:1rem;margin:0;overflow-x:auto;font-size:0.85rem;line-height:1.5;white-space:pre-wrap;word-wrap:break-word;background:white">${escapeHtml(text)}</pre>
      <textarea id="edit-area" style="display:none;width:100%;padding:1rem;border:none;font-family:monospace;font-size:0.85rem;line-height:1.5;resize:vertical;min-height:400px;outline:none;box-sizing:border-box">${escapeHtml(text)}</textarea>
    </div>
  </div>`;

  return new Response(renderPage(filename, c.get('ownerEmail'), body), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
});

// ── Save (edit) ──────────────────────────────────────────────────────────────

accountRouter.post('/save/*', async (c) => {
  const username = c.get('instance').accountUsername;

  const filePath = c.req.path.replace(/^\/account\/save\/?/, '');
  if (!filePath) return c.redirect('/account/browse', 302);

  const body = await c.req.parseBody() as any;
  const content: string = body.content ?? '';

  const storage = getStorage(c);
  const key = buildKey(username, filePath);

  const existing = await storage.head(key);
  const contentType = existing?.contentType || 'text/plain; charset=utf-8';
  const encoded = new TextEncoder().encode(content);
  if (encoded.byteLength > maxObjectSize(c.env)) return c.text('Object exceeds the configured size limit', 413);
  try {
    await putUserObject({
      storage,
      db: getDb(c),
      allowUnaccounted: isLocalDevelopment(c.env),
      username,
      key,
      body: encoded.buffer as ArrayBuffer,
      contentType,
      existing,
    });
  } catch (error) {
    if (error instanceof QuotaExceededError) return c.text('Storage quota exceeded', 413);
    if (error instanceof StorageAccountingError) return c.text(error.message, 503);
    throw error;
  }

  return new Response(null, { status: 204 });
});

// ── Upload ───────────────────────────────────────────────────────────────────

accountRouter.post('/upload/*', async (c) => {
  const username = c.get('instance').accountUsername;

  const maximum = maxObjectSize(c.env);
  try {
    rejectOversizedContentLength(c.req.raw, maximum, 1024 * 1024);
  } catch (error) {
    if (error instanceof ObjectTooLargeError) return c.text(error.message, 413);
    throw error;
  }
  const folderPath = c.req.path.replace(/^\/account\/upload\/?/, '');

  const body = await c.req.parseBody({ all: true }) as any;
  const rawFiles = body['files'];
  const fileList: File[] = rawFiles
    ? (Array.isArray(rawFiles) ? rawFiles : [rawFiles]).filter((f: any) => f instanceof File && f.size > 0)
    : [];

  if (!fileList.length) {
    return c.redirect(`/account/browse/${encodePath(folderPath)}`, 302);
  }
  if (fileList.some((file) => file.size > maximum)) {
    return c.text('Object exceeds the configured size limit', 413);
  }

  const storage = getStorage(c);
  const db = getDb(c);

  for (const file of fileList) {
    const filePath = folderPath ? `${folderPath}/${file.name}` : file.name;
    const key = buildKey(username, filePath);
    const buffer = await file.arrayBuffer();
    const existing = await storage.head(key);
    try {
      await putUserObject({
        storage,
        db,
        allowUnaccounted: isLocalDevelopment(c.env),
        username,
        key,
        body: buffer,
        contentType: file.type || 'application/octet-stream',
        existing,
      });
    } catch (error) {
      if (error instanceof QuotaExceededError) return c.text('Storage quota exceeded', 413);
      if (error instanceof StorageAccountingError) return c.text(error.message, 503);
      throw error;
    }
  }

  return c.redirect(`/account/browse/${encodePath(folderPath)}`, 302);
});

// ── Delete ───────────────────────────────────────────────────────────────────

accountRouter.post('/delete/*', async (c) => {
  const username = c.get('instance').accountUsername;

  const filePath = c.req.path.replace(/^\/account\/delete\/?/, '');
  if (!filePath) return c.redirect('/account/browse', 302);

  const storage = getStorage(c);
  const key = buildKey(username, filePath);

  const existing = await storage.head(key);
  if (existing) {
    try {
      await deleteUserObject({
        storage,
        db: getDb(c),
        allowUnaccounted: isLocalDevelopment(c.env),
        username,
        key,
        existing,
      });
    } catch (error) {
      if (error instanceof StorageAccountingError) return c.text(error.message, 503);
      throw error;
    }
  }

  const parentPath = filePath.split('/').slice(0, -1).join('/');
  return c.redirect(`/account/browse${parentPath ? '/' + encodeURIComponent(parentPath) : ''}`, 302);
});

