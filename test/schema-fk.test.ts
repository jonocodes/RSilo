import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSqliteD1, type SqliteD1 } from '../src/services/db/sqlite';

// The shipped migrations applied to SQLite with foreign keys enforced, so
// schema drift like a user_id foreign key pointing at users(id) instead of
// users(username) fails here instead of in production.
describe('D1 migrations: OAuth foreign keys', () => {
  let db: SqliteD1;

  beforeAll(() => {
    db = createSqliteD1();
    db.sqlite.exec("INSERT INTO users (id, username) VALUES ('uuid-1', 'alice')");
  });

  afterAll(() => db.close());

  it('accepts an OAuth client whose user_id is the username', () => {
    db.sqlite.exec("INSERT INTO oauth_clients (id, name, redirect_uris, user_id) VALUES ('c1', 'client', 'http://localhost/cb', 'alice')");
    const row = db.sqlite.prepare("SELECT user_id FROM oauth_clients WHERE id = 'c1'").get() as { user_id: string };
    expect(row.user_id).toBe('alice');
  });

  it('accepts an OAuth token whose user_id is the username', () => {
    db.sqlite.exec("INSERT INTO oauth_tokens (id, access_token_hash, refresh_token_hash, expires_at, scopes, user_id, client_id) VALUES ('t1', 'at1', NULL, 9999999999, 'documents:rw', 'alice', 'c1')");
    const row = db.sqlite.prepare("SELECT user_id FROM oauth_tokens WHERE id = 't1'").get() as { user_id: string };
    expect(row.user_id).toBe('alice');
  });

  it('rejects an OAuth token for an unknown username', () => {
    expect(() =>
      db.sqlite.exec("INSERT INTO oauth_tokens (id, access_token_hash, refresh_token_hash, expires_at, scopes, user_id, client_id) VALUES ('t2', 'at2', NULL, 9999999999, 'documents:rw', 'nobody', 'c1')")
    ).toThrow();
  });
});
