import { Hono } from 'hono';
import { verifyPassword, signSessionToken, verifySessionToken } from '../services/auth';
import { buildKey } from '../services/r2';

export const accountRouter = new Hono();

const SESSION_COOKIE = 'rsilo_session';
const SESSION_EXPIRY = 28800; // 8 hours

function getSessionSecret(env: any): string {
  return env?.SESSION_SECRET || 'dev-session-secret-change-in-production';
}

function getSessionFromRequest(req: Request): string | null {
  const cookie = req.headers.get('Cookie') || '';
  for (const part of cookie.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const k = part.slice(0, eqIdx).trim();
    const v = part.slice(eqIdx + 1).trim();
    if (k === SESSION_COOKIE) return v || null;
  }
  return null;
}

async function getSessionUser(c: any): Promise<string | null> {
  const token = getSessionFromRequest(c.req.raw);
  if (!token) return null;
  return verifySessionToken(token, getSessionSecret(c.env));
}

function sessionCookieHeader(token: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/account; Max-Age=${maxAge}`;
}

function getStorage(c: any) {
  return c.env.STORAGE;
}

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
`;

function renderPage(title: string, username: string, body: string, activePage = 'account'): string {
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
    <h1><a href="/account/browse" style="color:white">RSilo Files</a></h1>
    <nav>
      <a href="/account/browse" class="${activePage === 'account' ? 'active' : ''}">Files</a>
      <a href="/account/tokens" class="${activePage === 'tokens' ? 'active' : ''}">Tokens</a>
    </nav>
    <span class="user">${escapeHtml(username)}</span>
    <form method="POST" action="/account/logout" style="margin:0">
      <button class="btn" style="background:transparent;color:#aaa;font-size:0.8rem;padding:0.2rem 0.5rem">Sign out</button>
    </form>
  </header>
  ${body}
</body>
</html>`;
}

// ── Login ────────────────────────────────────────────────────────────────────

accountRouter.get('/', async (c) => {
  const user = await getSessionUser(c);
  if (user) return c.redirect('/account/browse', 302);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign in — RSilo Files</title>
  <style>
    ${COMMON_CSS}
    .login-wrap { display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #f5f5f5; }
    .login-box { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,0.12); width: 100%; max-width: 360px; }
    .login-box h1 { font-size: 1.25rem; margin-bottom: 1.5rem; }
    .field { margin-bottom: 1rem; }
    label { display: block; font-size: 0.875rem; font-weight: 500; margin-bottom: 0.3rem; }
    input[type=text], input[type=password] { width: 100%; padding: 0.5rem 0.75rem; border: 1px solid #ddd; border-radius: 4px; font-size: 1rem; }
    input:focus { outline: none; border-color: #0066cc; box-shadow: 0 0 0 2px rgba(0,102,204,.15); }
    .btn-block { width: 100%; padding: 0.65rem; font-size: 1rem; margin-top: 0.5rem; }
  </style>
</head>
<body>
  <div class="login-wrap">
    <div class="login-box">
      <h1>RSilo Files</h1>
      ${c.req.query('error') ? `<div class="error">Invalid username or password</div>` : ''}
      <form method="POST" action="/account/login">
        <div class="field">
          <label for="username">Username</label>
          <input type="text" id="username" name="username" autofocus autocomplete="username">
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" autocomplete="current-password">
        </div>
        <button type="submit" class="btn btn-primary btn-block">Sign in</button>
      </form>
    </div>
  </div>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
});

accountRouter.post('/login', async (c) => {
  const body = await c.req.parseBody() as any;
  const username = (body.username || '').trim().toLowerCase();
  const password = body.password || '';

  if (!username || !password) return c.redirect('/account/?error=1', 302);

  const db = getDb(c);
  const user = await db?.prepare?.('SELECT * FROM users WHERE username = ?')?.bind?.(username)?.first?.();

  if (!user || !user.password_hash || !(await verifyPassword(password, user.password_hash))) {
    return c.redirect('/account/?error=1', 302);
  }

  const token = await signSessionToken(username, getSessionSecret(c.env), SESSION_EXPIRY);
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/account/browse',
      'Set-Cookie': sessionCookieHeader(token, SESSION_EXPIRY),
    },
  });
});

accountRouter.post('/logout', async () => {
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/account/',
      'Set-Cookie': sessionCookieHeader('', 0),
    },
  });
});

// ── Browse ───────────────────────────────────────────────────────────────────

accountRouter.get('/browse', async (c) => {
  const username = await getSessionUser(c);
  if (!username) return c.redirect('/account/', 302);

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
            <form method="POST" action="/account/delete/${encodeURIComponent(item.name)}" style="margin:0" onsubmit="return confirm('Delete ${escapeHtml(item.name)}?')">
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
        <button class="btn btn-primary btn-sm" onclick="uploadToModule()">Upload</button>
      </div>
    </div>
  </div>
  <script>
    function uploadToModule() {
      const mod = document.getElementById('upload-module').value.trim();
      const files = document.getElementById('upload-files').files;
      if (!files.length) { alert('Select at least one file'); return; }
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = '/account/upload/' + (mod ? mod.split('/').map(encodeURIComponent).join('/') : '');
      form.enctype = 'multipart/form-data';
      const input = document.createElement('input');
      input.type = 'file'; input.name = 'files'; input.multiple = true;
      form.appendChild(input);
      document.body.appendChild(form);
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      input.files = dt.files;
      form.submit();
    }
  </script>`;

  return new Response(renderPage('Files', username, body), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
});

accountRouter.get('/browse/*', async (c) => {
  const username = await getSessionUser(c);
  if (!username) return c.redirect('/account/', 302);

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
              <form method="POST" action="/account/delete/${encodePath(itemPath)}" style="margin:0" onsubmit="return confirm('Delete ${escapeHtml(item.name)}?')">
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
        <button class="btn btn-primary btn-sm" onclick="uploadHere()">Upload</button>
      </div>
      <script>
        function uploadHere() {
          const sub = document.getElementById('upload-sub').value.trim();
          const files = document.getElementById('upload-files-sub').files;
          if (!files.length) { alert('Select at least one file'); return; }
          const base = ${JSON.stringify(browsePath)};
          const target = sub ? (base ? base + '/' + sub : sub) : base;
          const form = document.createElement('form');
          form.method = 'POST';
          form.action = '/account/upload/' + target.split('/').map(encodeURIComponent).join('/');
          form.enctype = 'multipart/form-data';
          const input = document.createElement('input');
          input.type = 'file'; input.name = 'files'; input.multiple = true;
          form.appendChild(input);
          document.body.appendChild(form);
          const dt = new DataTransfer();
          for (const f of files) dt.items.add(f);
          input.files = dt.files;
          form.submit();
        }
      </script>
    </div>
  </div>`;

  return new Response(renderPage(browsePath || 'Files', username, body), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
});

// ── Download ─────────────────────────────────────────────────────────────────

accountRouter.get('/download/*', async (c) => {
  const username = await getSessionUser(c);
  if (!username) return c.redirect('/account/', 302);

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
      'Content-Length': String(result.metadata.contentLength || result.body.byteLength),
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
  const username = await getSessionUser(c);
  if (!username) return c.redirect('/account/', 302);

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

  const buffer = result.body instanceof ArrayBuffer ? result.body : await (result.body as any).arrayBuffer();
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
        <button id="edit-btn" class="btn btn-sm btn-primary" onclick="startEdit()">Edit</button>
        <button id="save-btn" class="btn btn-sm btn-primary" style="display:none" onclick="saveEdit()">Save</button>
        <button id="cancel-btn" class="btn btn-sm" style="display:none;border:1px solid #ddd" onclick="cancelEdit()">Cancel</button>
      </div>
      <pre id="view-pre" style="padding:1rem;margin:0;overflow-x:auto;font-size:0.85rem;line-height:1.5;white-space:pre-wrap;word-wrap:break-word;background:white">${escapeHtml(text)}</pre>
      <textarea id="edit-area" style="display:none;width:100%;padding:1rem;border:none;font-family:monospace;font-size:0.85rem;line-height:1.5;resize:vertical;min-height:400px;outline:none;box-sizing:border-box"></textarea>
    </div>
  </div>
  <script>
    const original = ${JSON.stringify(text)};
    function startEdit() {
      document.getElementById('view-pre').style.display = 'none';
      const ta = document.getElementById('edit-area');
      ta.value = original;
      ta.style.display = 'block';
      ta.style.height = Math.max(400, ta.scrollHeight) + 'px';
      ta.focus();
      document.getElementById('edit-btn').style.display = 'none';
      document.getElementById('save-btn').style.display = '';
      document.getElementById('cancel-btn').style.display = '';
    }
    function cancelEdit() {
      document.getElementById('edit-area').style.display = 'none';
      document.getElementById('view-pre').style.display = '';
      document.getElementById('edit-btn').style.display = '';
      document.getElementById('save-btn').style.display = 'none';
      document.getElementById('cancel-btn').style.display = 'none';
    }
    async function saveEdit() {
      const content = document.getElementById('edit-area').value;
      const btn = document.getElementById('save-btn');
      btn.textContent = 'Saving…';
      btn.disabled = true;
      const form = new FormData();
      form.append('content', content);
      const res = await fetch('/account/save/${encodePath(filePath)}', { method: 'POST', body: form });
      if (res.ok || res.redirected) {
        location.reload();
      } else {
        alert('Save failed');
        btn.textContent = 'Save';
        btn.disabled = false;
      }
    }
  </script>`;

  return new Response(renderPage(filename, username, body), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
});

// ── Save (edit) ──────────────────────────────────────────────────────────────

accountRouter.post('/save/*', async (c) => {
  const username = await getSessionUser(c);
  if (!username) return c.redirect('/account/', 302);

  const filePath = c.req.path.replace(/^\/account\/save\/?/, '');
  if (!filePath) return c.redirect('/account/browse', 302);

  const body = await c.req.parseBody() as any;
  const content: string = body.content ?? '';

  const storage = getStorage(c);
  const key = buildKey(username, filePath);

  const existing = await storage.head(key);
  const contentType = existing?.contentType || 'text/plain; charset=utf-8';
  const encoded = new TextEncoder().encode(content);
  await storage.put(key, encoded.buffer as ArrayBuffer, contentType);

  const db = getDb(c);
  if (db?.prepare && existing) {
    const delta = encoded.byteLength - (existing.contentLength || 0);
    await db.prepare('UPDATE users SET used_storage_bytes = MAX(0, used_storage_bytes + ?) WHERE username = ?')
      .bind(delta, username).run();
  }

  return new Response(null, { status: 204 });
});

// ── Upload ───────────────────────────────────────────────────────────────────

accountRouter.post('/upload/*', async (c) => {
  const username = await getSessionUser(c);
  if (!username) return c.redirect('/account/', 302);

  const folderPath = c.req.path.replace(/^\/account\/upload\/?/, '');

  const body = await c.req.parseBody({ all: true }) as any;
  const rawFiles = body['files'];
  const fileList: File[] = rawFiles
    ? (Array.isArray(rawFiles) ? rawFiles : [rawFiles]).filter((f: any) => f instanceof File && f.size > 0)
    : [];

  if (!fileList.length) {
    return c.redirect(`/account/browse/${encodePath(folderPath)}`, 302);
  }

  const storage = getStorage(c);
  const db = getDb(c);

  for (const file of fileList) {
    const filePath = folderPath ? `${folderPath}/${file.name}` : file.name;
    const key = buildKey(username, filePath);
    const buffer = await file.arrayBuffer();
    await storage.put(key, buffer, file.type || 'application/octet-stream');

    if (db?.prepare) {
      await db.prepare('UPDATE users SET used_storage_bytes = used_storage_bytes + ? WHERE username = ?')
        .bind(buffer.byteLength, username).run();
    }
  }

  return c.redirect(`/account/browse/${encodePath(folderPath)}`, 302);
});

// ── Delete ───────────────────────────────────────────────────────────────────

accountRouter.post('/delete/*', async (c) => {
  const username = await getSessionUser(c);
  if (!username) return c.redirect('/account/', 302);

  const filePath = c.req.path.replace(/^\/account\/delete\/?/, '');
  if (!filePath) return c.redirect('/account/browse', 302);

  const storage = getStorage(c);
  const key = buildKey(username, filePath);

  const existing = await storage.head(key);
  if (existing) {
    await storage.delete(key);
    const db = getDb(c);
    if (db?.prepare) {
      await db.prepare('UPDATE users SET used_storage_bytes = MAX(0, used_storage_bytes - ?) WHERE username = ?')
        .bind(existing.contentLength || 0, username).run();
    }
  }

  const parentPath = filePath.split('/').slice(0, -1).join('/');
  return c.redirect(`/account/browse${parentPath ? '/' + encodeURIComponent(parentPath) : ''}`, 302);
});

// ── Tokens ───────────────────────────────────────────────────────────────────

accountRouter.get('/tokens', async (c) => {
  const username = await getSessionUser(c);
  if (!username) return c.redirect('/account/', 302);

  const db = getDb(c);
  const tokensResult = await db?.prepare?.('SELECT * FROM oauth_tokens WHERE user_id = ? ORDER BY created_at DESC')
    ?.bind?.(username)?.all?.() || { results: [] };
  const tokens: any[] = tokensResult.results || [];

  const rows = tokens.length
    ? tokens.map(tok => {
        const exp = new Date(tok.expires_at * 1000);
        const expired = tok.expires_at < Math.floor(Date.now() / 1000);
        return `
        <tr>
          <td><code style="font-size:.8rem">${escapeHtml(tok.client_id)}</code></td>
          <td><span style="font-size:.8rem;color:#555">${escapeHtml(tok.scopes)}</span></td>
          <td class="size">${expired ? '<span style="color:#dc3545">Expired</span>' : exp.toLocaleDateString()}</td>
          <td class="actions">
            <form method="POST" action="/account/tokens/${escapeHtml(tok.id)}/revoke" style="margin:0"
              onsubmit="return confirm('Revoke this token?')">
              <button class="btn btn-sm btn-danger">Revoke</button>
            </form>
          </td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="4" class="empty">No active tokens.</td></tr>`;

  const body = `
  <div class="container">
    <div class="breadcrumb">OAuth Tokens</div>
    <p style="font-size:.875rem;color:#666;margin-bottom:1rem">
      These are apps that have been granted access to your storage. Revoke any you no longer use.
    </p>
    <div class="card">
      <table>
        <thead><tr><th>Application</th><th>Scopes</th><th>Expires</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;

  return new Response(renderPage('Tokens', username, body, 'tokens'), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
});

accountRouter.post('/tokens/:id/revoke', async (c) => {
  const username = await getSessionUser(c);
  if (!username) return c.redirect('/account/', 302);

  const tokenId = c.req.param('id');
  const db = getDb(c);
  await db?.prepare?.('DELETE FROM oauth_tokens WHERE id = ? AND user_id = ?')?.bind?.(tokenId, username)?.run?.();

  return c.redirect('/account/tokens', 302);
});
