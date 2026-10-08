// The Account row lifecycle (ADR-0002). An Instance serves exactly one Account
// whose `users` row is the join target for App authorizations and holds the
// quota counter. The row is created lazily, the first time it is needed:
//
// - row for the username exists          -> 'ready'
// - table empty                          -> insert it (idempotent) -> 'ready'
// - row missing but other rows exist     -> 'username_mismatch'; nothing is
//   written, because the Operator changed ACCOUNT_USERNAME or migrated a
//   multi-user deployment without choosing which account to keep.
//
// Works with any D1-shaped binding: the D1 binding itself, or the offline
// D1Adapter over LocalDatabase.

export type AccountStatus = 'ready' | 'username_mismatch';

interface D1Like {
  prepare(sql: string): any;
}

// Memoised per isolate and per database binding: once a username is known to
// have a row, later requests skip the queries. A mismatch is not cached so an
// Operator fixing the table takes effect without a redeploy.
const readyAccounts = new WeakMap<object, Set<string>>();

export async function ensureAccount(db: D1Like, username: string): Promise<AccountStatus> {
  const known = readyAccounts.get(db);
  if (known?.has(username)) return 'ready';

  const status = await resolveAccount(db, username);
  if (status === 'ready') {
    if (known) known.add(username);
    else readyAccounts.set(db, new Set([username]));
  }
  return status;
}

async function resolveAccount(db: D1Like, username: string): Promise<AccountStatus> {
  const existing = await db.prepare('SELECT username FROM users WHERE username = ?').bind(username).first();
  if (existing) return 'ready';

  const others = await db.prepare('SELECT COUNT(*) AS count FROM users').bind().first() as { count?: number } | null;
  if (Number(others?.count ?? 0) > 0) return 'username_mismatch';

  await db.prepare('INSERT OR IGNORE INTO users (id, username) VALUES (?, ?)')
    .bind(crypto.randomUUID(), username)
    .run();
  return 'ready';
}

/** Usernames already in the users table (a few, sorted). Owner-only information. */
export async function storedUsernames(db: D1Like, limit = 10): Promise<string[]> {
  const result = await db.prepare('SELECT username FROM users ORDER BY username LIMIT ?').bind(limit).all() as
    { results?: { username: string }[] } | null;
  return (result?.results ?? []).slice(0, limit).map((row) => row.username);
}

/**
 * Public (unauthenticated) text for the mismatch state. Names the config
 * variable but never the stored usernames; the Owner sees those at /account.
 */
export function usernameMismatchMessage(username: string): string {
  return `Username mismatch: ACCOUNT_USERNAME is "${username}", but no account with that username exists `
    + 'and the users table already holds other accounts. The owner can see how to fix this at /account '
    + "(set ACCOUNT_USERNAME to the existing account in the Worker's settings).";
}
