import { describe, it, expect, vi, beforeEach } from 'vitest';
import { D1Adapter } from '../src/services/db/d1-mock';
import { ensureAccount } from '../src/services/account';

function makeMockDb() {
  return {
    createUser: vi.fn().mockResolvedValue(undefined),
    getUserByUsername: vi.fn().mockResolvedValue(null),
    getUserById: vi.fn().mockResolvedValue(null),
    updateUserQuota: vi.fn().mockResolvedValue(undefined),
    updateStorageUsage: vi.fn().mockResolvedValue(undefined),
    adjustStorageUsage: vi.fn().mockResolvedValue(true),
    getStorageUsage: vi.fn().mockResolvedValue(0),
    getUserCount: vi.fn().mockResolvedValue(0),
    getTotalStorage: vi.fn().mockResolvedValue(0),
    getTokenCount: vi.fn().mockResolvedValue(0),
    getAllUsers: vi.fn().mockResolvedValue([]),
    getClient: vi.fn().mockResolvedValue(null),
    createToken: vi.fn().mockResolvedValue(undefined),
    deleteToken: vi.fn().mockResolvedValue(undefined),
    deleteTokenByIdAndUser: vi.fn().mockResolvedValue(undefined),
    getTokenByAccessToken: vi.fn().mockResolvedValue(null),
    getTokenByRefreshToken: vi.fn().mockResolvedValue(null),
    getTokensByUser: vi.fn().mockResolvedValue([]),
    createCode: vi.fn().mockResolvedValue(undefined),
    getCode: vi.fn().mockResolvedValue(null),
    getAllCodes: vi.fn().mockResolvedValue([]),
    deleteCode: vi.fn().mockResolvedValue(undefined),
  };
}

describe('D1Adapter — user creation', () => {
  let mockDb: ReturnType<typeof makeMockDb>;
  let adapter: D1Adapter;

  beforeEach(() => {
    mockDb = makeMockDb();
    adapter = new D1Adapter(mockDb as any);
  });

  it('INSERT INTO users calls createUser with id and username', async () => {
    const sql = 'INSERT INTO users (id, username) VALUES (?, ?)';
    await adapter.prepare(sql).bind('uuid-1', 'alice').run();
    expect(mockDb.createUser).toHaveBeenCalledWith('uuid-1', 'alice');
  });

  it('SELECT users WHERE username = ? calls getUserByUsername', async () => {
    mockDb.getUserByUsername.mockResolvedValue({ id: 'uuid-1', username: 'alice' });
    const result = await adapter.prepare('SELECT id FROM users WHERE username = ?').bind('alice').first();
    expect(mockDb.getUserByUsername).toHaveBeenCalledWith('alice');
    expect((result as any)?.username).toBe('alice');
  });

  it('SELECT users WHERE username = ? returns null for unknown user', async () => {
    const result = await adapter.prepare('SELECT id FROM users WHERE username = ?').bind('nobody').first();
    expect(result).toBeNull();
  });

  it('UPDATE users SET storage_quota_bytes calls updateUserQuota', async () => {
    const sql = 'UPDATE users SET storage_quota_bytes = ? WHERE username = ?';
    await adapter.prepare(sql).bind(2147483648, 'alice').run();
    expect(mockDb.updateUserQuota).toHaveBeenCalledWith('alice', 2147483648);
  });
});

describe('D1Adapter — oauth codes', () => {
  let mockDb: ReturnType<typeof makeMockDb>;
  let adapter: D1Adapter;

  beforeEach(() => {
    mockDb = makeMockDb();
    adapter = new D1Adapter(mockDb as any);
  });

  it('INSERT INTO oauth_codes calls createCode', async () => {
    const sql = 'INSERT INTO oauth_codes (code, client_id, user_id, redirect_uri, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?)';
    await adapter.prepare(sql).bind('abc123', 'client-1', 'alice', 'https://cb', 'documents:rw', 9999).run();
    expect(mockDb.createCode).toHaveBeenCalledWith(expect.objectContaining({
      code: 'abc123',
      client_id: 'client-1',
      user_id: 'alice',
      redirect_uri: 'https://cb',
      scope: 'documents:rw',
      expires_at: 9999,
    }));
  });

  it('SELECT FROM oauth_codes WHERE code = ? calls getCode', async () => {
    mockDb.getCode.mockResolvedValue({ code: 'abc123', user_id: 'alice', scope: 'documents:rw' });
    const result = await adapter.prepare('SELECT * FROM oauth_codes WHERE code = ? AND expires_at > ?').bind('abc123', 0).first();
    expect(mockDb.getCode).toHaveBeenCalledWith('abc123');
    expect((result as any)?.code).toBe('abc123');
  });

  it('DELETE FROM oauth_codes calls deleteCode', async () => {
    const sql = 'DELETE FROM oauth_codes WHERE code = ?';
    await adapter.prepare(sql).bind('abc123').run();
    expect(mockDb.deleteCode).toHaveBeenCalledWith('abc123');
  });
});

