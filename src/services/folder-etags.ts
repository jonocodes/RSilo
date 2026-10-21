import { buildKey } from './r2';

// The folder ETag cache (migration 0007; see handleFolderGet in
// routes/storage.ts). Rows are keyed by the Account's username and the folder
// path below the storage root, with a trailing `/` ('' for the root).

/**
 * How long a cached folder ETag is trusted. Writes through RSilo invalidate it
 * at once; this bounds how long a change made to the bucket directly (an
 * rclone restore, say) can go unseen in folder ETags.
 */
export const FOLDER_ETAG_MAX_AGE_SECONDS = 3600;

/** The slice of D1 the cache uses; the offline SQLite shim has it too. */
export interface FolderEtagDatabase {
  prepare(sql: string): {
    bind(...values: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<unknown> };
  };
}

/** What invalidation needs: writes only. */
type WriteDatabase = { prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } } };

export interface CachedFolder {
  /** The folder's version, read before listing it; 0 when it has no row. */
  version: number;
  /** The cached ETag (unquoted), or null when there is none or it is no longer valid. */
  etag: string | null;
}

interface FolderEtagRow {
  version: number;
  etag: string | null;
  etag_version: number | null;
  cached_at: number | null;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export async function readFolderEtag(db: FolderEtagDatabase, username: string, path: string): Promise<CachedFolder> {
  const row = await db.prepare(
    'SELECT version, etag, etag_version, cached_at FROM folder_etags WHERE user_id = ? AND path = ?'
  ).bind(username, path).first<FolderEtagRow>();
  if (!row) return { version: 0, etag: null };
  const valid = row.etag !== null && row.etag_version === row.version
    && row.cached_at !== null && row.cached_at > nowSeconds() - FOLDER_ETAG_MAX_AGE_SECONDS;
  return { version: row.version, etag: valid ? row.etag : null };
}

/**
 * Caches an ETag computed from a listing, as of `version` (read before the
 * listing). Compare-and-set: if a write bumped the version since, nothing is
 * stored, so an ETag that may predate that write is never cached.
 */
export async function storeFolderEtag(db: FolderEtagDatabase, username: string, path: string, version: number, etag: string): Promise<void> {
  await db.prepare(
    `INSERT INTO folder_etags (user_id, path, version, etag, etag_version, cached_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, path) DO UPDATE SET etag = excluded.etag, etag_version = excluded.etag_version, cached_at = excluded.cached_at
     WHERE folder_etags.version = excluded.version`
  ).bind(username, path, version, etag, version, nowSeconds()).run();
}

/**
 * Invalidates the cached ETag of every folder above a document (the root,
 * `a/`, `a/b/`, ...) after it was written or deleted, in one statement. Two
 * bound values per folder, so this stays under D1's 100 for paths up to 49
 * folders deep.
 */
export async function bumpFolderVersions(db: WriteDatabase, username: string, key: string): Promise<void> {
  const root = buildKey(username, '');
  if (!key.startsWith(root)) return;
  const folders = key.slice(root.length).split('/').slice(0, -1);
  const paths = ['', ...folders.map((_, i) => folders.slice(0, i + 1).join('/') + '/')];
  await db.prepare(
    `INSERT INTO folder_etags (user_id, path, version) VALUES ${paths.map(() => '(?, ?, 1)').join(', ')}
     ON CONFLICT (user_id, path) DO UPDATE SET version = folder_etags.version + 1`
  ).bind(...paths.flatMap((path) => [username, path])).run();
}
