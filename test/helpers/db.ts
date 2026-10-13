import type { SqliteD1 } from '../../src/services/db/sqlite';

export function usernames(db: SqliteD1): string[] {
  return (db.sqlite.prepare('SELECT username FROM users ORDER BY username').all() as { username: string }[])
    .map(row => row.username);
}