describe('D1Adapter — oauth tokens', () => {
  let mockDb: ReturnType<typeof makeMockDb>;
  let adapter: D1Adapter;

  beforeEach(() => {
    mockDb = makeMockDb();
    adapter = new D1Adapter(mockDb as any);
  });

  it('INSERT INTO oauth_tokens calls createToken', async () => {
    const sql = 'INSERT INTO oauth_tokens (id, access_token, refresh_token, expires_at, scopes, user_id, client_id) VALUES (?, ?, ?, ?, ?, ?, ?)';
    await adapter.prepare(sql).bind('id-1', 'tok', 'ref', 9999, 'documents:rw', 'alice', 'client-1').run();
    expect(mockDb.createToken).toHaveBeenCalledWith({
      id: 'id-1',
      access_token: 'tok',
      refresh_token: 'ref',
      expires_at: 9999,
      scopes: 'documents:rw',
      user_id: 'alice',
      client_id: 'client-1',
    });
  });

  it('SELECT oauth_tokens WHERE access_token calls getTokenByAccessToken', async () => {
    mockDb.getTokenByAccessToken.mockResolvedValue({ access_token: 'tok', user_id: 'alice' });
    const result = await adapter.prepare('SELECT * FROM oauth_tokens WHERE access_token = ? AND expires_at > ?').bind('tok', 0).first();
    expect(mockDb.getTokenByAccessToken).toHaveBeenCalledWith('tok');
    expect((result as any)?.user_id).toBe('alice');
  });

  it('UPDATE oauth_tokens (refresh rotation) deletes old and creates new', async () => {
    const existing = { id: 'tok-id', access_token: 'old', refresh_token: 'old-ref', expires_at: 9999, scopes: 'documents:rw', user_id: 'alice', client_id: 'client-1' };
    mockDb.getTokenByRefreshToken.mockResolvedValue(existing);

    const sql = 'UPDATE oauth_tokens SET access_token = ?, refresh_token = ?, expires_at = ? WHERE refresh_token = ?';
    await adapter.prepare(sql).bind('new-tok', 'new-ref', 99999, 'old-ref').run();

    expect(mockDb.deleteToken).toHaveBeenCalledWith('tok-id');
    expect(mockDb.createToken).toHaveBeenCalledWith(expect.objectContaining({
      access_token: 'new-tok',
      refresh_token: 'new-ref',
      expires_at: 99999,
    }));
  });

  it('DELETE FROM oauth_tokens WHERE id = ? AND user_id = ? calls deleteTokenByIdAndUser', async () => {
    const sql = 'DELETE FROM oauth_tokens WHERE id = ? AND user_id = ?';
    await adapter.prepare(sql).bind('tok-1', 'alice').run();
    expect(mockDb.deleteTokenByIdAndUser).toHaveBeenCalledWith('tok-1', 'alice');
  });

  it('SELECT oauth_tokens WHERE user_id = ? calls getTokensByUser', async () => {
    const tokens = [
      { id: 'tok-1', access_token: 'a', scopes: 'documents:rw', user_id: 'alice', client_id: 'app', expires_at: 9999 },
    ];
    mockDb.getTokensByUser.mockResolvedValue(tokens);
    const result = await adapter.prepare('SELECT * FROM oauth_tokens WHERE user_id = ? ORDER BY created_at DESC').bind('alice').all();
    expect(mockDb.getTokensByUser).toHaveBeenCalledWith('alice');
    expect((result as any).results).toHaveLength(1);
  });
});

describe('D1Adapter — storage usage', () => {
  let mockDb: ReturnType<typeof makeMockDb>;
  let adapter: D1Adapter;

  beforeEach(() => {
    mockDb = makeMockDb();
    adapter = new D1Adapter(mockDb as any);
  });

  it('adjustStorageUsage delegates username, delta, and quota policy explicitly', async () => {
    mockDb.adjustStorageUsage.mockResolvedValue(true);
    const result = await adapter.adjustStorageUsage('alice', -512, false);
    expect(result).toBe(true);
    expect(mockDb.adjustStorageUsage).toHaveBeenCalledWith('alice', -512, false);
  });

  it('UPDATE users SET used_storage_bytes calls updateStorageUsage', async () => {
    const sql = 'UPDATE users SET used_storage_bytes = ? WHERE id = ?';
    await adapter.prepare(sql).bind(4096, 'user-uuid').run();
    expect(mockDb.updateStorageUsage).toHaveBeenCalledWith('user-uuid', 4096);
  });

  it('SELECT used_storage_bytes WHERE id calls getStorageUsage', async () => {
    mockDb.getStorageUsage.mockResolvedValue(8192);
    const result = await adapter.prepare('SELECT used_storage_bytes FROM users WHERE id = ?').bind('user-uuid').first();
    expect(mockDb.getStorageUsage).toHaveBeenCalledWith('user-uuid');
    expect((result as any)?.used_storage_bytes).toBe(8192);
  });
});

