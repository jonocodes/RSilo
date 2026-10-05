import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { existsSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { waitForServer } from './helpers';

const SERVER_URL = 'http://localhost:8788';
const DATA_DIR = join(process.cwd(), 'data', 'e2e-test-storage');
const DB_PATH = join(DATA_DIR, 'test.db');
const STORAGE_DIR = join(DATA_DIR, 'storage');

function createTestToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: 'alice',
    scopes: 'documents:rw pictures:rw public:rw',
    iat: Math.floor(Date.now() / 1000),
    exp: 9999999999,
  })).toString('base64url');
  return `${header}.${payload}.`;
}

describe('Storage E2E', () => {
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
      PORT: '8788',
    };

    server = spawn('bun', ['run', 'src/server-offline.ts'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await waitForServer(SERVER_URL);

    const createUserResponse = await fetch(`${SERVER_URL}/admin/users`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: 'alice', password: 'password123' }),
    });
    if (createUserResponse.status !== 201) {
      throw new Error(`Failed to create E2E user: ${createUserResponse.status} ${await createUserResponse.text()}`);
    }
  });

  afterAll(async () => {
    server.kill('SIGINT');
    await new Promise(r => setTimeout(r, 500));
    if (existsSync(DATA_DIR)) {
      rmSync(DATA_DIR, { recursive: true, force: true });
    }
  });

  it('PUT a file and GET it back', async () => {
    const token = createTestToken();
    const content = 'hello e2e test';

    const putRes = await fetch(`${SERVER_URL}/storage/alice/documents/test.txt`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'text/plain',
      },
      body: content,
    });

    expect(putRes.status).toBeOneOf([200, 201]);

    const filePath = join(STORAGE_DIR, 'users', 'alice', 'storage', 'documents', 'test.txt');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toBe(content);

    const getRes = await fetch(`${SERVER_URL}/storage/alice/documents/test.txt`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    });

    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe(content);
  });

  it('PUT then DELETE removes file', async () => {
    const token = createTestToken();
    const content = 'to be deleted';

    await fetch(`${SERVER_URL}/storage/alice/documents/delete-me.txt`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: content,
    });

    const filePath = join(STORAGE_DIR, 'users', 'alice', 'storage', 'documents', 'delete-me.txt');
    expect(existsSync(filePath)).toBe(true);

    const delRes = await fetch(`${SERVER_URL}/storage/alice/documents/delete-me.txt`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });

    expect(delRes.status).toBe(200);
    expect(existsSync(filePath)).toBe(false);
  });

  it('PUT file to public folder without auth', async () => {
    const token = createTestToken();

    await fetch(`${SERVER_URL}/storage/alice/public/documents/public-file.txt`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: 'public content',
    });

    const getRes = await fetch(`${SERVER_URL}/storage/alice/public/documents/public-file.txt`);
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe('public content');
  });

  it('folder listing returns items', async () => {
    const token = createTestToken();

    await fetch(`${SERVER_URL}/storage/alice/documents/folder-test/file1.txt`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: 'content1',
    });

    await fetch(`${SERVER_URL}/storage/alice/documents/folder-test/file2.txt`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: 'content2',
    });

    const listRes = await fetch(`${SERVER_URL}/storage/alice/documents/folder-test/`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    });

    expect(listRes.status).toBe(200);
    const json: any = await listRes.json();
    expect(json.items).toBeDefined();
    expect(json.items['file1.txt']).toBeDefined();
    expect(json.items['file2.txt']).toBeDefined();
  });

  it('GET non-existent file returns 404', async () => {
    const token = createTestToken();

    const res = await fetch(`${SERVER_URL}/storage/alice/documents/does-not-exist.txt`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    });

    expect(res.status).toBe(404);
  });

  it('PUT without auth returns 401', async () => {
    const res = await fetch(`${SERVER_URL}/storage/alice/documents/no-auth.txt`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: 'test',
    });

    expect(res.status).toBe(401);
  });

  it('server info endpoint works', async () => {
    const res = await fetch(`${SERVER_URL}/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('RemoteStorage');
  });

  it('health endpoint works', async () => {
    const res = await fetch(`${SERVER_URL}/health`);
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.status).toBe('ok');
    expect(json.mode).toBe('offline');
  });
});