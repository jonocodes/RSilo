import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// A minimal D1Database stand-in backed by in-memory SQLite with the shipped
// migrations applied and foreign keys enforced, so tests exercise the real SQL
// that runs against D1. `queries` records every prepared statement.
export interface SqliteD1 {
  prepare(sql: string): any;
  batch(statements: { run(): Promise<unknown> }[]): Promise<unknown[]>;
  queries: string[];
  sqlite: DatabaseSync;
}

export function createSqliteD1(): SqliteD1 {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const dir = join(process.cwd(), 'drizzle', 'migrations');
  for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(dir, file), 'utf-8'));
  }

  const queries: string[] = [];

  function statement(sql: string, values: any[]) {
    return {
      bind: (...next: any[]) => statement(sql, next),
      first: async () => (sqlite.prepare(sql).get(...values) as any) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
      run: async () => {
        const info = sqlite.prepare(sql).run(...values);
        return { success: true, meta: { changes: Number(info.changes) } };
      },
    };
  }

  return {
    prepare(sql: string) {
      queries.push(sql);
      return statement(sql, []);
    },
    async batch(statements) {
      const results: unknown[] = [];
      for (const s of statements) results.push(await s.run());
      return results;
    },
    queries,
    sqlite,
  };
}

export function usernames(db: SqliteD1): string[] {
  return (db.sqlite.prepare('SELECT username FROM users ORDER BY username').all() as { username: string }[])
    .map(row => row.username);
}
