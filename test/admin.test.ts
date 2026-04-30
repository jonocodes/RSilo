import { describe, it, expect, beforeAll } from 'vitest';
import { createServer } from '../src/index';

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
    expect(html).toContain('RemoteStorage Admin');
    expect(html).toContain('Total Users');
    expect(html).toContain('Total Storage');
  });
});