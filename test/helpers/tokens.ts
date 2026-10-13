// Seeds opaque bearer tokens for tests. Storage auth only accepts rows in
// `oauth_tokens` (ADR-0003), so fixtures insert real rows into the SQLite D1
// shim the test env already provides, with foreign keys enforced: the Account
// row, the token subject's row and a shared "test-client" OAuth client are
// created as needed. Rows are keyed by the token's hash, as the real table
// stores them.

import { createHash } from 'node:crypto';
import { DEV_ACCOUNT_USERNAME, isLocalDevelopment } from '../../src/config';
import type { SqliteD1 } from '../../src/services/db/sqlite';

// What oauth_tokens/oauth_codes store for a secret (services/auth hashToken),
// computed synchronously for SQL fixtures.
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

// RFC 7636 Appendix B: a code_verifier and its S256 code_challenge.
export const PKCE = {
  verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
};

interface SeedOptions {
  expiresAt?: number;
}

interface SeedEnv {
  DB?: SqliteD1;
  ACCOUNT_USERNAME?: string;
  [key: string]: unknown;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function shim(env: SeedEnv): SqliteD1 {
  const db = env.DB;
  if (!db || typeof db.prepare !== 'function' || !db.sqlite) {
    throw new Error('seedToken requires the SQLite D1 shim (src/services/db/sqlite.ts) on env.DB');
  }
  return db;
}

function accountUsername(env: SeedEnv): string {
  if (env.ACCOUNT_USERNAME) return env.ACCOUNT_USERNAME;
  return isLocalDevelopment(env) ? DEV_ACCOUNT_USERNAME : 'me';
}

// Inserts an opaque token row for `username` and returns the bearer token. The
// Account's row is created too, since the Instance must have one before its
// storage routes run and a token row can only reference existing users.
export function seedToken(
  env: SeedEnv,
  username: string,
  scopes = 'documents:rw pictures:rw',
  options: SeedOptions = {},
): string {
  const raw = shim(env).sqlite;
  const createdAt = nowSeconds();
  const insertUser = raw.prepare('INSERT OR IGNORE INTO users (id, username) VALUES (?, ?)');
  insertUser.run(crypto.randomUUID(), accountUsername(env));
  insertUser.run(crypto.randomUUID(), username);
  raw.prepare('INSERT OR IGNORE INTO oauth_clients (id, name, redirect_uris, created_at, user_id) VALUES (?, ?, ?, ?, ?)')
    .run('test-client', 'test-client', '[]', createdAt, username);

  const accessToken = `test-${crypto.randomUUID()}`;
  raw.prepare(
    'INSERT INTO oauth_tokens (id, access_token_hash, refresh_token_hash, expires_at, scopes, user_id, client_id) VALUES (?, ?, NULL, ?, ?, ?, ?)'
  ).run(crypto.randomUUID(), tokenHash(accessToken), options.expiresAt ?? createdAt + 3600, scopes, username, 'test-client');
  return accessToken;
}

// Deletes a seeded token row, as revoking an authorization would.
export function deleteToken(env: SeedEnv, accessToken: string): void {
  shim(env).sqlite.prepare('DELETE FROM oauth_tokens WHERE access_token_hash = ?').run(tokenHash(accessToken));
}
