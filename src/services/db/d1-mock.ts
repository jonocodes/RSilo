import { LocalDatabase } from './local';

export class D1Adapter {
  constructor(private db: LocalDatabase) {}

  prepare(sql: string) {
    const self = this;

    function makeStatement(values: any[]) {
      const stmt = {
        bind: (...newValues: any[]) => makeStatement(newValues),

        first: async <T>(): Promise<T | null> => {
          if (sql.includes('oauth_clients') && sql.includes('WHERE id = ?')) {
            return self.db.getClient(values[0]) as Promise<T>;
          }
          if (sql.includes('oauth_tokens') && sql.includes('access_token = ?')) {
            return self.db.getTokenByAccessToken(values[0]) as Promise<T>;
          }
          if (sql.includes('oauth_tokens') && sql.includes('refresh_token = ?')) {
            return self.db.getTokenByRefreshToken(values[0]) as Promise<T>;
          }
          if (sql.includes('oauth_codes') && sql.includes('WHERE code = ?')) {
            return self.db.getCode(values[0]) as Promise<T>;
          }
          if (sql.includes('FROM users') && sql.includes('username = ?')) {
            return self.db.getUserByUsername(values[0]) as Promise<T>;
          }
          if (sql.includes('used_storage_bytes') && sql.includes('WHERE id = ?')) {
            return { used_storage_bytes: await self.db.getStorageUsage(values[0]) } as unknown as T;
          }
          if (sql.includes('FROM users') && sql.includes('id = ?') && sql.includes('SELECT')) {
            return self.db.getUserById(values[0]) as Promise<T>;
          }
          if (sql.includes('COUNT(*)') && sql.includes('oauth_tokens')) {
            return { count: await self.db.getTokenCount() } as unknown as T;
          }
          if (sql.includes('COUNT(*)')) {
            return { count: await self.db.getUserCount() } as unknown as T;
          }
          if (sql.includes('SUM')) {
            return { total: await self.db.getTotalStorage() } as unknown as T;
          }
          return null;
        },

        run: async () => {
          if (sql.includes('INSERT INTO users')) {
            await self.db.createUser(values[0], values[1], values[2]);
          } else if (sql.includes('INSERT INTO oauth_tokens')) {
            await self.db.createToken({
              id: values[0],
              access_token: values[1],
              refresh_token: values[2],
              expires_at: values[3],
              scopes: values[4],
              user_id: values[5],
              client_id: values[6],
            });
          } else if (sql.includes('INSERT INTO oauth_clients')) {
            await self.db.createClient({
              id: values[0],
              name: values[1],
              redirect_uris: values[2],
              created_at: values[3],
              user_id: values[4],
            });
          } else if (sql.includes('INSERT INTO oauth_codes')) {
            await self.db.createCode({
              code: values[0],
              client_id: values[1],
              user_id: values[2],
              redirect_uri: values[3],
              scope: values[4],
              expires_at: values[5],
              created_at: Math.floor(Date.now() / 1000),
            });
          } else if (sql.includes('DELETE FROM oauth_tokens') && sql.includes('user_id')) {
            await self.db.deleteTokenByIdAndUser(values[0], values[1]);
          } else if (sql.includes('DELETE FROM oauth_codes')) {
            await self.db.deleteCode(values[0]);
          } else if (sql.includes('UPDATE users') && sql.includes('storage_quota_bytes')) {
            await self.db.updateUserQuota(values[1], values[0]);
          } else if (sql.includes('UPDATE users') && sql.includes('password_hash')) {
            await self.db.updatePasswordHash(values[2], values[0]);
          } else if (sql.includes('UPDATE users') && sql.includes('used_storage_bytes')) {
            await self.db.updateStorageUsage(values[1], values[0]);
          } else if (sql.includes('DELETE FROM users') && sql.includes('username')) {
            await self.db.deleteUser(values[0]);
          } else if (sql.includes('UPDATE oauth_tokens')) {
            const existing = await self.db.getTokenByRefreshToken(values[3]);
            if (existing) {
              await self.db.deleteToken(existing.id);
              await self.db.createToken({
                id: existing.id,
                access_token: values[0],
                refresh_token: values[1],
                expires_at: values[2],
                scopes: existing.scopes,
                user_id: existing.user_id,
                client_id: existing.client_id,
              });
            }
          }
          return {};
        },

        all: async () => {
          if (sql.includes('oauth_tokens') && sql.includes('user_id = ?')) {
            const tokens = await self.db.getTokensByUser(values[0]);
            return { results: tokens };
          }
          if (sql.includes('FROM users') && !sql.includes('WHERE')) {
            const users = await self.db.getAllUsers();
            return { results: users };
          }
          return { results: [] };
        },
      };
      return stmt;
    }

    return makeStatement([]);
  }
}