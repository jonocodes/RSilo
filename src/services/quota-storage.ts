import type { StorageInterface } from '../types';
import { buildKey } from './r2';
import { conditionHolds, PathConflictError, PreconditionFailedError } from './storage-errors';
import { bumpFolderVersions } from './folder-etags';

export class QuotaExceededError extends Error {}
export class StorageAccountingError extends Error {}

type ExistingObject = Awaited<ReturnType<StorageInterface['head']>>;

/** The slice of D1 that accounting uses. The offline SQLite shim has it too, so both run the same SQL. */
interface UsageDatabase {
  prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<{ meta: { changes: number } }> } };
}

/** A request's preconditions as sent: If-Match is an ETag or `*`; only `If-None-Match: *` counts. */
export interface RequestCondition {
  ifMatch?: string;
  ifNoneMatch?: string;
}

interface PutObjectOptions {
  storage: StorageInterface;
  db: UsageDatabase | undefined;
  allowUnaccounted?: boolean;
  username: string;
  key: string;
  body: ArrayBuffer;
  contentType: string;
  condition?: RequestCondition;
}

interface DeleteObjectOptions {
  storage: StorageInterface;
  db: UsageDatabase | undefined;
  allowUnaccounted?: boolean;
  username: string;
  key: string;
  ifMatch?: string;
}

// How often a write is retried when another write to the same key lands
// between reading the object and changing it.
const MAX_ATTEMPTS = 3;

async function adjustUsage(db: UsageDatabase | undefined, username: string, delta: number, enforceQuota = true, allowUnaccounted = false): Promise<void> {
  if (!db || typeof db.prepare !== 'function') {
    if (allowUnaccounted) return;
    throw new StorageAccountingError('Storage accounting is not available');
  }
  if (delta === 0) return;

  // One statement, so the quota check and the update are atomic in D1 and SQLite alike.
  const quotaPredicate = enforceQuota && delta > 0
    ? ' AND used_storage_bytes + ? <= storage_quota_bytes'
    : '';
  let changes: number;
  try {
    const statement = db.prepare(
      `UPDATE users SET used_storage_bytes = MAX(0, used_storage_bytes + ?) WHERE username = ?${quotaPredicate}`
    );
    const bound = quotaPredicate
      ? statement.bind(delta, username, delta)
      : statement.bind(delta, username);
    changes = (await bound.run()).meta.changes;
  } catch (error) {
    throw new StorageAccountingError('Storage accounting is not available', { cause: error });
  }
  if (changes === 0) throw new QuotaExceededError('Storage quota exceeded');
}

// Invalidates the cached ETags of the folders above a document just written or
// deleted (folder-etags.ts). The write has already happened, so a failure is
// logged, not answered with 503: the client would retry a write that
// succeeded, and the retry (conditioned on the old ETag) would get 412 and
// invalidate nothing either. Those folder ETags then stay stale for at most
// FOLDER_ETAG_MAX_AGE_SECONDS, as after an edit made to the bucket directly.
// D1 being down is caught before the write: the usage update answers 503.
async function invalidateFolderEtags(db: UsageDatabase | undefined, username: string, key: string): Promise<void> {
  if (!db || typeof db.prepare !== 'function') return;
  try {
    await bumpFolderVersions(db, username, key);
  } catch (error) {
    console.error('Folder ETag invalidation failed', error);
  }
}

function requestConditionHolds(existing: ExistingObject, condition: RequestCondition | undefined): boolean {
  if (condition?.ifNoneMatch === '*' && existing) return false;
  if (condition?.ifMatch === '*') return existing !== null;
  return conditionHolds(existing, condition?.ifMatch ? { ifMatch: condition.ifMatch } : undefined);
}

// remoteStorage's 409: no folder on the path may be an existing document, and
// the document may not be an existing folder. Keys are flat in R2 and S3, so
// this costs one HEAD per ancestor folder and a one-key listing of the
// document's own folder (on B2, Class B and Class C calls), all in parallel.
async function assertNoPathConflict(storage: StorageInterface, username: string, key: string): Promise<void> {
  const root = buildKey(username, '');
  const ancestors = key.startsWith(root)
    ? key.slice(root.length).split('/').slice(0, -1).map((_, i, parts) => root + parts.slice(0, i + 1).join('/'))
    : [];
  const [documents, children] = await Promise.all([
    Promise.all(ancestors.map((ancestor) => storage.head(ancestor))),
    storage.list(key + '/', { limit: 1 }),
  ]);
  if (documents.some(Boolean) || children.objects.length > 0) throw new PathConflictError();
}

/**
 * Writes a document, keeping the Account's usage counter exact. Throws
 * PreconditionFailedError (412), PathConflictError (409), QuotaExceededError
 * (507) or StorageAccountingError (503).
 *
 * The write is conditioned on the object just read, so the usage delta is
 * always that of the object actually replaced; if another write got in
 * between, the request is evaluated again. S3 cannot enforce that condition
 * (s3.ts), so there only this HEAD guards it and two racing writes
 * can still both count.
 */
export async function putUserObject(options: PutObjectOptions): Promise<{ etag: string; created: boolean }> {
  for (let attempt = 1; ; attempt++) {
    const [existing] = await Promise.all([
      options.storage.head(options.key),
      assertNoPathConflict(options.storage, options.username, options.key),
    ]);
    if (!requestConditionHolds(existing, options.condition)) throw new PreconditionFailedError();

    const delta = options.body.byteLength - (existing?.contentLength ?? 0);
    await adjustUsage(options.db, options.username, delta, true, options.allowUnaccounted);
    try {
      const etag = await options.storage.put(options.key, options.body, options.contentType,
        existing ? { ifMatch: existing.etag } : { ifNoneMatch: '*' });
      await invalidateFolderEtags(options.db, options.username, options.key);
      return { etag, created: !existing };
    } catch (error) {
      await adjustUsage(options.db, options.username, -delta, false, options.allowUnaccounted);
      if (!(error instanceof PreconditionFailedError)) throw error;
      if (attempt === MAX_ATTEMPTS) throw new StorageAccountingError('The document kept changing during the write; try again');
    }
  }
}

/**
 * Deletes a document, keeping the usage counter exact as putUserObject does.
 * Returns the deleted object's ETag, or null when there was none. R2 and S3
 * cannot enforce the delete's condition, so two racing deletes there can
 * still both subtract (the counter never goes below 0).
 */
export async function deleteUserObject(options: DeleteObjectOptions): Promise<string | null> {
  for (let attempt = 1; ; attempt++) {
    const existing = await options.storage.head(options.key);
    if (options.ifMatch && !requestConditionHolds(existing, { ifMatch: options.ifMatch })) throw new PreconditionFailedError();
    if (!existing) return null;

    const delta = -existing.contentLength;
    await adjustUsage(options.db, options.username, delta, true, options.allowUnaccounted);
    try {
      await options.storage.delete(options.key, { ifMatch: existing.etag });
      await invalidateFolderEtags(options.db, options.username, options.key);
      return existing.etag;
    } catch (error) {
      await adjustUsage(options.db, options.username, -delta, false, options.allowUnaccounted);
      if (!(error instanceof PreconditionFailedError)) throw error;
      if (attempt === MAX_ATTEMPTS) throw new StorageAccountingError('The document kept changing during the delete; try again');
    }
  }
}
