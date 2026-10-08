import { describe, it, expect } from 'vitest';
import { createServer } from '../src/index';
import { createSqliteD1, usernames } from './helpers/sqlite-d1';

// The Instance serves exactly one Account (ADR-0002). Its `users` row is
// created lazily on first use; if the table already holds other rows the Worker
// refuses to create a second one and reports a username mismatch instead.

function createEnv(extra: Record<string, string> = {}) {
  return {
    STORAGE: {
      async get() { return null; },
      async put() { return '"etag"'; },
      async delete() {},
      async head() { return null; },
      async list() { return { objects: [] }; },
    } as any,
    DB: createSqliteD1(),
    ...extra,
  };
}

const app = createServer({});
const PUBLIC_MISSING = 'http://localhost/storage/alice/public/documents/missing.txt';
const CONSENT = 'http://localhost/oauth/alice/authorize?client_id=https%3A%2F%2Fapp.example&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&response_type=token&scope=documents%3Arw';

function userQueries(env: ReturnType<typeof createEnv>): number {
  return env.DB.queries.filter(sql => /\busers\b/.test(sql)).length;
}

describe('Account row lifecycle', () => {
  it('creates the Account row on the first storage request to an empty table', async () => {
    const env = createEnv();
    expect(usernames(env.DB)).toEqual([]);

    const res = await app.request(PUBLIC_MISSING, {}, env);

    expect(res.status).toBe(404);
    expect(usernames(env.DB)).toEqual(['alice']);
  });

  it('creates the row for the configured ACCOUNT_USERNAME', async () => {
    const env = createEnv({ ACCOUNT_USERNAME: 'carol' });

    await app.request('http://localhost/storage/carol/public/documents/x.txt', {}, env);

    expect(usernames(env.DB)).toEqual(['carol']);
  });

  it('is a no-op when repeated, and does not query users again in the same isolate', async () => {
    const env = createEnv();
    await app.request(PUBLIC_MISSING, {}, env);
    const queriesAfterFirst = userQueries(env);

    const res = await app.request(PUBLIC_MISSING, {}, env);

    expect(res.status).toBe(404);
    expect(usernames(env.DB)).toEqual(['alice']);
    expect(userQueries(env)).toBe(queriesAfterFirst);
  });

  it('leaves an existing Account row untouched', async () => {
    const env = createEnv();
    env.DB.sqlite.exec("INSERT INTO users (id, username, storage_quota_bytes) VALUES ('id-1', 'alice', 42)");

    await app.request(PUBLIC_MISSING, {}, env);

    const row = env.DB.sqlite.prepare("SELECT id, storage_quota_bytes FROM users WHERE username = 'alice'").get() as any;
    expect(row).toEqual({ id: 'id-1', storage_quota_bytes: 42 });
  });

  it('creates the Account row before the consent page so approvals can reference it', async () => {
    const env = createEnv();

    const res = await app.request(CONSENT, {}, env);

    expect(res.status).toBe(200);
    expect(usernames(env.DB)).toEqual(['alice']);
  });
});

describe('Username mismatch', () => {
  function mismatchedEnv() {
    const env = createEnv();
    env.DB.sqlite.exec("INSERT INTO users (id, username) VALUES ('id-bob', 'bob')");
    env.DB.sqlite.exec("INSERT INTO oauth_clients (id, name, redirect_uris, user_id) VALUES ('c1', 'c1', '[]', 'bob')");
    env.DB.sqlite.exec("INSERT INTO oauth_tokens (id, access_token, expires_at, scopes, user_id, client_id) VALUES ('t1', 'bob-token', 9999999999, 'documents:rw', 'bob', 'c1')");
    return env;
  }

  it('does not create a second row', async () => {
    const env = mismatchedEnv();

    await app.request(PUBLIC_MISSING, {}, env);
    await app.request(CONSENT, {}, env);
    await app.request('http://localhost/account', {}, env);

    expect(usernames(env.DB)).toEqual(['bob']);
  });

  it('storage returns 503 with a message naming ACCOUNT_USERNAME', async () => {
    const env = mismatchedEnv();

    const res = await app.request(PUBLIC_MISSING, {}, env);

    expect(res.status).toBe(503);
    expect(await res.text()).toContain('ACCOUNT_USERNAME');
  });

  it('storage returns 503 even for a valid token of another user row', async () => {
    const env = mismatchedEnv();

    const res = await app.request('http://localhost/storage/alice/documents/a.txt', {
      headers: { Authorization: 'Bearer bob-token' },
    }, env);

    expect(res.status).toBe(503);
  });

  it('the /account surface shows a username-mismatch setup message', async () => {
    const env = mismatchedEnv();

    const res = await app.request('http://localhost/account', {}, env);

    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text.toLowerCase()).toContain('username mismatch');
    expect(text).toContain('ACCOUNT_USERNAME');
  });

  it('the consent page shows the username-mismatch setup message', async () => {
    const env = mismatchedEnv();

    const res = await app.request(CONSENT, {}, env);

    expect(res.status).toBe(503);
    expect((await res.text()).toLowerCase()).toContain('username mismatch');
  });

  it('recovers once the configured username matches an existing row', async () => {
    const env = { ...mismatchedEnv(), ACCOUNT_USERNAME: 'bob' };

    const res = await app.request('http://localhost/storage/bob/documents/a.txt', {
      headers: { Authorization: 'Bearer bob-token' },
    }, env);

    expect(res.status).toBe(404);
    expect(usernames(env.DB)).toEqual(['bob']);
  });
});
