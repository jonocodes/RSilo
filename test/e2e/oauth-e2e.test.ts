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

  // Consent lives at /account/oauth/authorize, behind the Owner gate; offline
  // requests to localhost are signed in as the dev identity (the Owner). The
  // app is http://localhost, so its redirect_uri is on the same origin (§10).
  const CONSENT = `${SERVER_URL}/account/oauth/authorize`;
  const CLIENT_ID = 'http://localhost';
  const REDIRECT_URI = 'http://localhost/callback';
  const SAME_ORIGIN = { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin' };

  it('GET /oauth/:user returns discovery document', async () => {
    const res = await fetch(`${SERVER_URL}/oauth/alice`);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.owner).toBe('alice');
    expect(json.auth).toBe(CONSENT);
    expect(json.token_endpoint).toBe(`${SERVER_URL}/oauth/alice/token`);
    expect(json.storageapi).toContain('/storage/alice');
  });

  it('WebFinger advertises the consent page under /account', async () => {
    const res = await fetch(`${SERVER_URL}/.well-known/webfinger?resource=acct:alice@localhost:8791`);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.links.find((l: any) => l.rel === 'remoteStorage').auth).toBe(CONSENT);
  });

  it('the consent page requires client_id and redirect_uri', async () => {
    const res = await fetch(CONSENT);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('invalid_request');
  });

  it('OAuth discover endpoint has correct CORS headers', async () => {
    const res = await fetch(`${SERVER_URL}/oauth/alice`, {
      method: 'OPTIONS',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
  });

  it('the legacy consent URL redirects with the query string unchanged', async () => {
    const query = 'client_id=http%3A%2F%2Flocalhost&redirect_uri=http%3A%2F%2Flocalhost%2Fcallback&response_type=code&scope=documents:rw+pictures%3Ar&state=a%3Db%26c%20d';
    const res = await fetch(`${SERVER_URL}/oauth/alice/authorize?${query}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`${CONSENT}?${query}`);

    const page = await fetch(res.headers.get('Location')!);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('name="state" value="a=b&amp;c d"');
  });

  it('the Owner approves a client (dev identity on localhost) and the code buys a working token', async () => {
    const page = await fetch(`${CONSENT}?${new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: 'documents:rw', state: 's1' })}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('action="/account/oauth/authorize"');

    const approve = await fetch(CONSENT, {
      method: 'POST',
      headers: SAME_ORIGIN,
      body: new URLSearchParams({
        action: 'approve',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: 'documents:rw',
        state: 's1',
      }),
      redirect: 'manual',
    });
    expect(approve.status).toBe(302);
    const location = new URL(approve.headers.get('Location')!);
    expect(location.searchParams.get('state')).toBe('s1');
    const code = location.searchParams.get('code');
    expect(code).toBeTruthy();

    const token = await fetch(`${SERVER_URL}/oauth/alice/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: code!, redirect_uri: REDIRECT_URI }),
    });
    expect(token.status).toBe(200);
    const { access_token } = await token.json() as any;

    const put = await fetch(`${SERVER_URL}/storage/alice/documents/e2e.txt`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'text/plain' },
      body: 'hello',
    });
    expect(put.status).toBeOneOf([200, 201]);
  });

  it('the Owner approves an implicit-flow client and the fragment token works', async () => {
    const approve = await fetch(CONSENT, {
      method: 'POST',
      headers: SAME_ORIGIN,
      body: new URLSearchParams({ action: 'approve', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'token', scope: 'documents:rw' }),
      redirect: 'manual',
    });
    expect(approve.status).toBe(302);
    const fragment = new URLSearchParams(new URL(approve.headers.get('Location')!).hash.slice(1));
    const accessToken = fragment.get('access_token');
    expect(accessToken).toBeTruthy();

    const put = await fetch(`${SERVER_URL}/storage/alice/documents/implicit.txt`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'text/plain' },
      body: 'hello',
    });
    expect(put.status).toBeOneOf([200, 201]);
  });

  it('refuses a cross-site approval', async () => {
    const res = await fetch(CONSENT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'cross-site' },
      body: new URLSearchParams({ action: 'approve', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('Location')).toBeNull();
  });

  it('refuses a redirect_uri on another origin than client_id, without redirecting', async () => {
    const res = await fetch(`${CONSENT}?${new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: 'https://evil.example/cb', response_type: 'code' })}`, { redirect: 'manual' });
    expect(res.status).toBe(400);
    expect(res.headers.get('Location')).toBeNull();
  });

  it('the consent page auto-accepts an unknown client', async () => {
    const res = await fetch(`${CONSENT}?client_id=http://some-new-app.example&redirect_uri=http://some-new-app.example/callback&response_type=code`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('some-new-app.example');
  });
});
