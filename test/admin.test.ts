import { describe, it, expect, beforeAll } from 'vitest';
import { createServer } from '../src/index';
import { signSessionToken } from '../src/services/auth';

const mockDb = {
  prepare: (query: string) => {
    const boundObj = {
      bind: () => boundObj,
      first: async () => {
        if (query.includes('SELECT * FROM users WHERE username')) {
          return { id: '1', username: 'alice', created_at: Date.now(), storage_quota_bytes: 10737418240, used_storage_bytes: 0 };
        }
        if (query.includes('SELECT id, username') && query.includes('WHERE username')) {
          return { id: '1', username: 'alice', created_at: Date.now(), storage_quota_bytes: 10737418240, used_storage_bytes: 0 };
        }
        if (query.includes('SELECT id, username')) {
          return [
            { id: '1', username: 'alice', created_at: Date.now(), storage_quota_bytes: 10737418240, used_storage_bytes: 0 },
            { id: '2', username: 'bob', created_at: Date.now(), storage_quota_bytes: 10737418240, used_storage_bytes: 0 },
          ];
        }
        if (query.includes('COUNT')) return { count: 42 };
        if (query.includes('SUM')) return { total: 1073741824 };
        return null;
      },
      all: async () => ({
        results: [
          { id: '1', username: 'alice', created_at: Date.now(), storage_quota_bytes: 10737418240, used_storage_bytes: 0 },
          { id: '2', username: 'bob', created_at: Date.now(), storage_quota_bytes: 10737418240, used_storage_bytes: 0 },
        ]
      }),
      run: async () => ({}),
    };
    return {
      bind: () => boundObj,
      first: boundObj.first,
      all: boundObj.all,
      run: boundObj.run,
    };
  },
};

const TEST_ENV = {
  STORAGE: {} as any,
  DB: mockDb as any,
};

describe('Admin endpoints', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer(TEST_ENV);
  });

  it('GET /admin/health returns status', async () => {
    const res = await app.request(
      'http://localhost/admin/health',
      { method: 'GET' },
      TEST_ENV
    );

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.status).toBe('ok');
    expect(json.version).toBe('1.0.0');
  });

  it('GET /admin/stats returns statistics', async () => {
    const res = await app.request(
      'http://localhost/admin/stats',
      { method: 'GET' },
      TEST_ENV
    );

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json).toHaveProperty('total_users');
    expect(json).toHaveProperty('total_storage_bytes');
    expect(json).toHaveProperty('active_tokens');
  });

  it('GET /admin/users returns user list', async () => {
    const res = await app.request(
      'http://localhost/admin/users',
      { method: 'GET' },
      TEST_ENV
    );

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json).toHaveProperty('users');
    expect(json).toHaveProperty('total');
  });

  it('GET /admin/users/:username returns user details', async () => {
    const res = await app.request(
      'http://localhost/admin/users/alice',
      { method: 'GET' },
      TEST_ENV
    );

    expect(res.status).toBe(200);
  });

  it('GET /admin/users/:username returns 404 for unknown user', async () => {
    const nonexistentDb = {
      prepare: (query: string) => {
        let boundValues: string[] = [];
        const stmt = {
          bind: (...values: string[]) => {
            boundValues = values;
            return stmt;
          },
          first: async () => {
            if (boundValues[0] === 'nonexistent') return null;
            return { id: '1', username: boundValues[0] || 'unknown' };
          },
          all: async () => ({ results: [] }),
          run: async () => ({}),
        };
        return stmt;
      },
    };

    const noUserEnv = { STORAGE: {} as any, DB: nonexistentDb as any };
    const noUserApp = createServer(noUserEnv);

    const res = await noUserApp.request(
      'http://localhost/admin/users/nonexistent',
      { method: 'GET' },
      noUserEnv
    );

    expect(res.status).toBe(404);
  });

  it('PATCH /admin/users/:username/quota updates quota', async () => {
    const res = await app.request(
      'http://localhost/admin/users/alice/quota',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quota_bytes: 10737418240 }),
      },
      TEST_ENV
    );

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.success).toBe(true);
    expect(json.storage_quota_bytes).toBe(10737418240);
  });

  it('PATCH /admin/users/:username/quota returns 400 for invalid input', async () => {
    const res = await app.request(
      'http://localhost/admin/users/alice/quota',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quota_bytes: 'not-a-number' }),
      },
      TEST_ENV
    );

    expect(res.status).toBe(400);
  });

  it('admin endpoint returns 503 when DB not available', async () => {
    const noDbEnv = { STORAGE: {} as any, DB: null };
    const noDbApp = createServer(noDbEnv);

    const res = await noDbApp.request(
      'http://localhost/admin/users',
      { method: 'GET' },
      noDbEnv
    );

    expect(res.status).toBe(503);
    const json = await res.json() as any;
    expect(json.error).toBe('Database not available');
  });

  it('GET /admin/ returns HTML dashboard', async () => {
    const res = await app.request(
      'http://localhost/admin',
      { method: 'GET' },
      TEST_ENV
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('RSilo Admin');
    expect(html).toContain('Total Users');
    expect(html).toContain('Total Storage');
  });
});

