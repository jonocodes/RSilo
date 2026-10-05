import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Applies the shipped D1 migrations to an in-memory SQLite database with
// foreign keys enforced, so schema drift like a user_id foreign key pointing at
// users(id) instead of users(username) fails here instead of in production.
describe('D1 migrations: OAuth foreign keys', () => {
  let db: DatabaseSync;

  beforeAll(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const dir = join(process.cwd(), 'drizzle', 'migrations');
    const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
      db.exec(readFileSync(join(dir, file), 'utf-8'));
    }
    db.exec("INSERT INTO users (id, username) VALUES ('uuid-1', 'alice')");
  });

  afterAll(() => db.close());

  it('accepts an OAuth client whose user_id is the username', () => {
    db.exec("INSERT INTO oauth_clients (id, name, redirect_uris, user_id) VALUES ('c1', 'client', 'http://localhost/cb', 'alice')");
    const row = db.prepare("SELECT user_id FROM oauth_clients WHERE id = 'c1'").get() as { user_id: string };
    expect(row.user_id).toBe('alice');
  });

  it('accepts an OAuth token whose user_id is the username', () => {
    db.exec("INSERT INTO oauth_tokens (id, access_token, refresh_token, expires_at, scopes, user_id, client_id) VALUES ('t1', 'at1', NULL, 9999999999, 'documents:rw', 'alice', 'c1')");
    const row = db.prepare("SELECT user_id FROM oauth_tokens WHERE id = 't1'").get() as { user_id: string };
    expect(row.user_id).toBe('alice');
  });

  it('rejects an OAuth token for an unknown username', () => {
    expect(() =>
      db.exec("INSERT INTO oauth_tokens (id, access_token, refresh_token, expires_at, scopes, user_id, client_id) VALUES ('t2', 'at2', NULL, 9999999999, 'documents:rw', 'nobody', 'c1')")
    ).toThrow();
  });
});
