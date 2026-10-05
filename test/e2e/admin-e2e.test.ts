import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { waitForServer } from './helpers';

const SERVER_URL = 'http://localhost:8789';
const DATA_DIR = join(process.cwd(), 'data', 'e2e-test-admin');
const DB_PATH = join(DATA_DIR, 'test.db');
const STORAGE_DIR = join(DATA_DIR, 'storage');
const ADMIN_SECRET = 'test-admin-secret-123';

describe('Admin E2E', () => {
  let server: ReturnType<typeof spawn>;

  beforeAll(async () => {
    if (existsSync(DATA_DIR)) {
      rmSync(DATA_DIR, { recursive: true, force: true });
    }
    mkdirSync(STORAGE_DIR, { recursive: true });

    const env = {
      ...process.env,
      STORAGE_DIR,
      DB_PATH,
      PORT: '8789',
      ADMIN_SECRET,
    };

    server = spawn('bun', ['run', 'src/server-offline.ts'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await waitForServer(SERVER_URL);
  });

  afterAll(async () => {
    server.kill('SIGINT');
    await new Promise(r => setTimeout(r, 500));
    if (existsSync(DATA_DIR)) {
      rmSync(DATA_DIR, { recursive: true, force: true });
    }
  });

  it('GET /admin/login shows login form', async () => {
    const res = await fetch(`${SERVER_URL}/admin/login`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('RSilo Admin');
    expect(html).toContain('Admin secret');
    expect(html).toContain('name="secret"');
  });

  it('POST /admin/login with correct secret redirects and sets cookie', async () => {
    const res = await fetch(`${SERVER_URL}/admin/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ secret: ADMIN_SECRET }),
      redirect: 'manual',
    });

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin');
    const cookie = res.headers.get('Set-Cookie') || '';
    expect(cookie).toContain('admin_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain(`Max-Age=${28800}`);
  });

  it('POST /admin/login with wrong secret returns 401', async () => {
    const res = await fetch(`${SERVER_URL}/admin/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ secret: 'wrong-secret' }),
    });

    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain('Invalid admin secret');
  });

  it('dashboard accessible with session cookie', async () => {
    const loginRes = await fetch(`${SERVER_URL}/admin/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ secret: ADMIN_SECRET }),
      redirect: 'manual',
    });

    const cookie = loginRes.headers.get('Set-Cookie') || '';
    const sessionToken = cookie.match(/admin_session=([^;]+)/)?.[1];
    expect(sessionToken).toBeDefined();

    const dashRes = await fetch(`${SERVER_URL}/admin/`, {
      headers: { Cookie: `admin_session=${sessionToken}` },
    });

    expect(dashRes.status).toBe(200);
    const html = await dashRes.text();
    expect(html).toContain('RSilo Admin');
    expect(html).toContain('Total Users');
  });

  it('health endpoint accessible with Bearer token', async () => {
    const res = await fetch(`${SERVER_URL}/admin/health`, {
      headers: { Authorization: `Bearer ${ADMIN_SECRET}` },
    });

    expect(res.status).toBe(200);
    const json = await res.json() as { status: string };
    expect(json.status).toBe('ok');
  });

  it('admin endpoints return 401 without auth', async () => {
    const res = await fetch(`${SERVER_URL}/admin/health`);
    expect(res.status).toBe(401);
  });

  it('logout clears cookie and redirects', async () => {
    const loginRes = await fetch(`${SERVER_URL}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: ADMIN_SECRET }),
      redirect: 'manual',
    });

    const cookie = loginRes.headers.get('Set-Cookie') || '';
    const sessionToken = cookie.match(/admin_session=([^;]+)/)?.[1];

    const logoutRes = await fetch(`${SERVER_URL}/admin/logout`, {
      method: 'POST',
      headers: { Cookie: `admin_session=${sessionToken}` },
      redirect: 'manual',
    });

    expect(logoutRes.status).toBe(302);
    expect(logoutRes.headers.get('Location')).toBe('/admin/login');
    const logoutCookie = logoutRes.headers.get('Set-Cookie') || '';
    expect(logoutCookie).toContain('Max-Age=0');
  });

  it('debug oauth endpoint reads the OAuth tables', async () => {
    const res = await fetch(`${SERVER_URL}/admin/debug/oauth`, {
      headers: { Authorization: `Bearer ${ADMIN_SECRET}` },
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { summary: unknown };
    expect(json.summary).toBeDefined();
  });
});