describe('POST /admin/users', () => {
  let app: ReturnType<typeof createServer>;

  function makeDb(existingUser: any = null) {
    return {
      prepare: (sql: string) => ({
        bind: (..._args: any[]) => ({
          first: async () => (sql.includes('SELECT id FROM users') ? existingUser : null),
          run: async () => ({}),
        }),
        first: async () => null,
        run: async () => ({}),
        all: async () => ({ results: [] }),
      }),
    } as any;
  }

  beforeAll(() => {
    app = createServer({ STORAGE: {} as any, DB: makeDb() });
  });

  it('creates user and returns 201', async () => {
    const env = { STORAGE: {} as any, DB: makeDb(null) };
    const res = await app.request(
      'http://localhost/admin/users',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'newuser', password: 'securepassword' }),
      },
      env
    );
    expect(res.status).toBe(201);
    const json = await res.json() as any;
    expect(json.username).toBe('newuser');
    expect(json.id).toBeDefined();
    expect(json.password_hash).toBeUndefined();
  });

  it('returns 409 when username already exists', async () => {
    const env = { STORAGE: {} as any, DB: makeDb({ id: 'existing-id' }) };
    const res = await app.request(
      'http://localhost/admin/users',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: 'securepassword' }),
      },
      env
    );
    expect(res.status).toBe(409);
    const json = await res.json() as any;
    expect(json.error).toContain('already exists');
  });

  it('returns 400 when username is missing', async () => {
    const res = await app.request(
      'http://localhost/admin/users',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'securepassword' }),
      },
      { STORAGE: {} as any, DB: makeDb() }
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when password is missing', async () => {
    const res = await app.request(
      'http://localhost/admin/users',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice' }),
      },
      { STORAGE: {} as any, DB: makeDb() }
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when password is too short', async () => {
    const res = await app.request(
      'http://localhost/admin/users',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: 'short' }),
      },
      { STORAGE: {} as any, DB: makeDb() }
    );
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.error).toContain('8 characters');
  });

  it('returns 400 for invalid username characters', async () => {
    const res = await app.request(
      'http://localhost/admin/users',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice smith', password: 'securepassword' }),
      },
      { STORAGE: {} as any, DB: makeDb() }
    );
    expect(res.status).toBe(400);
  });
});

describe('PATCH /admin/users/:username/password', () => {
  let app: ReturnType<typeof createServer>;
  const db = {
    prepare: () => ({
      bind: (..._args: any[]) => ({ run: async () => ({}) }),
      run: async () => ({}),
    }),
  } as any;

  beforeAll(() => {
    app = createServer({ STORAGE: {} as any, DB: db });
  });

  it('updates password and returns 200', async () => {
    const res = await app.request(
      'http://localhost/admin/users/alice/password',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'newpassword123' }),
      },
      { STORAGE: {} as any, DB: db }
    );
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.success).toBe(true);
  });

  it('returns 400 when password is too short', async () => {
    const res = await app.request(
      'http://localhost/admin/users/alice/password',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'short' }),
      },
      { STORAGE: {} as any, DB: db }
    );
    expect(res.status).toBe(400);
  });
});