describe('D1Adapter — oauth codes listing', () => {
  let mockDb: ReturnType<typeof makeMockDb>;
  let adapter: D1Adapter;

  beforeEach(() => {
    mockDb = makeMockDb();
    adapter = new D1Adapter(mockDb as any);
  });

  it('SELECT * FROM oauth_codes calls getAllCodes', async () => {
    mockDb.getAllCodes.mockResolvedValue([{ code: 'abc123', user_id: 'alice', scope: 'documents:rw' }]);
    const result = await adapter.prepare('SELECT * FROM oauth_codes').all();
    expect((result as any).results).toHaveLength(1);
    expect((result as any).results[0].code).toBe('abc123');
  });
});

describe('D1Adapter — direct prepare() calls (no .bind())', () => {
  let mockDb: ReturnType<typeof makeMockDb>;
  let adapter: D1Adapter;

  beforeEach(() => {
    mockDb = makeMockDb();
    adapter = new D1Adapter(mockDb as any);
  });

  it('prepare().all() works without calling .bind() first', async () => {
    mockDb.getAllUsers.mockResolvedValue([{ id: '1', username: 'alice' }]);
    const result = await adapter.prepare('SELECT id, username FROM users ORDER BY created_at DESC').all();
    expect((result as any).results).toHaveLength(1);
  });

  it('prepare().first() works without calling .bind() first', async () => {
    mockDb.getUserCount.mockResolvedValue(5);
    const result = await adapter.prepare('SELECT COUNT(*) as count FROM users').first();
    expect((result as any)?.count).toBe(5);
  });
});

describe('D1Adapter — stats queries', () => {
  let mockDb: ReturnType<typeof makeMockDb>;
  let adapter: D1Adapter;

  beforeEach(() => {
    mockDb = makeMockDb();
    adapter = new D1Adapter(mockDb as any);
  });

  it('COUNT(*) on users calls getUserCount', async () => {
    mockDb.getUserCount.mockResolvedValue(42);
    const result = await adapter.prepare('SELECT COUNT(*) as count FROM users').bind().first();
    expect((result as any)?.count).toBe(42);
  });

  it('COUNT(*) on oauth_tokens calls getTokenCount', async () => {
    mockDb.getTokenCount.mockResolvedValue(7);
    const result = await adapter.prepare('SELECT COUNT(*) as count FROM oauth_tokens').bind().first();
    expect((result as any)?.count).toBe(7);
  });

  it('SUM calls getTotalStorage', async () => {
    mockDb.getTotalStorage.mockResolvedValue(1073741824);
    const result = await adapter.prepare('SELECT SUM(used_storage_bytes) as total FROM users').bind().first();
    expect((result as any)?.total).toBe(1073741824);
  });

  it('all() on users without WHERE calls getAllUsers', async () => {
    mockDb.getAllUsers.mockResolvedValue([{ id: '1', username: 'alice' }]);
    const result = await adapter.prepare('SELECT id, username FROM users ORDER BY created_at DESC LIMIT 100').bind().all();
    expect((result as any).results).toHaveLength(1);
  });
});

// ensureAccount must work against the offline LocalDatabase too, so run it
// through the adapter over an in-memory stand-in for LocalDatabase's users.
describe('D1Adapter — Account row lifecycle', () => {
  function usersDb(initial: string[] = []) {
    const users = new Set(initial);
    return {
      users,
      getUserByUsername: vi.fn(async (username: string) => users.has(username) ? { id: username, username } : null),
      getUserCount: vi.fn(async () => users.size),
      createUserIfAbsent: vi.fn(async (_id: string, username: string) => { users.add(username); }),
    };
  }

  it('creates the Account row in an empty table, once', async () => {
    const db = usersDb();
    const adapter = new D1Adapter(db as any);

    expect(await ensureAccount(adapter, 'alice')).toBe('ready');
    expect(await ensureAccount(adapter, 'alice')).toBe('ready');

    expect([...db.users]).toEqual(['alice']);
    expect(db.createUserIfAbsent).toHaveBeenCalledTimes(1);
  });

  it('reports a username mismatch without writing when other rows exist', async () => {
    const db = usersDb(['bob']);
    const adapter = new D1Adapter(db as any);

    expect(await ensureAccount(adapter, 'alice')).toBe('username_mismatch');

    expect([...db.users]).toEqual(['bob']);
    expect(db.createUserIfAbsent).not.toHaveBeenCalled();
  });
});
