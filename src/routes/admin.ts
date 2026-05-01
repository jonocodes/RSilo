import { Hono } from 'hono';
import { hashPassword } from '../services/auth';

export const adminRouter = new Hono();

adminRouter.use('*', async (c, next) => {
  const secret = (c.env as any)?.ADMIN_SECRET;
  if (!secret) {
    await next();
    return;
  }
  const auth = c.req.header('Authorization') || '';
  if (auth !== `Bearer ${secret}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
});

adminRouter.get('/', async (c) => {
  const db = (c.env as any).DB;
  const origin = c.req.header('Origin') || '*';

  const usersResult = await db?.prepare?.('SELECT id, username, created_at, storage_quota_bytes, used_storage_bytes FROM users ORDER BY created_at DESC LIMIT 100')?.all?.() || { results: [] };
  const userCountResult = await db?.prepare?.('SELECT COUNT(*) as count FROM users')?.first?.() || { count: 0 };
  const totalStorageResult = await db?.prepare?.('SELECT SUM(used_storage_bytes) as total FROM users')?.first?.() || { total: 0 };
  const tokenCountResult = await db?.prepare?.('SELECT COUNT(*) as count FROM oauth_tokens')?.first?.() || { count: 0 };

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RemoteStorage Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; line-height: 1.6; }
    .container { max-width: 1200px; margin: 0 auto; padding: 2rem; }
    h1 { margin-bottom: 1.5rem; color: #1a1a1a; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .stat-card { background: white; padding: 1.5rem; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .stat-card h3 { font-size: 0.875rem; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
    .stat-card .value { font-size: 2rem; font-weight: 600; color: #1a1a1a; margin-top: 0.5rem; }
    table { width: 100%; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th, td { padding: 1rem; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #fafafa; font-weight: 600; color: #666; }
    tr:last-child td { border-bottom: none; }
    .actions { display: flex; gap: 0.5rem; }
    .btn { padding: 0.5rem 1rem; border-radius: 4px; text-decoration: none; font-size: 0.875rem; cursor: pointer; border: none; }
    .btn-primary { background: #0066cc; color: white; }
    .btn-primary:hover { background: #0052a3; }
    .quota-form { display: flex; gap: 0.5rem; align-items: center; }
    .quota-input { padding: 0.5rem; border: 1px solid #ddd; border-radius: 4px; width: 120px; }
    .usage-bar { width: 100px; height: 8px; background: #eee; border-radius: 4px; overflow: hidden; display: inline-block; vertical-align: middle; margin-left: 0.5rem; }
    .usage-bar-fill { height: 100%; background: #0066cc; }
    .create-user-section { margin-bottom: 2rem; background: white; padding: 1.5rem; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .create-user-section h2 { margin-bottom: 1rem; }
    .create-form { display: flex; gap: 0.5rem; align-items: flex-end; flex-wrap: wrap; }
    .form-field { display: flex; flex-direction: column; gap: 0.25rem; }
    .form-field label { font-size: 0.875rem; font-weight: 500; }
    .form-field input { padding: 0.5rem; border: 1px solid #ddd; border-radius: 4px; font-size: 0.875rem; }
    .api-section { margin-top: 2rem; background: white; padding: 1.5rem; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .api-section h2 { margin-bottom: 1rem; }
    pre { background: #f5f5f5; padding: 1rem; border-radius: 4px; overflow-x: auto; font-size: 0.875rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>RemoteStorage Admin</h1>

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

    <div class="create-user-section">
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
        <button class="btn btn-primary" onclick="createUser()">Create</button>
      </div>
    </div>

    <h2 style="margin-bottom: 1rem;">Users</h2>
    <table>
      <thead>
        <tr>
          <th>Username</th>
          <th>Created</th>
          <th>Storage</th>
          <th>Quota</th>
          <th>Usage</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${(usersResult.results || []).map((user: any) => `
        <tr>
          <td>${escapeHtml(user.username)}</td>
          <td>${new Date(user.created_at * 1000).toLocaleDateString()}</td>
          <td>${formatBytes(user.used_storage_bytes || 0)}</td>
          <td>${formatBytes(user.storage_quota_bytes || 0)}</td>
          <td>
            ${Math.round(((user.used_storage_bytes || 0) / (user.storage_quota_bytes || 1)) * 100)}%
            <div class="usage-bar"><div class="usage-bar-fill" style="width: ${Math.min(100, ((user.used_storage_bytes || 0) / (user.storage_quota_bytes || 1)) * 100)}%"></div></div>
          </td>
          <td class="actions">
            <form class="quota-form" onsubmit="updateQuota(event, '${escapeHtml(user.username)}')">
              <input type="number" class="quota-input" name="quota" value="${user.storage_quota_bytes}" step="1073741824" min="1073741824">
              <button type="submit" class="btn btn-primary">Update Quota</button>
            </form>
          </td>
        </tr>
        `).join('')}
      </tbody>
    </table>

    <div class="api-section">
      <h2>API Endpoints</h2>
      <pre>GET  /admin/health                      - Health check
GET  /admin/stats                       - Statistics
GET  /admin/users                       - List users
POST /admin/users                       - Create user (body: {"username": "alice", "password": "secret"})
GET  /admin/users/:username             - User details
PATCH /admin/users/:username/quota      - Update quota (body: {"quota_bytes": 10737418240})
PATCH /admin/users/:username/password   - Change password (body: {"password": "newpass"})</pre>
      <p style="margin-top:0.75rem;font-size:0.875rem;color:#666">Set <code>ADMIN_SECRET</code> env var to require <code>Authorization: Bearer &lt;secret&gt;</code> on all admin routes.</p>
    </div>
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
          body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (res.ok) {
          location.reload();
        } else {
          alert('Error: ' + (data.error || 'Unknown error'));
        }
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    async function updateQuota(event, username) {
      event.preventDefault();
      const form = event.target;
      const quota = form.quota.value;
      try {
        const res = await fetch('/admin/users/' + username + '/quota', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quota_bytes: parseInt(quota) })
        });
        if (res.ok) {
          location.reload();
        } else {
          alert('Failed to update quota');
        }
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Access-Control-Allow-Origin': origin,
    }
  });
});

adminRouter.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
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

  await db.prepare(
    'INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, username, passwordHash, now, now).run();

  return c.json({ id, username, created_at: now }, 201);
});

adminRouter.get('/users', async (c) => {
  const db = (c.env as any).DB;
  if (!db || typeof db.prepare !== 'function') {
    return c.json({ error: 'Database not available' }, 503);
  }

  const result = await db.prepare('SELECT id, username, created_at, storage_quota_bytes, used_storage_bytes FROM users ORDER BY created_at DESC LIMIT 100').all();

  return c.json({
    users: result.results || [],
    total: result.results?.length || 0,
  });
});

adminRouter.get('/users/:username', async (c) => {
  const username = c.req.param('username');
  const db = (c.env as any).DB;

  if (!db || typeof db.prepare !== 'function') {
    return c.json({ error: 'Database not available' }, 503);
  }

  const user = await db.prepare('SELECT id, username, created_at, updated_at, storage_quota_bytes, used_storage_bytes FROM users WHERE username = ?').bind(username).first();

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  return c.json(user);
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
