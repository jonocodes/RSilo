import { Hono } from 'hono';
import { hashPassword, signSessionToken, verifySessionToken } from '../services/auth';
import { getAdminSecret, isLocalDevelopment } from '../config';
import { buildKey, getStorage } from '../services/r2';
import { enforceRateLimit } from '../services/rate-limit';
import { debugRouter } from './debug';

export const adminRouter = new Hono();

const ADMIN_SESSION_COOKIE = 'admin_session';
const ADMIN_SESSION_EXPIRY = 28800; // 8 hours

function getAdminCookie(req: Request): string | null {
  const cookie = req.headers.get('Cookie') || '';
  for (const part of cookie.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const k = part.slice(0, eqIdx).trim();
    const v = part.slice(eqIdx + 1).trim();
    if (k === ADMIN_SESSION_COOKIE) return v || null;
  }
  return null;
}

function adminCookieHeader(token: string, maxAge: number): string {
  return `${ADMIN_SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${maxAge}`;
}

adminRouter.use('*', async (c, next) => {
  const secret = getAdminSecret(c.env);
  if (!secret) {
    if (isLocalDevelopment(c.env)) {
      await next();
      return;
    }
    return c.json({ error: 'Server authentication is not configured' }, 503);
  }

  // Login/logout routes are always accessible
  const pathname = new URL(c.req.url).pathname;
  if (pathname === '/admin/login' || pathname === '/admin/logout') {
    await next();
    return;
  }

  // Bearer token (API / curl access)
  const auth = c.req.header('Authorization') || '';
  if (auth === `Bearer ${secret}`) {
    await next();
    return;
  }

  // Session cookie (browser access)
  const sessionToken = getAdminCookie(c.req.raw);
  if (sessionToken) {
    const valid = await verifySessionToken(sessionToken, secret);
    if (valid) {
      await next();
      return;
    }
  }

  // Redirect browsers to login; return 401 for API clients
  const accept = c.req.header('Accept') || '';
  if (accept.includes('text/html')) {
    return c.redirect('/admin/login', 302);
  }
  return c.json({ error: 'Unauthorized' }, 401);
});

// ── Login ────────────────────────────────────────────────────────────────────

