import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { waitForServer } from './helpers';

const SERVER_URL = 'http://localhost:8790';
const DATA_DIR = join(process.cwd(), 'data', 'e2e-test-account');
const DB_PATH = join(DATA_DIR, 'test.db');
const STORAGE_DIR = join(DATA_DIR, 'storage');

// The offline server is dev mode without Cloudflare Access, so requests to
// localhost are signed in as the dev identity (the Owner).
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

  afterEach(async () => {
    await new Promise(r => setTimeout(r, 100));
  });

  it('GET /account shows the dashboard for the dev identity', async () => {
    const res = await fetch(`${SERVER_URL}/account`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('alice@localhost:8790');
    expect(html).toContain('alice@example.com');
    expect(html).toContain('/cdn-cgi/access/logout');
    expect(html).not.toContain('name="password"');
  });

  it('GET /admin redirects to /account', async () => {
    const res = await fetch(`${SERVER_URL}/admin`, { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/account');
  });

  it('uploads, browses, downloads and deletes a file', async () => {
    const form = new FormData();
    form.append('files', new File(['hello e2e'], 'note.txt', { type: 'text/plain' }));
    const upload = await fetch(`${SERVER_URL}/account/upload/documents`, {
      method: 'POST',
      headers: { 'Sec-Fetch-Site': 'same-origin' },
      body: form,
      redirect: 'manual',
    });
    expect(upload.status).toBe(302);

    const browse = await fetch(`${SERVER_URL}/account/browse/documents`);
    expect(browse.status).toBe(200);
    expect(await browse.text()).toContain('note.txt');

    const download = await fetch(`${SERVER_URL}/account/download/documents/note.txt`);
    expect(await download.text()).toBe('hello e2e');

    const remove = await fetch(`${SERVER_URL}/account/delete/documents/note.txt`, {
      method: 'POST',
      headers: { 'Sec-Fetch-Site': 'same-origin' },
      redirect: 'manual',
    });
    expect(remove.status).toBe(302);
    expect((await fetch(`${SERVER_URL}/account/download/documents/note.txt`)).status).toBe(404);
  });

  it('refuses a cross-site delete', async () => {
    const res = await fetch(`${SERVER_URL}/account/delete/documents/note.txt`, {
      method: 'POST',
      headers: { 'Sec-Fetch-Site': 'cross-site' },
      redirect: 'manual',
    });
    expect(res.status).toBe(403);
  });

  it('updates the quota from the dashboard', async () => {
    const res = await fetch(`${SERVER_URL}/account/quota`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: SERVER_URL },
      body: new URLSearchParams({ quota_gb: '2' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(await (await fetch(`${SERVER_URL}/account`)).text()).toContain('of 2.0 GB used');
  });

  it('/debug is available in dev mode on localhost', async () => {
    const res = await fetch(`${SERVER_URL}/debug/env`);
    expect(res.status).toBe(200);
  });
});
