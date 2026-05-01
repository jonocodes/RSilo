import type { User, OAuthClient, OAuthToken, OAuthCode } from './schema';
import type { D1Database } from '@cloudflare/workers-types';

export class Database {
  constructor(private db: D1Database) {}

  async getUserByUsername(username: string): Promise<User | null> {
    const result = await this.db.prepare(
      'SELECT * FROM users WHERE username = ?'
    ).bind(username).first<User>();

    return result || null;
  }

  async getUserById(id: string): Promise<User | null> {
    const result = await this.db.prepare(
      'SELECT * FROM users WHERE id = ?'
    ).bind(id).first<User>();

    return result || null;
  }

  async createUser(id: string, username: string, passwordHash: string): Promise<void> {
    await this.db.prepare(
      'INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)'
    ).bind(id, username, passwordHash).run();
  }

  async getStorageUsage(userId: string): Promise<number> {
    const result = await this.db.prepare(
      'SELECT used_storage_bytes FROM users WHERE id = ?'
    ).bind(userId).first<{ used_storage_bytes: number }>();

    return result?.used_storage_bytes || 0;
  }

  async updateStorageUsage(userId: string, bytes: number): Promise<void> {
    await this.db.prepare(
      'UPDATE users SET used_storage_bytes = ? WHERE id = ?'
    ).bind(bytes, userId).run();
  }

  async getClient(clientId: string): Promise<OAuthClient | null> {
    const result = await this.db.prepare(
      'SELECT * FROM oauth_clients WHERE id = ?'
    ).bind(clientId).first<OAuthClient>();

    return result || null;
  }

  async getTokenByAccessToken(accessToken: string): Promise<OAuthToken | null> {
    const result = await this.db.prepare(
      'SELECT * FROM oauth_tokens WHERE access_token = ? AND expires_at > ?'
    ).bind(accessToken, Math.floor(Date.now() / 1000)).first<OAuthToken>();

    return result || null;
  }

  async getTokenByRefreshToken(refreshToken: string): Promise<OAuthToken | null> {
    const result = await this.db.prepare(
      'SELECT * FROM oauth_tokens WHERE refresh_token = ?'
    ).bind(refreshToken).first<OAuthToken>();

    return result || null;
  }

  async createToken(token: Omit<OAuthToken, 'created_at'>): Promise<void> {
    await this.db.prepare(
      'INSERT INTO oauth_tokens (id, access_token, refresh_token, expires_at, scopes, user_id, client_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      token.id,
      token.access_token,
      token.refresh_token,
      token.expires_at,
      token.scopes,
      token.user_id,
      token.client_id
    ).run();
  }

  async deleteToken(tokenId: string): Promise<void> {
    await this.db.prepare(
      'DELETE FROM oauth_tokens WHERE id = ?'
    ).bind(tokenId).run();
  }

  async deleteExpiredTokens(): Promise<void> {
    await this.db.prepare(
      'DELETE FROM oauth_tokens WHERE expires_at < ?'
    ).bind(Math.floor(Date.now() / 1000)).run();
  }

  async createCode(code: OAuthCode): Promise<void> {
    await this.db.prepare(
      'INSERT INTO oauth_codes (code, client_id, user_id, redirect_uri, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(code.code, code.client_id, code.user_id, code.redirect_uri, code.scope, code.expires_at).run();
  }

  async getCode(code: string): Promise<OAuthCode | null> {
    const result = await this.db.prepare(
      'SELECT * FROM oauth_codes WHERE code = ? AND expires_at > ?'
    ).bind(code, Math.floor(Date.now() / 1000)).first<OAuthCode>();
    return result || null;
  }

  async deleteCode(code: string): Promise<void> {
    await this.db.prepare('DELETE FROM oauth_codes WHERE code = ?').bind(code).run();
  }

  async deleteExpiredCodes(): Promise<void> {
    await this.db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?')
      .bind(Math.floor(Date.now() / 1000)).run();
  }
}