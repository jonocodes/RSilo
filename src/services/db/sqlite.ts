// One database seam for everything that is not Cloudflare D1: the offline
// server, the local scripts and the tests all run against real SQLite through
// this D1-shaped stand-in, with the shipped drizzle/migrations applied in
// order. There is no second copy of the schema and no SQL-string routing.
//
// Applied migrations are recorded in `d1_migrations`, as `wrangler` does, so a
// database is migrated once. A database created before this shim existed has
// no `d1_migrations`: it is treated as already at the pre-shim schema (the
// latest shipped migration at that time), except that a pre-hash database
// (plaintext `access_token`) still runs the hash migration. That reproduces
// the one-time upgrade the old LocalDatabase performed.

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../../drizzle/migrations', import.meta.url).href);
// The migration that replaced plaintext secrets with hashes. A legacy database
// that predates it is the one case that still needs migrations applied.
const HASH_MIGRATION = '0005_hash_oauth_secrets.sql';

interface RawStatement {
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
  run(...values: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

/** The small slice of `bun:sqlite` / `node:sqlite` this shim uses. */
export interface RawDatabase {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  close(): void;
}

function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
}

function openDatabase(path: string): RawDatabase {
  if (isBunRuntime()) {
    const { Database } = require('bun:sqlite') as { Database: new (path: string) => RawDatabase };
    return new Database(path);
  }
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => RawDatabase };
  return new DatabaseSync(path);
}

export interface D1Meta {
  changes: number;
  last_row_id: number;
}

export interface D1Result<T> {
  results: T[];
  success: true;
  meta: D1Meta;
}

/** A D1PreparedStatement look-alike over one raw SQLite statement. */
export class SqliteStatement {
  constructor(
    private readonly db: RawDatabase,
    private readonly sql: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.db, this.sql, values.map(value => value === undefined ? null : value));
  }

  async first<T = unknown>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.values);
    return (row ?? null) as T | null;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const results = this.db.prepare(this.sql).all(...this.values) as T[];
    return { results, success: true, meta: { changes: 0, last_row_id: 0 } };
  }

  async run(): Promise<{ success: true; meta: D1Meta }> {
    const info = this.db.prepare(this.sql).run(...this.values);
    return {
      success: true,
      meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
    };
  }
}

export interface SqliteD1 {
  prepare(sql: string): SqliteStatement;
  /** D1's batch, as one transaction. */
  batch<T = unknown>(statements: { run(): Promise<T> }[]): Promise<T[]>;
  close(): void;
  /** Every prepared statement, in order, when created with `recordQueries`. Test observability. */
  queries: string[];
  /** The raw SQLite handle, for test fixtures and direct assertions. */
  sqlite: RawDatabase;
}

export interface SqliteD1Options {
  /** Where the .sql migrations live. Defaults to the repo's drizzle/migrations. */
  migrationsDir?: string;
  /** Record every prepared statement in `queries`. Off by default, so a long-running offline server does not grow it forever. */
  recordQueries?: boolean;
}

function tableExists(db: RawDatabase, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return row !== undefined && row !== null;
}

function hasColumn(db: RawDatabase, table: string, column: string): boolean {
  const rows = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[];
  return rows.some(row => row.name === column);
}

function migratedNames(db: RawDatabase): Set<string> {
  const rows = db.prepare('SELECT name FROM d1_migrations').all() as { name: string }[];
  return new Set(rows.map(row => row.name));
}

function applyMigrations(db: RawDatabase, dir: string): void {
  const files = readdirSync(dir).filter(file => file.endsWith('.sql')).sort();

  if (!tableExists(db, 'd1_migrations')) {
    db.exec(`CREATE TABLE d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`);
    if (tableExists(db, 'users')) {
      // Pre-shim database: its schema is the latest one the old LocalDatabase
      // wrote, so everything up to the hash migration is already applied. A
      // database still holding plaintext tokens predates the hash migration;
      // let that one run too. Later migrations always run.
      const baseline = hasColumn(db, 'oauth_tokens', 'access_token')
        ? files.filter(file => file < HASH_MIGRATION)
        : files.filter(file => file <= HASH_MIGRATION);
      const insert = db.prepare('INSERT INTO d1_migrations (name) VALUES (?)');
      for (const file of baseline) insert.run(file);
    }
  }

  const applied = migratedNames(db);
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(file);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${file} failed`, { cause: error });
    }
  }
}

export function createSqliteD1(path = ':memory:', options: SqliteD1Options = {}): SqliteD1 {
  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const dir = dirname(path);
  if (dir && path !== ':memory:' && !existsSync(dir)) mkdirSync(dir, { recursive: true });

  const sqlite = openDatabase(path);
  if (path !== ':memory:') sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA foreign_keys = ON');
  applyMigrations(sqlite, migrationsDir);

  const queries: string[] = [];

  return {
    prepare(sql: string) {
      if (options.recordQueries) queries.push(sql);
      return new SqliteStatement(sqlite, sql);
    },
    async batch<T = unknown>(statements: { run(): Promise<T> }[]): Promise<T[]> {
      const results: T[] = [];
      sqlite.exec('BEGIN');
      try {
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
      return results;
    },
    close() {
      sqlite.close();
    },
    queries,
    sqlite,
  };
}
