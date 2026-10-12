import { Database as BunDatabase } from 'bun:sqlite';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import type { User, OAuthClient, OAuthToken, OAuthCode } from './schema';

export class LocalDatabase {
  private db: BunDatabase;

  constructor(dbPath?: string) {
    const defaultPath = join(process.cwd(), 'data', 'remotestorage.db');
    const finalPath = dbPath || defaultPath;

    const dir = join(finalPath, '..');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new BunDatabase(finalPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.initSchema();
  }

  private initSchema() {
    // Mirrors migration 0005 for databases created before OAuth secrets were
    // hashed: the plaintext rows are dropped, so apps reconnect once.
    const columns = this.db.prepare("SELECT name FROM pragma_table_info('oauth_tokens')").all() as { name: string }[];
    if (columns.some(column => column.name === 'access_token')) {
      this.db.exec('DROP TABLE oauth_tokens; DROP TABLE IF EXISTS oauth_codes; DELETE FROM oauth_clients;');
    }
    this.db.exec(SCHEMA_SQL);
    // Mirrors migration 0003 for databases created before passwords were removed.
    try {
      this.db.exec('ALTER TABLE users DROP COLUMN password_hash');
    } catch { /* column already gone */ }
  }

  async getUserByUsername(username: string): Promise<User | null> {
    const stmt = this.db.prepare('SELECT * FROM users WHERE username = ?');
    const result = stmt.get(username) as User | undefined;
    return result || null;
  }

  async getUserById(id: string): Promise<User | null> {
    const stmt = this.db.prepare('SELECT * FROM users WHERE id = ?');
    const result = stmt.get(id) as User | undefined;
    return result || null;
  }

  async createUser(id: string, username: string): Promise<void> {
    const stmt = this.db.prepare('INSERT INTO users (id, username) VALUES (?, ?)');
    stmt.run(id, username);
  }

  async createUserIfAbsent(id: string, username: string): Promise<void> {
    this.db.prepare('INSERT OR IGNORE INTO users (id, username) VALUES (?, ?)').run(id, username);
  }

  async getStorageUsage(userId: string): Promise<number> {
    const stmt = this.db.prepare('SELECT used_storage_bytes FROM users WHERE id = ?');
    const result = stmt.get(userId) as { used_storage_bytes: number } | undefined;
    return result?.used_storage_bytes || 0;
  }

  async updateStorageUsage(userId: string, bytes: number): Promise<void> {
    const stmt = this.db.prepare('UPDATE users SET used_storage_bytes = ? WHERE id = ?');
    stmt.run(bytes, userId);
  }

  async adjustStorageUsage(username: string, delta: number, enforceQuota = true): Promise<boolean> {
    const adjust = this.db.transaction((user: string, change: number, enforce: boolean) => {
      const current = this.db.prepare(
        'SELECT storage_quota_bytes, used_storage_bytes FROM users WHERE username = ?'
      ).get(user) as { storage_quota_bytes: number; used_storage_bytes: number } | undefined;
      if (!current) return false;

      const next = Math.max(0, current.used_storage_bytes + change);
      if (enforce && change > 0 && next > current.storage_quota_bytes) return false;
      this.db.prepare('UPDATE users SET used_storage_bytes = ? WHERE username = ?').run(next, user);
      return true;
    });
    return adjust(username, delta, enforceQuota);
  }

  async getClient(clientId: string): Promise<OAuthClient | null> {
    const stmt = this.db.prepare('SELECT * FROM oauth_clients WHERE id = ?');
    const result = stmt.get(clientId) as OAuthClient | undefined;
    return result || null;
  }

  async getTokenByAccessTokenHash(accessTokenHash: string): Promise<OAuthToken | null> {
    const stmt = this.db.prepare('SELECT * FROM oauth_tokens WHERE access_token_hash = ? AND expires_at > ?');
    const result = stmt.get(accessTokenHash, Math.floor(Date.now() / 1000)) as OAuthToken | undefined;
    return result || null;
  }

  // Matches the current or the previous refresh token (see the token endpoint).
  async getTokenByRefreshTokenHash(refreshTokenHash: string): Promise<OAuthToken | null> {
    const stmt = this.db.prepare('SELECT * FROM oauth_tokens WHERE refresh_token_hash = ? OR previous_refresh_token_hash = ?');
    const result = stmt.get(refreshTokenHash, refreshTokenHash) as OAuthToken | undefined;
    return result || null;
  }

  async createToken(token: Omit<OAuthToken, 'created_at' | 'previous_refresh_token_hash'>): Promise<void> {
    const stmt = this.db.prepare(
      'INSERT INTO oauth_tokens (id, access_token_hash, refresh_token_hash, expires_at, scopes, user_id, client_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    stmt.run(
      token.id,
      token.access_token_hash,
      token.refresh_token_hash,
      token.expires_at,
      token.scopes,
      token.user_id,
      token.client_id
    );
  }

  async rotateToken(id: string, rotation: Pick<OAuthToken, 'access_token_hash' | 'refresh_token_hash' | 'previous_refresh_token_hash' | 'expires_at'>): Promise<void> {
    this.db.prepare(
      'UPDATE oauth_tokens SET access_token_hash = ?, refresh_token_hash = ?, previous_refresh_token_hash = ?, expires_at = ? WHERE id = ?'
    ).run(rotation.access_token_hash, rotation.refresh_token_hash, rotation.previous_refresh_token_hash, rotation.expires_at, id);
  }

  async deleteToken(tokenId: string): Promise<void> {
    const stmt = this.db.prepare('DELETE FROM oauth_tokens WHERE id = ?');
    stmt.run(tokenId);
  }

  async deleteExpiredTokens(): Promise<void> {
    const stmt = this.db.prepare('DELETE FROM oauth_tokens WHERE expires_at < ?');
    stmt.run(Math.floor(Date.now() / 1000));
  }

  async getAllUsers(): Promise<User[]> {
    const stmt = this.db.prepare('SELECT * FROM users ORDER BY created_at DESC');
    return stmt.all() as User[];
  }

  async getUserCount(): Promise<number> {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM users');
    const result = stmt.get() as { count: number };
    return result?.count || 0;
  }

  async getTotalStorage(): Promise<number> {
    const stmt = this.db.prepare('SELECT SUM(used_storage_bytes) as total FROM users');
    const result = stmt.get() as { total: number } | undefined;
    return result?.total || 0;
  }

  async getTokenCount(): Promise<number> {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM oauth_tokens');
    const result = stmt.get() as { count: number };
    return result?.count || 0;
  }

  async updateUserQuota(username: string, quotaBytes: number): Promise<void> {
    const stmt = this.db.prepare('UPDATE users SET storage_quota_bytes = ? WHERE username = ?');
    stmt.run(quotaBytes, username);
  }

  async getTokensByUser(userId: string): Promise<OAuthToken[]> {
    const stmt = this.db.prepare('SELECT * FROM oauth_tokens WHERE user_id = ? ORDER BY created_at DESC');
    return stmt.all(userId) as OAuthToken[];
  }

  async getAllTokens(): Promise<OAuthToken[]> {
    const stmt = this.db.prepare('SELECT * FROM oauth_tokens ORDER BY created_at DESC');
    return stmt.all() as OAuthToken[];
  }

  async deleteTokenByIdAndUser(tokenId: string, userId: string): Promise<void> {
    this.db.prepare('DELETE FROM oauth_tokens WHERE id = ? AND user_id = ?').run(tokenId, userId);
  }

  async deleteTokensByUser(userId: string): Promise<void> {
    this.db.prepare('DELETE FROM oauth_tokens WHERE user_id = ?').run(userId);
  }

  async deleteCodesByUser(userId: string): Promise<void> {
    this.db.prepare('DELETE FROM oauth_codes WHERE user_id = ?').run(userId);
  }

  async deleteClientsByUser(userId: string): Promise<void> {
    this.db.prepare('DELETE FROM oauth_clients WHERE user_id = ?').run(userId);
  }

  async deleteUser(username: string): Promise<void> {
    const stmt = this.db.prepare('DELETE FROM users WHERE username = ?');
    stmt.run(username);
  }

  async createClient(client: OAuthClient): Promise<void> {
    const stmt = this.db.prepare('INSERT INTO oauth_clients (id, name, redirect_uris, created_at, user_id) VALUES (?, ?, ?, ?, ?)');
    stmt.run(client.id, client.name, client.redirect_uris, client.created_at, client.user_id);
  }

  async getAllClients(): Promise<OAuthClient[]> {
    const stmt = this.db.prepare('SELECT id, name, redirect_uris, created_at, user_id FROM oauth_clients ORDER BY created_at DESC');
    return stmt.all() as OAuthClient[];
  }

  async deleteClient(clientId: string): Promise<void> {
    this.db.prepare('DELETE FROM oauth_clients WHERE id = ?').run(clientId);
  }

  async deleteTokensByClient(clientId: string, userId: string): Promise<void> {
    this.db.prepare('DELETE FROM oauth_tokens WHERE client_id = ? AND user_id = ?').run(clientId, userId);
  }

  async deleteCodesByClient(clientId: string, userId: string): Promise<void> {
    this.db.prepare('DELETE FROM oauth_codes WHERE client_id = ? AND user_id = ?').run(clientId, userId);
  }

  async createCode(code: OAuthCode): Promise<void> {
    const stmt = this.db.prepare(
      'INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, scope, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    stmt.run(code.code_hash, code.client_id, code.user_id, code.redirect_uri, code.scope, code.code_challenge, code.expires_at);
  }

  async getCode(codeHash: string): Promise<OAuthCode | null> {
    const stmt = this.db.prepare(
      'SELECT * FROM oauth_codes WHERE code_hash = ? AND expires_at > ?'
    );
    const result = stmt.get(codeHash, Math.floor(Date.now() / 1000)) as OAuthCode | undefined;
    return result || null;
  }

  async getAllCodes(): Promise<OAuthCode[]> {
    const stmt = this.db.prepare('SELECT * FROM oauth_codes ORDER BY created_at DESC');
    return stmt.all() as OAuthCode[];
  }

  async deleteCode(codeHash: string): Promise<void> {
    this.db.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').run(codeHash);
  }

  async deleteExpiredCodes(): Promise<void> {
    this.db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(Math.floor(Date.now() / 1000));
  }

  close(): void {
    this.db.close();
  }
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  storage_quota_bytes INTEGER DEFAULT 10737418240,
  used_storage_bytes INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      user_id TEXT NOT NULL REFERENCES users(username)
    );

    CREATE TABLE IF NOT EXISTS oauth_tokens (
  id TEXT PRIMARY KEY,
  access_token_hash TEXT UNIQUE NOT NULL,
  refresh_token_hash TEXT UNIQUE,
  previous_refresh_token_hash TEXT UNIQUE,
  expires_at INTEGER NOT NULL,
  scopes TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(username),
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user_id ON oauth_tokens(user_id);
`;
