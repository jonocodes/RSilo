import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const SERVER_URL = 'http://localhost:8790';
const DATA_DIR = join(process.cwd(), 'data', 'e2e-test-account');
const DB_PATH = join(DATA_DIR, 'test.db');
const STORAGE_DIR = join(DATA_DIR, 'storage');

describe('Account E2E', () => {
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
      PORT: '8790',
      SESSION_SECRET: 'test-session-secret',
      ADMIN_SECRET: 'admin',
    };

    server = spawn('bun', ['run', 'src/server-offline.ts'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await new Promise<void>((resolve) => {
      server.stdout?.on('data', (data: Buffer) => {
        if (data.toString().includes('Listening')) {
          resolve();
        }
      });
      setTimeout(resolve, 2000);
    });
  });

  afterAll(async () => {
    server.kill('SIGINT');
    await new Promise(r => setTimeout(r, 500));
    if (existsSync(DATA_DIR)) {
      rmSync(DATA_DIR, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    await new Promise(r => setTimeout(r, 100));
  });

  async function createUser(username: string, password: string) {
    const res = await fetch(`${SERVER_URL}/admin/users`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer admin',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username, password }),
    });
    return res.json();
  }

  async function login(username: string, password: string) {
    const res = await fetch(`${SERVER_URL}/account/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ username, password }),
      redirect: 'manual',
    });
    return res;
  }

  it('GET /account/ shows login page', async () => {
    const res = await fetch(`${SERVER_URL}/account/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('RSilo Files');
    expect(html).toContain('name="username"');
    expect(html).toContain('name="password"');
  });

  it('GET /account/browse redirects to login when not authenticated', async () => {
    const res = await fetch(`${SERVER_URL}/account/browse`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/account/');
  });

  it('login with wrong password redirects to error', async () => {
    const user = await createUser('testuser1', 'password123');

    const res = await fetch(`${SERVER_URL}/account/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ username: 'testuser1', password: 'wrongpassword' }),
      redirect: 'manual',
    });

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/account/?error=1');
  });

  it('login with correct password sets cookie and redirects to browse', async () => {
    const user = await createUser('testuser2', 'password123');

    const res = await fetch(`${SERVER_URL}/account/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ username: 'testuser2', password: 'password123' }),
      redirect: 'manual',
    });

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/account/browse');
    const cookie = res.headers.get('Set-Cookie') || '';
    expect(cookie).toContain('rsilo_session=');
    expect(cookie).toContain('HttpOnly');
  });

  it('browse page shows files after login', async () => {
    await createUser('browseuser', 'password123');

    const loginRes = await login('browseuser', 'password123');
    const cookie = loginRes.headers.get('Set-Cookie') || '';
    const sessionToken = cookie.match(/rsilo_session=([^;]+)/)?.[1];
    expect(sessionToken).toBeDefined();

    const res = await fetch(`${SERVER_URL}/account/browse`, {
      headers: { Cookie: `rsilo_session=${sessionToken}` },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('RSilo Files');
    expect(html).toContain('/account/browse');
  });

  it('logout clears cookie and redirects', async () => {
    await createUser('logoutuser', 'password123');

    const loginRes = await login('logoutuser', 'password123');
    const cookie = loginRes.headers.get('Set-Cookie') || '';
    const sessionToken = cookie.match(/rsilo_session=([^;]+)/)?.[1];

    const logoutRes = await fetch(`${SERVER_URL}/account/logout`, {
      method: 'POST',
      headers: { Cookie: `rsilo_session=${sessionToken}` },
      redirect: 'manual',
    });

    expect(logoutRes.status).toBe(302);
    expect(logoutRes.headers.get('Location')).toBe('/account/');
    const logoutCookie = logoutRes.headers.get('Set-Cookie') || '';
    expect(logoutCookie).toContain('Max-Age=0');
  });

  it('tokens page shows after login', async () => {
    await createUser('tokensuser', 'password123');

    const loginRes = await login('tokensuser', 'password123');
    const cookie = loginRes.headers.get('Set-Cookie') || '';
    const sessionToken = cookie.match(/rsilo_session=([^;]+)/)?.[1];

    const res = await fetch(`${SERVER_URL}/account/tokens`, {
      headers: { Cookie: `rsilo_session=${sessionToken}` },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('OAuth Tokens');
  });
});