describe('Admin auth middleware', () => {
  let app: ReturnType<typeof createServer>;
  const db = {
    prepare: () => ({
      bind: (..._args: any[]) => ({ first: async () => null, run: async () => ({}), all: async () => ({ results: [] }) }),
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({}),
    }),
  } as any;

  beforeAll(() => {
    app = createServer({ STORAGE: {} as any, DB: db });
  });

  it('returns 401 when ADMIN_SECRET is set and no auth header', async () => {
    const env = { STORAGE: {} as any, DB: db, ADMIN_SECRET: 'mysecret' };
    const res = await app.request(
      'http://localhost/admin/health',
      { method: 'GET' },
      env
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when ADMIN_SECRET is set and wrong token provided', async () => {
    const env = { STORAGE: {} as any, DB: db, ADMIN_SECRET: 'mysecret' };
    const res = await app.request(
      'http://localhost/admin/health',
      { method: 'GET', headers: { Authorization: 'Bearer wrongtoken' } },
      env
    );
    expect(res.status).toBe(401);
  });

  it('allows access with correct ADMIN_SECRET', async () => {
    const env = { STORAGE: {} as any, DB: db, ADMIN_SECRET: 'mysecret' };
    const res = await app.request(
      'http://localhost/admin/health',
      { method: 'GET', headers: { Authorization: 'Bearer mysecret' } },
      env
    );
    expect(res.status).toBe(200);
  });

  it('allows access without auth header when ADMIN_SECRET is not set', async () => {
    const env = { STORAGE: {} as any, DB: db };
    const res = await app.request(
      'http://localhost/admin/health',
      { method: 'GET' },
      env
    );
    expect(res.status).toBe(200);
  });

  it('allows access with valid session cookie', async () => {
    const secret = 'mysecret';
    const token = await signSessionToken('admin', secret, 3600);
    const env = { STORAGE: {} as any, DB: db, ADMIN_SECRET: secret };
    const res = await app.request(
      'http://localhost/admin/health',
      { method: 'GET', headers: { Cookie: `admin_session=${token}` } },
      env
    );
    expect(res.status).toBe(200);
  });

  it('redirects browser to /admin/login when ADMIN_SECRET is set and no auth', async () => {
    const env = { STORAGE: {} as any, DB: db, ADMIN_SECRET: 'mysecret' };
    const res = await app.request(
      'http://localhost/admin',
      { method: 'GET', headers: { Accept: 'text/html' } },
      env
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin/login');
  });
});

describe('Admin login', () => {
  let app: ReturnType<typeof createServer>;
  const db = {
    prepare: () => ({
      bind: (..._args: any[]) => ({ first: async () => null, run: async () => ({}), all: async () => ({ results: [] }) }),
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({}),
    }),
  } as any;

  beforeAll(() => {
    app = createServer({ STORAGE: {} as any, DB: db });
  });

  it('GET /admin/login renders login form when ADMIN_SECRET is set', async () => {
    const env = { STORAGE: {} as any, DB: db, ADMIN_SECRET: 'mysecret' };
    const res = await app.request('http://localhost/admin/login', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('RSilo Admin');
    expect(html).toContain('Admin secret');
  });

  it('GET /admin/login redirects to dashboard when ADMIN_SECRET is not set', async () => {
    const env = { STORAGE: {} as any, DB: db };
    const res = await app.request('http://localhost/admin/login', { method: 'GET' }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin');
  });

  it('POST /admin/login with correct secret sets cookie and redirects', async () => {
    const env = { STORAGE: {} as any, DB: db, ADMIN_SECRET: 'mysecret' };
    const body = new URLSearchParams({ secret: 'mysecret' });
    const res = await app.request('http://localhost/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin');
    const cookie = res.headers.get('Set-Cookie') || '';
    expect(cookie).toContain('admin_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('POST /admin/login with wrong secret returns 401', async () => {
    const env = { STORAGE: {} as any, DB: db, ADMIN_SECRET: 'mysecret' };
    const body = new URLSearchParams({ secret: 'wrongsecret' });
    const res = await app.request('http://localhost/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, env);
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain('Invalid admin secret');
  });

  it('POST /admin/logout clears cookie and redirects', async () => {
    const env = { STORAGE: {} as any, DB: db, ADMIN_SECRET: 'mysecret' };
    const res = await app.request('http://localhost/admin/logout', { method: 'POST' }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin/login');
    const cookie = res.headers.get('Set-Cookie') || '';
    expect(cookie).toContain('Max-Age=0');
  });
});

describe('DELETE /admin/users/:username', () => {
  let app: ReturnType<typeof createServer>;

  function makeDb(existingUser: any = { id: 'user-1' }) {
    return {
      prepare: (sql: string) => ({
        bind: (..._args: any[]) => ({
          first: async () => sql.includes('SELECT id FROM users') ? existingUser : null,
          run: async () => ({}),
          all: async () => ({ results: [] }),
        }),
        first: async () => null,
        run: async () => ({}),
        all: async () => ({ results: [] }),
      }),
    } as any;
  }

  beforeAll(() => {
    app = createServer({ STORAGE: {} as any, DB: makeDb() });
  });

  it('DELETE /admin/users/:username returns 200', async () => {
    const env = { STORAGE: {} as any, DB: makeDb() };
    const res = await app.request('http://localhost/admin/users/alice', { method: 'DELETE' }, env);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.success).toBe(true);
  });

  it('DELETE /admin/users/:username returns 404 for unknown user', async () => {
    const env = { STORAGE: {} as any, DB: makeDb(null) };
    const res = await app.request('http://localhost/admin/users/nobody', { method: 'DELETE' }, env);
    expect(res.status).toBe(404);
  });

  it('DELETE /admin/users/:username returns 503 when DB unavailable', async () => {
    const env = { STORAGE: {} as any, DB: null };
    const res = await app.request('http://localhost/admin/users/alice', { method: 'DELETE' }, env);
    expect(res.status).toBe(503);
  });
});