function loginPage(error = false): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin — RSilo</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .box { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,0.12); width: 100%; max-width: 340px; }
    h1 { font-size: 1.25rem; margin-bottom: 1.5rem; }
    .field { margin-bottom: 1rem; }
    label { display: block; font-size: 0.875rem; font-weight: 500; margin-bottom: 0.3rem; }
    input[type=password] { width: 100%; padding: 0.5rem 0.75rem; border: 1px solid #ddd; border-radius: 4px; font-size: 1rem; }
    input:focus { outline: none; border-color: #0066cc; box-shadow: 0 0 0 2px rgba(0,102,204,.15); }
    button { width: 100%; padding: 0.65rem; background: #1a1a1a; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; margin-top: 0.5rem; }
    button:hover { background: #333; }
    .error { color: #dc3545; font-size: 0.875rem; padding: 0.5rem 0.75rem; background: #fff5f5; border-radius: 4px; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <div class="box">
    <h1>RSilo Admin</h1>
    ${error ? `<div class="error">Invalid admin secret</div>` : ''}
    <form method="POST" action="/admin/login">
      <div class="field">
        <label for="secret">Admin secret</label>
        <input type="password" id="secret" name="secret" autofocus autocomplete="off">
      </div>
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`;
}

adminRouter.get('/login', async (c) => {
  const secret = getAdminSecret(c.env);
  if (!secret) return c.redirect('/admin', 302);

  const sessionToken = getAdminCookie(c.req.raw);
  if (sessionToken && await verifySessionToken(sessionToken, secret)) {
    return c.redirect('/admin/', 302);
  }

  return new Response(loginPage(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
});

adminRouter.post('/login', async (c) => {
  const secret = getAdminSecret(c.env);
  if (!secret) return c.redirect('/admin', 302);

  const rateLimited = await enforceRateLimit(c, { namespace: 'admin-login', account: 'admin' });
  if (rateLimited) return rateLimited;
  const body = await c.req.parseBody() as any;
  const submitted = (body.secret || '').trim();

  if (submitted !== secret) {
    return new Response(loginPage(true), {
      status: 401,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  const token = await signSessionToken('admin', secret, ADMIN_SESSION_EXPIRY);
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/admin',
      'Set-Cookie': adminCookieHeader(token, ADMIN_SESSION_EXPIRY),
    },
  });
});

adminRouter.post('/logout', async () => {
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/admin/login',
      'Set-Cookie': adminCookieHeader('', 0),
    },
  });
});

// ── Dashboard ────────────────────────────────────────────────────────────────

adminRouter.get('/', async (c) => {
  const db = (c.env as any).DB;

  const usersResult = await db?.prepare?.('SELECT id, username, created_at, storage_quota_bytes, used_storage_bytes FROM users ORDER BY created_at DESC LIMIT 100')?.all?.() || { results: [] };
  const userCountResult = await db?.prepare?.('SELECT COUNT(*) as count FROM users')?.first?.() || { count: 0 };
  const totalStorageResult = await db?.prepare?.('SELECT SUM(used_storage_bytes) as total FROM users')?.first?.() || { total: 0 };
  const tokenCountResult = await db?.prepare?.('SELECT COUNT(*) as count FROM oauth_tokens')?.first?.() || { count: 0 };
  const authorizationsResult = await db?.prepare?.('SELECT id, client_id, user_id, scopes, created_at, expires_at FROM oauth_tokens ORDER BY created_at DESC LIMIT 100')?.all?.() || { results: [] };

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RSilo Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; line-height: 1.6; }
    .container { max-width: 1200px; margin: 0 auto; padding: 2rem; }
    .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; }
    h1 { color: #1a1a1a; }
    h2 { margin-bottom: 1rem; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .stat-card { background: white; padding: 1.5rem; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .stat-card h3 { font-size: 0.875rem; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
    .stat-card .value { font-size: 2rem; font-weight: 600; color: #1a1a1a; margin-top: 0.5rem; }
    table { width: 100%; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th, td { padding: 1rem; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #fafafa; font-weight: 600; color: #666; font-size: 0.875rem; }
    tr:last-child td { border-bottom: none; }
    .actions { display: flex; gap: 0.5rem; align-items: center; }
    .btn { padding: 0.4rem 0.85rem; border-radius: 4px; text-decoration: none; font-size: 0.8rem; cursor: pointer; border: none; font-family: inherit; }
    .btn-primary { background: #0066cc; color: white; }
    .btn-primary:hover { background: #0052a3; }
    .btn-danger { background: white; color: #dc3545; border: 1px solid #dc3545; }
    .btn-danger:hover { background: #dc3545; color: white; }
    .btn-subtle { background: white; color: #555; border: 1px solid #ddd; }
    .btn-subtle:hover { background: #f5f5f5; }
    .quota-form { display: flex; gap: 0.5rem; align-items: center; }
    .quota-input { padding: 0.4rem 0.6rem; border: 1px solid #ddd; border-radius: 4px; width: 120px; font-size: 0.8rem; }
    .usage-bar { width: 80px; height: 6px; background: #eee; border-radius: 4px; overflow: hidden; display: inline-block; vertical-align: middle; margin-left: 0.5rem; }
    .usage-bar-fill { height: 100%; background: #0066cc; }
    .create-section { margin-bottom: 2rem; background: white; padding: 1.5rem; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .create-form { display: flex; gap: 0.5rem; align-items: flex-end; flex-wrap: wrap; }
    .form-field { display: flex; flex-direction: column; gap: 0.25rem; }
    .form-field label { font-size: 0.875rem; font-weight: 500; }
    .form-field input { padding: 0.5rem; border: 1px solid #ddd; border-radius: 4px; font-size: 0.875rem; }
    .welcome { background: #e7f3ff; border: 1px solid #b6d7ff; padding: 1.25rem 1.5rem; border-radius: 8px; margin-bottom: 1.5rem; }
    .welcome h2 { margin-bottom: 0.25rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="page-header">
      <h1>RSilo Admin</h1>
      <form method="POST" action="/admin/logout" style="margin:0">
        <button type="submit" class="btn btn-subtle">Sign out</button>
      </form>
    </div>

    ${(userCountResult?.count || 0) === 0 ? `<div class="welcome">
      <h2>Welcome to RSilo</h2>
      <p>No users yet. Create your first account in the <strong>Create User</strong> section below, then sign in at <a href="/account">/account</a>.</p>
    </div>` : ''}

    <div class="stats">
      <div class="stat-card">
        <h3>Total Users</h3>
        <div class="value">${userCountResult?.count || 0}</div>
      </div>
      <div class="stat-card">
        <h3>Total Storage</h3>
        <div class="value">${formatBytes(totalStorageResult?.total || 0)}</div>
      </div>
      <div class="stat-card">
        <h3>Active Tokens</h3>
        <div class="value">${tokenCountResult?.count || 0}</div>
      </div>
    </div>

    <div class="create-section">
      <h2>Create User</h2>
      <div class="create-form">
        <div class="form-field">
          <label for="new-username">Username</label>
          <input type="text" id="new-username" placeholder="alice">
        </div>
        <div class="form-field">
          <label for="new-password">Password</label>
          <input type="password" id="new-password" placeholder="••••••••">
        </div>
        <button class="btn btn-primary" style="padding:.5rem 1rem;font-size:.875rem" onclick="createUser()">Create</button>
      </div>
    </div>

    <h2 style="margin-bottom:1rem">Users</h2>
    <table>
      <thead>
        <tr>
          <th>Username</th>
          <th>Created</th>
          <th>Storage used</th>
          <th>Quota</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${(usersResult.results || []).map((user: any) => `
        <tr>
          <td><strong>${escapeHtml(user.username)}</strong></td>
          <td style="color:#666;font-size:.875rem">${new Date(user.created_at * 1000).toLocaleDateString()}</td>
          <td style="font-size:.875rem">
            ${formatBytes(user.used_storage_bytes || 0)}
            <div class="usage-bar"><div class="usage-bar-fill" style="width:${Math.min(100, ((user.used_storage_bytes || 0) / (user.storage_quota_bytes || 1)) * 100)}%"></div></div>
          </td>
          <td style="font-size:.875rem">${formatBytes(user.storage_quota_bytes || 0)}</td>
          <td class="actions">
            <form class="quota-form" onsubmit="updateQuota(event, '${escapeHtml(user.username)}')">
              <input type="number" class="quota-input" name="quota" value="${Math.round((user.storage_quota_bytes || 0) / 1048576)}" step="1024" min="1024">
              <button type="submit" class="btn btn-primary">Set quota</button>
            </form>
            <button class="btn btn-danger" onclick="deleteUser('${escapeHtml(user.username)}')">Delete</button>
          </td>
        </tr>
        `).join('')}
      </tbody>
    </table>

    <h2 style="margin:2rem 0 1rem">Authorized apps</h2>
    <p style="color:#666;font-size:.875rem;margin-bottom:1rem">One row per authorization. Apps are registered automatically the first time someone approves them.</p>
    <table>
      <thead>
        <tr>
          <th>App</th>
          <th>User</th>
          <th>Scopes</th>
          <th>Authorized</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${(authorizationsResult.results || []).length === 0 ? '<tr><td colspan="5" style="color:#666">No apps authorized yet.</td></tr>' : ''}
        ${(authorizationsResult.results || []).map((token: any) => `
        <tr>
          <td style="font-size:.8rem;word-break:break-all"><strong>${escapeHtml(token.client_id)}</strong></td>
          <td>${escapeHtml(token.user_id || '')}</td>
          <td style="font-size:.8rem">${escapeHtml(token.scopes || '')}</td>
          <td style="color:#666;font-size:.875rem">${token.created_at ? new Date(token.created_at * 1000).toLocaleDateString() : ''}</td>
          <td class="actions">
            <button class="btn btn-danger" onclick="revokeToken('${escapeHtml(token.id)}')">Revoke</button>
          </td>
        </tr>
        `).join('')}
      </tbody>
    </table>
  </div>

  <script>
    async function createUser() {
      const username = document.getElementById('new-username').value.trim();
      const password = document.getElementById('new-password').value;
      if (!username || !password) { alert('Username and password are required'); return; }
      try {
        const res = await fetch('/admin/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        const data = await res.json();
        if (res.ok) { location.reload(); }
        else { alert('Error: ' + (data.error || 'Unknown error')); }
      } catch (e) { alert('Error: ' + e.message); }
    }

    async function updateQuota(event, username) {
      event.preventDefault();
      const quota = event.target.quota.value;
      try {
        const res = await fetch('/admin/users/' + username + '/quota', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quota_bytes: parseInt(quota) * 1048576 }),
        });
        if (res.ok) { location.reload(); }
        else { alert('Failed to update quota'); }
      } catch (e) { alert('Error: ' + e.message); }
    }

    async function deleteUser(username) {
      if (!confirm('Delete user "' + username + '"? This cannot be undone.')) return;
      try {
        const res = await fetch('/admin/users/' + username, { method: 'DELETE' });
        if (res.ok) { location.reload(); }
        else {
          const data = await res.json();
          alert('Error: ' + (data.error || 'Unknown error'));
        }
      } catch (e) { alert('Error: ' + e.message); }
    }

    async function revokeToken(id) {
      if (!confirm('Revoke this authorization?')) return;
      try {
        const res = await fetch('/admin/tokens/' + encodeURIComponent(id), { method: 'DELETE' });
        if (res.ok) { location.reload(); }
        else {
          const data = await res.json();
          alert('Error: ' + (data.error || 'Unknown error'));
        }
      } catch (e) { alert('Error: ' + e.message); }
    }
  </script>
</body>
</html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
});

// ── API ───────────────────────────────────────────────────────────────────────

adminRouter.route('/debug', debugRouter);

adminRouter.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

adminRouter.get('/stats', async (c) => {
  const db = (c.env as any).DB;
  if (!db || typeof db.prepare !== 'function') {
    return c.json({ error: 'Database not available' }, 503);
  }
  const userCount = await db.prepare('SELECT COUNT(*) as count FROM users').first() as { count: number } | null;
  const totalStorage = await db.prepare('SELECT SUM(used_storage_bytes) as total FROM users').first() as { total: number } | null;
  const tokenCount = await db.prepare('SELECT COUNT(*) as count FROM oauth_tokens').first() as { count: number } | null;
  return c.json({
    total_users: userCount?.count || 0,
    total_storage_bytes: totalStorage?.total || 0,
    active_tokens: tokenCount?.count || 0,
  });
});

adminRouter.get('/users', async (c) => {
  const db = (c.env as any).DB;
  if (!db || typeof db.prepare !== 'function') {
    return c.json({ error: 'Database not available' }, 503);
  }
  const result = await db.prepare('SELECT id, username, created_at, storage_quota_bytes, used_storage_bytes FROM users ORDER BY created_at DESC LIMIT 100').all();
  return c.json({ users: result.results || [], total: result.results?.length || 0 });
});

adminRouter.post('/users', async (c) => {
  const db = (c.env as any).DB;
  if (!db || typeof db.prepare !== 'function') {
    return c.json({ error: 'Database not available' }, 503);
  }

  const body = await c.req.json() as { username?: string; password?: string };

  if (!body.username || typeof body.username !== 'string') {
    return c.json({ error: 'username is required' }, 400);
  }
  if (!body.password || typeof body.password !== 'string') {
    return c.json({ error: 'password is required' }, 400);
  }

  const username = body.username.trim().toLowerCase();
  if (!/^[a-z0-9_.-]+$/.test(username)) {
    return c.json({ error: 'username may only contain letters, numbers, dots, hyphens and underscores' }, 400);
  }
  if (body.password.length < 8) {
    return c.json({ error: 'password must be at least 8 characters' }, 400);
  }

  const existing = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (existing) {
    return c.json({ error: 'username already exists' }, 409);
  }

  const passwordHash = await hashPassword(body.password);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await db.prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, username, passwordHash, now, now).run();

  return c.json({ id, username, created_at: now }, 201);
});

adminRouter.get('/users/:username', async (c) => {
  const username = c.req.param('username');
  const db = (c.env as any).DB;
  if (!db || typeof db.prepare !== 'function') {
    return c.json({ error: 'Database not available' }, 503);
  }
  const user = await db.prepare('SELECT id, username, created_at, updated_at, storage_quota_bytes, used_storage_bytes FROM users WHERE username = ?').bind(username).first();
  if (!user) return c.json({ error: 'User not found' }, 404);
  return c.json(user);
});

adminRouter.delete('/users/:username', async (c) => {
  const username = c.req.param('username');
  const db = (c.env as any).DB;
  if (!db || typeof db.prepare !== 'function') {
    return c.json({ error: 'Database not available' }, 503);
  }
  const existing = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (!existing) return c.json({ error: 'User not found' }, 404);

  const storage = getStorage(c);
  if (!storage || typeof storage.list !== 'function' || typeof storage.delete !== 'function') {
    return c.json({ error: 'Storage not available' }, 503);
  }

  const prefix = buildKey(username, '');
  let deletedObjects = 0;
  try {
    const listed = await storage.list(prefix);
    const objectKeys = listed.objects
      .map((object) => object.key)
      .filter((key) => key.startsWith(prefix) && !key.endsWith('/'));
    await Promise.all(objectKeys.map((key) => storage.delete(key)));
    deletedObjects = objectKeys.length;
  } catch {
    return c.json({ error: 'Storage cleanup failed; user was not deleted' }, 502);
  }

  const statements = [
    db.prepare('DELETE FROM oauth_tokens WHERE user_id = ?').bind(username),
    db.prepare('DELETE FROM oauth_codes WHERE user_id = ?').bind(username),
    db.prepare('DELETE FROM oauth_clients WHERE user_id = ?').bind(username),
    db.prepare('DELETE FROM users WHERE username = ?').bind(username),
  ];

  if (typeof db.deleteUserData === 'function') {
    await db.deleteUserData(username);
  } else if (typeof db.batch === 'function') {
    await db.batch(statements);
  } else {
    for (const statement of statements) await statement.run();
  }

  return c.json({ success: true, deleted_objects: deletedObjects });
});

adminRouter.delete('/tokens/:id', async (c) => {
  const id = c.req.param('id');
  const db = (c.env as any).DB;
  if (!db || typeof db.prepare !== 'function') {
    return c.json({ error: 'Database not available' }, 503);
  }
  await db.prepare('DELETE FROM oauth_tokens WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});

adminRouter.patch('/users/:username/quota', async (c) => {
  const username = c.req.param('username');
  const body = await c.req.json() as { quota_bytes?: number };
  const db = (c.env as any).DB;
  if (!db || typeof db.prepare !== 'function') {
    return c.json({ error: 'Database not available' }, 503);
  }
  if (typeof body.quota_bytes !== 'number') {
    return c.json({ error: 'quota_bytes must be a number' }, 400);
  }
  await db.prepare('UPDATE users SET storage_quota_bytes = ? WHERE username = ?').bind(body.quota_bytes, username).run();
  return c.json({ success: true, storage_quota_bytes: body.quota_bytes });
});

adminRouter.patch('/users/:username/password', async (c) => {
  const username = c.req.param('username');
  const body = await c.req.json() as { password?: string };
  const db = (c.env as any).DB;
  if (!db || typeof db.prepare !== 'function') {
    return c.json({ error: 'Database not available' }, 503);
  }
  if (!body.password || body.password.length < 8) {
    return c.json({ error: 'password must be at least 8 characters' }, 400);
  }
  const passwordHash = await hashPassword(body.password);
  await db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE username = ?')
    .bind(passwordHash, Math.floor(Date.now() / 1000), username).run();
  return c.json({ success: true });
});

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function escapeHtml(str: string): string {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
