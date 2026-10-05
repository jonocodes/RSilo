import type { StorageInterface } from '../types';

export class QuotaExceededError extends Error {}
export class StorageAccountingError extends Error {}

type ExistingObject = Awaited<ReturnType<StorageInterface['head']>>;

interface PutObjectOptions {
  storage: StorageInterface;
  db: any;
  allowUnaccounted?: boolean;
  username: string;
  key: string;
  body: ArrayBuffer;
  contentType: string;
  existing: ExistingObject;
}

interface DeleteObjectOptions {
  storage: StorageInterface;
  db: any;
  allowUnaccounted?: boolean;
  username: string;
  key: string;
  existing: NonNullable<ExistingObject>;
}

async function adjustUsage(db: any, username: string, delta: number, enforceQuota = true, allowUnaccounted = false): Promise<void> {
  if (!db || typeof db.prepare !== 'function') {
    if (allowUnaccounted) return;
    throw new StorageAccountingError('Storage accounting is not available');
  }
  if (delta === 0) return;

  if (typeof db.adjustStorageUsage === 'function') {
    const adjusted = await db.adjustStorageUsage(username, delta, enforceQuota);
    if (!adjusted) throw new QuotaExceededError('Storage quota exceeded');
    return;
  }

  const quotaPredicate = enforceQuota && delta > 0
    ? ' AND used_storage_bytes + ? <= storage_quota_bytes'
    : '';
  const statement = db.prepare(
    `UPDATE users SET used_storage_bytes = MAX(0, used_storage_bytes + ?) WHERE username = ?${quotaPredicate}`
  );
  const bound = quotaPredicate
    ? statement.bind(delta, username, delta)
    : statement.bind(delta, username);
  const result = await bound.run();
  if (result?.meta?.changes === 0) throw new QuotaExceededError('Storage quota exceeded');
}

export async function putUserObject(options: PutObjectOptions): Promise<string> {
  const oldSize = options.existing?.contentLength || 0;
  const delta = options.body.byteLength - oldSize;
  await adjustUsage(options.db, options.username, delta, true, options.allowUnaccounted);

  try {
    return await options.storage.put(options.key, options.body, options.contentType);
  } catch (error) {
    await adjustUsage(options.db, options.username, -delta, false, options.allowUnaccounted);
    throw error;
  }
}

export async function deleteUserObject(options: DeleteObjectOptions): Promise<void> {
  const delta = -(options.existing.contentLength || 0);
  await adjustUsage(options.db, options.username, delta, true, options.allowUnaccounted);

  try {
    await options.storage.delete(options.key);
  } catch (error) {
    await adjustUsage(options.db, options.username, -delta, false, options.allowUnaccounted);
    throw error;
  }
}
