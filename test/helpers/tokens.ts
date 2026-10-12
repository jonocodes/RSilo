// Seeds opaque bearer tokens for tests. Storage auth only accepts rows in
// `oauth_tokens` (ADR-0003), so fixtures register a row on the env's DB mock
// instead of minting a JWT. Token lookups are answered from the seeded rows;
// every other query falls through to the DB mock the test already provides.
// Rows are keyed by the token's hash, as the real table stores them.

import { createHash } from 'node:crypto';

// What oauth_tokens/oauth_codes store for a secret (services/auth hashToken),
// computed synchronously for SQL fixtures.
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}
const hash = tokenHash;

// RFC 7636 Appendix B: a code_verifier and its S256 code_challenge.
export const PKCE = {
  verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
};

interface SeededToken {
  id: string;
  access_token_hash: string;
  refresh_token_hash: string | null;
  expires_at: number;
  scopes: string;
  user_id: string;
  client_id: string;
  created_at: number;
}

interface SeedOptions {
  expiresAt?: number;
}

const TOKEN_LOOKUP = /FROM oauth_tokens WHERE access_token_hash = \?/;
const seeded = new WeakMap<object, Map<string, SeededToken>>();

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function emptyStatement() {
  const result = {
    first: async () => null,
    all: async () => ({ results: [] }),
    run: async () => ({ success: true, meta: { changes: 1 } }),
  };
  return { ...result, bind: () => result };
}

function tokenStatement(rows: Map<string, SeededToken>) {
  return {
    bind: (accessTokenHash: string, now?: number) => ({
      first: async () => {
        const row = rows.get(accessTokenHash);
        if (!row) return null;
        if (now !== undefined && row.expires_at <= now) return null;
        return { ...row };
      },
    }),
  };
}

function tokenRows(env: { DB?: any }): Map<string, SeededToken> {
  if (!env.DB) env.DB = {};
  const db = env.DB;
  const existing = seeded.get(db);
  if (existing) return existing;

  const rows = new Map<string, SeededToken>();
  const original = typeof db.prepare === 'function' ? db.prepare.bind(db) : null;
  db.prepare = (sql: string) => {
    if (TOKEN_LOOKUP.test(sql)) return tokenStatement(rows);
    return original ? original(sql) : emptyStatement();
  };
  seeded.set(db, rows);
  return rows;
}

// Inserts an opaque token row for `username` and returns the bearer token.
export function seedToken(
  env: { DB?: any },
  username: string,
  scopes = 'documents:rw pictures:rw',
  options: SeedOptions = {},
): string {
  const accessToken = `test-${crypto.randomUUID()}`;
  const createdAt = nowSeconds();
  tokenRows(env).set(hash(accessToken), {
    id: crypto.randomUUID(),
    access_token_hash: hash(accessToken),
    refresh_token_hash: null,
    expires_at: options.expiresAt ?? createdAt + 3600,
    scopes,
    user_id: username,
    client_id: 'test-client',
    created_at: createdAt,
  });
  return accessToken;
}

// Deletes a seeded token row, as revoking an authorization would.
export function deleteToken(env: { DB?: any }, accessToken: string): void {
  tokenRows(env).delete(hash(accessToken));
}
