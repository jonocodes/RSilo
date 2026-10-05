import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { waitForServer } from './helpers';

const SERVER_URL = 'http://localhost:8791';
const DATA_DIR = join(process.cwd(), 'data', 'e2e-test-oauth');
const DB_PATH = join(DATA_DIR, 'test.db');
const STORAGE_DIR = join(DATA_DIR, 'storage');

describe('OAuth E2E', () => {
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
      PORT: '8791',
      SESSION_SECRET: 'test-session-secret',
      ADMIN_SECRET: 'admin',
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

  it('GET /oauth/:user returns discovery document', async () => {
    const res = await fetch(`${SERVER_URL}/oauth/alice`);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.owner).toBe('alice');
    expect(json.auth).toContain('/oauth/alice/authorize');
    expect(json.token_endpoint).toContain('/oauth/alice/token');
    expect(json.storageapi).toContain('/storage/alice');
  });

  it('GET /oauth/:user/authorize requires client_id and redirect_uri', async () => {
    const res = await fetch(`${SERVER_URL}/oauth/alice/authorize`);
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.error).toBe('invalid_request');
  });

  it('OAuth discover endpoint has correct CORS headers', async () => {
    const res = await fetch(`${SERVER_URL}/oauth/alice`, {
      method: 'OPTIONS',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
  });

  it('GET /oauth/:user/authorize auto-accepts an unknown client', async () => {
    const res = await fetch(`${SERVER_URL}/oauth/alice/authorize?client_id=some-new-app&redirect_uri=http://localhost/callback&response_type=code`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});