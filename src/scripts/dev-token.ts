import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { generateToken, hashToken } from '../services/auth';
import { createSqliteD1 } from '../services/db/sqlite';

// Issues an opaque bearer token for local development by inserting a row into
// oauth_tokens (ADR-0003). Creates the user and a per-user "dev-token" OAuth
// client if they do not exist yet. Only the token is written to stdout; the
// row holds its hash.

const TOKEN_TTL_SECONDS = 86400 * 30;

const args = process.argv.slice(2);

if (args.includes('-h') || args.includes('--help')) {
  console.log('Usage: bun run dev-token [--d1] [username] [scopes]');
  console.log('');
  console.log('  (default)  insert into the offline DB used by `bun run dev:offline` (DB_PATH, default data/remotestorage.db)');
  console.log('  --d1       insert into the local D1 database used by `bun run dev` (wrangler d1 execute --local)');
  console.log('');
  console.log('Example: bun run dev-token alice "documents:rw pictures:rw"');
  process.exit(0);
}

const useD1 = args.includes('--d1');
const [username = 'alice', scopes = 'documents:rw pictures:rw'] = args.filter(arg => !arg.startsWith('--'));

const now = Math.floor(Date.now() / 1000);
const accessToken = generateToken();
const clientId = `dev-token:${username}`;
const token = {
  id: crypto.randomUUID(),
  access_token_hash: await hashToken(accessToken),
  refresh_token_hash: null,
  expires_at: now + TOKEN_TTL_SECONDS,
  scopes,
  user_id: username,
  client_id: clientId,
};

async function insertOffline(): Promise<void> {
  const db = createSqliteD1(process.env.DB_PATH || 'data/remotestorage.db');
  try {
    const user = await db.prepare('INSERT OR IGNORE INTO users (id, username) VALUES (?, ?)')
      .bind(crypto.randomUUID(), username)
      .run();
    if (user.meta.changes > 0) console.error(`Created user ${username}`);
    await db.prepare('INSERT OR IGNORE INTO oauth_clients (id, name, redirect_uris, created_at, user_id) VALUES (?, ?, ?, ?, ?)')
      .bind(clientId, 'dev-token', '[]', now, username)
      .run();
    await db.prepare(
      'INSERT INTO oauth_tokens (id, access_token_hash, refresh_token_hash, expires_at, scopes, user_id, client_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(token.id, token.access_token_hash, token.refresh_token_hash, token.expires_at, token.scopes, token.user_id, token.client_id).run();
  } finally {
    db.close();
  }
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function insertD1(): void {
  const sql = [
    `INSERT OR IGNORE INTO users (id, username) VALUES (${sqlString(crypto.randomUUID())}, ${sqlString(username)});`,
    'INSERT OR IGNORE INTO oauth_clients (id, name, redirect_uris, created_at, user_id) VALUES '
      + `(${sqlString(clientId)}, 'dev-token', '[]', ${now}, ${sqlString(username)});`,
    'INSERT INTO oauth_tokens (id, access_token_hash, refresh_token_hash, expires_at, scopes, user_id, client_id) VALUES '
      + `(${sqlString(token.id)}, ${sqlString(token.access_token_hash)}, NULL, ${token.expires_at}, ${sqlString(scopes)}, `
      + `${sqlString(username)}, ${sqlString(clientId)});`,
  ].join('\n');

  const wrangler = join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
  const res = spawnSync(wrangler, ['d1', 'execute', 'DB', '--local', '--command', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.status !== 0) {
    console.error(`${res.stdout ?? ''}${res.stderr ?? ''}`);
    console.error('Failed to insert the token into local D1. Run `bun run db:migrate` first.');
    process.exit(1);
  }
}

if (useD1) {
  insertD1();
} else {
  await insertOffline();
}

console.log(accessToken);
