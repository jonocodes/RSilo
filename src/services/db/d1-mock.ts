import { LocalDatabase } from './local';

export class D1Adapter {
  constructor(private db: LocalDatabase) {}

  prepare(sql: string) {
    const self = this;
    return {
      bind: (...values: any[]) => ({
        first: async <T>(): Promise<T | null> => {
          if (sql.includes('SELECT') && sql.includes('oauth_clients') && sql.includes('WHERE id = ?')) {
            return self.db.getClient(values[0]) as Promise<T>;
          }
          if (sql.includes('SELECT') && sql.includes('oauth_tokens') && sql.includes('access_token = ?')) {
            return self.db.getTokenByAccessToken(values[0]) as Promise<T>;
          }
          if (sql.includes('SELECT') && sql.includes('oauth_tokens') && sql.includes('refresh_token = ?')) {
            return self.db.getTokenByRefreshToken(values[0]) as Promise<T>;
          }
          if (sql.includes('SELECT') && sql.includes('users') && sql.includes('ORDER BY')) {
            return self.db.getAllUsers() as Promise<T>;
          }
          if (sql.includes('SELECT') && sql.includes('users') && sql.includes('username = ?')) {
            return self.db.getUserByUsername(values[0]) as Promise<T>;
          }
          if (sql.includes('SELECT') && sql.includes('used_storage_bytes') && sql.includes('id = ?')) {
            return { used_storage_bytes: await self.db.getStorageUsage(values[0]) } as Promise<T>;
          }
          if (sql.includes('SELECT') && sql.includes('COUNT(*)')) {
            if (sql.includes('oauth_tokens')) {
              return { count: await self.db.getTokenCount() } as Promise<T>;
            }
            return { count: await self.db.getUserCount() } as Promise<T>;
          }
          if (sql.includes('SELECT') && sql.includes('SUM')) {
            return { total: await self.db.getTotalStorage() } as Promise<T>;
          }
          return null as Promise<T>;
        },
        run: async () => {
          if (sql.includes('INSERT INTO oauth_tokens')) {
            await self.db.createToken({
              id: values[0],
              access_token: values[1],
              refresh_token: values[2],
              expires_at: values[3],
              scopes: values[4],
              user_id: values[5],
              client_id: values[6],
            });
          }
          if (sql.includes('UPDATE users') && sql.includes('storage_quota_bytes')) {
            await self.db.updateUserQuota(values[1], values[0]);
          }
          return {};
        },
        all: async () => {
          if (sql.includes('SELECT') && sql.includes('users') && !sql.includes('WHERE')) {
            const users = await self.db.getAllUsers();
            return { results: users };
          }
          return { results: [] };
        },
      }),
    };
  }
}