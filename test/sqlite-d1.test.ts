import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteD1, type SqliteD1 } from '../src/services/db/sqlite';

// The shared SQLite D1 shim: real SQLite, the shipped drizzle/migrations, and
// wrangler-style d1_migrations tracking so a database is migrated once.

const MIGRATIONS = join(process.cwd(), 'drizzle', 'migrations');
const SHIPPED = readdirSync(MIGRATIONS).filter(file => file.endsWith('.sql')).sort();
const HASH_MIGRATION = '0005_hash_oauth_secrets.sql';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'rsilo-sqlite-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function migrationNames(db: SqliteD1): string[] {
  return (db.sqlite.prepare('SELECT name FROM d1_migrations ORDER BY name').all() as { name: string }[])
    .map(row => row.name);
}

function columns(db: SqliteD1, table: string): string[] {
  return (db.sqlite.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[])
    .map(row => row.name);
}

describe('migration application', () => {
  it('applies every shipped migration in order and records it in d1_migrations', () => {
    const db = createSqliteD1();
    expect(migrationNames(db)).toEqual(SHIPPED);
    expect(columns(db, 'oauth_tokens')).toContain('access_token_hash');
    expect(columns(db, 'users')).not.toContain('password_hash');
  });

  it('does not re-run migrations when a database file is reopened', () => {
    const path = join(workdir, 'db.sqlite');
    const first = createSqliteD1(path);
    first.sqlite.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run('u1', 'alice');
    first.sqlite.prepare('INSERT INTO oauth_clients (id, name, redirect_uris, user_id) VALUES (?, ?, ?, ?)')
      .run('c1', 'client', '[]', 'alice');
    first.sqlite.prepare(
      'INSERT INTO oauth_tokens (id, access_token_hash, expires_at, scopes, user_id, client_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('t1', 'hash', 9999999999, 'documents:rw', 'alice', 'c1');
    first.close();

    const second = createSqliteD1(path);
    // If 0005 re-ran, it would have dropped the tokens and deleted the client.
    expect(second.sqlite.prepare('SELECT id FROM oauth_tokens').all()).toEqual([{ id: 't1' }]);
    expect(second.sqlite.prepare('SELECT id FROM oauth_clients').all()).toEqual([{ id: 'c1' }]);
    expect(second.sqlite.prepare('SELECT username FROM users').all()).toEqual([{ username: 'alice' }]);
    expect(migrationNames(second)).toEqual(SHIPPED);
    second.close();
  });

  it('upgrades a pre-shim database: plaintext tokens are dropped by the hash migration, the Account row survives', () => {
    // A database created before this shim existed: no d1_migrations, and
    // plaintext secrets. Rebuild that state from the shipped migrations.
    const oldDir = join(workdir, 'migrations-before-hash');
    mkdirSync(oldDir);
    for (const file of SHIPPED.filter(file => file < HASH_MIGRATION)) {
      copyFileSync(join(MIGRATIONS, file), join(oldDir, file));
    }

    const path = join(workdir, 'legacy.sqlite');
    const before = createSqliteD1(path, { migrationsDir: oldDir });
    before.sqlite.exec('DROP TABLE d1_migrations');
    before.sqlite.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run('u1', 'alice');
    before.sqlite.prepare('INSERT INTO oauth_clients (id, name, redirect_uris, user_id) VALUES (?, ?, ?, ?)')
      .run('c1', 'client', '[]', 'alice');
    before.sqlite.prepare(
      'INSERT INTO oauth_tokens (id, access_token, expires_at, scopes, user_id, client_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('t1', 'plaintext-token', 9999999999, 'documents:rw', 'alice', 'c1');
    expect(columns(before, 'oauth_tokens')).toContain('access_token');
    before.close();

    const after = createSqliteD1(path);
    expect(migrationNames(after)).toEqual(SHIPPED);
    expect(columns(after, 'oauth_tokens')).toContain('access_token_hash');
    expect(columns(after, 'oauth_tokens')).not.toContain('access_token');
    expect(after.sqlite.prepare('SELECT COUNT(*) AS n FROM oauth_tokens').get()).toEqual({ n: 0 });
    expect(after.sqlite.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get()).toEqual({ n: 0 });
    expect(after.sqlite.prepare('SELECT username FROM users').all()).toEqual([{ username: 'alice' }]);
    after.close();
  });

  it('upgrades a pre-shim database at the hash migration without touching its rows, then runs later migrations', () => {
    // The newest schema the old LocalDatabase wrote: everything up to 0005.
    const oldDir = join(workdir, 'migrations-at-hash');
    mkdirSync(oldDir);
    for (const file of SHIPPED.filter(file => file <= HASH_MIGRATION)) {
      copyFileSync(join(MIGRATIONS, file), join(oldDir, file));
    }
    const path = join(workdir, 'legacy-current.sqlite');
    const before = createSqliteD1(path, { migrationsDir: oldDir });
    before.sqlite.exec('DROP TABLE d1_migrations');
    before.sqlite.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run('u1', 'alice');
    before.sqlite.prepare('INSERT INTO oauth_clients (id, name, redirect_uris, user_id) VALUES (?, ?, ?, ?)')
      .run('c1', 'client', '[]', 'alice');
    before.sqlite.prepare(
      'INSERT INTO oauth_tokens (id, access_token_hash, expires_at, scopes, user_id, client_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('t1', 'hash', 9999999999, 'documents:rw', 'alice', 'c1');
    before.close();

    const after = createSqliteD1(path);
    expect(migrationNames(after)).toEqual(SHIPPED);
    expect(after.sqlite.prepare('SELECT id FROM oauth_tokens').all()).toEqual([{ id: 't1' }]);
    expect(columns(after, 'oauth_tokens')).toContain('refresh_expires_at');
    after.close();
  });
});

describe('D1 statement API', () => {
  it('prepare().bind().first() returns the row, or null when there is none', async () => {
    const db = createSqliteD1();
    await db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').bind('u1', 'alice').run();
    expect(await db.prepare('SELECT username FROM users WHERE id = ?').bind('u1').first()).toEqual({ username: 'alice' });
    expect(await db.prepare('SELECT username FROM users WHERE id = ?').bind('nobody').first()).toBeNull();
    expect(await db.prepare('SELECT username FROM users WHERE id = ?').first()).toBeNull();
  });

  it('bind() returns a new statement and does not mutate the prepared one', async () => {
    const db = createSqliteD1();
    const statement = db.prepare('INSERT INTO users (id, username) VALUES (?, ?)');
    await statement.bind('u1', 'alice').run();
    await statement.bind('u2', 'bob').run();
    expect((await db.prepare('SELECT username FROM users ORDER BY username').all()).results).toEqual([
      { username: 'alice' },
      { username: 'bob' },
    ]);
  });

  it('run() reports changes', async () => {
    const db = createSqliteD1();
    const inserted = await db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').bind('u1', 'alice').run();
    expect(inserted.meta.changes).toBe(1);
    const ignored = await db.prepare('INSERT OR IGNORE INTO users (id, username) VALUES (?, ?)').bind('u1', 'other').run();
    expect(ignored.meta.changes).toBe(0);
  });

  it('batch() runs statements in order, as one transaction', async () => {
    const db = createSqliteD1();
    const results = await db.batch([
      db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').bind('u1', 'alice'),
      db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').bind('u2', 'bob'),
    ]);
    expect(results).toHaveLength(2);
    expect((await db.prepare('SELECT username FROM users ORDER BY username').all()).results).toHaveLength(2);

    await expect(db.batch([
      db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').bind('u3', 'carol'),
      db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').bind('u4', 'alice'),
    ])).rejects.toThrow();
    expect(await db.prepare('SELECT username FROM users WHERE username = ?').bind('carol').first()).toBeNull();
  });

  it('records every prepared statement in queries when asked, and none otherwise', () => {
    const db = createSqliteD1(':memory:', { recordQueries: true });
    db.prepare('SELECT 1 FROM users');
    db.prepare('SELECT 2 FROM users');
    expect(db.queries).toEqual(['SELECT 1 FROM users', 'SELECT 2 FROM users']);

    const quiet = createSqliteD1();
    quiet.prepare('SELECT 1 FROM users');
    expect(quiet.queries).toEqual([]);
  });
});
