// PROTOTYPE — throwaway. The remoteStorage tree lives in D1; a BlobStore only
// keeps opaque blobs by ID. Implements the same StorageInterface the routes use,
// so routes, quota accounting and folder ETags are unchanged.
import type { StorageGetOptions, StorageInterface, WriteCondition } from '../../src/types';
import { normalizeETag } from '../../src/protocol/constants';
import { PreconditionFailedError } from '../../src/services/storage-errors';

/** All a backend has to do. IDs are opaque, flat, ASCII and never reused. */
export interface BlobStore {
  put(id: string, body: ArrayBuffer): Promise<void>;
  get(id: string, range?: { offset: number; length: number }): Promise<ReadableStream<Uint8Array> | ArrayBuffer>;
  /** Deletes blobs that are no longer referenced; missing ones are fine. Runs off the request path. */
  deleteMany(ids: string[]): Promise<void>;
}

interface Row {
  key: string;
  blob_id: string;
  etag: string;
  content_type: string;
  size: number;
  last_modified: string;
}

// The D1 slice used here; the offline SQLite shim has the same shape.
interface Db {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results: T[] }>;
      run(): Promise<{ meta: { changes: number } }>;
    };
  };
}

export const SCHEMA = [`CREATE TABLE IF NOT EXISTS prototype_blob_index (
  key TEXT PRIMARY KEY,
  blob_id TEXT NOT NULL,
  etag TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  last_modified TEXT NOT NULL
)`, `CREATE TABLE IF NOT EXISTS prototype_blob_garbage (blob_id TEXT PRIMARY KEY)`];

async function contentEtag(body: ArrayBuffer): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
  return `"${Array.from(hash.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('')}"`;
}

export class IndexedStorage implements StorageInterface {
  constructor(private db: Db, private blobs: BlobStore) {}

  // Unreferenced blobs are queued, not deleted inline: a backend delete is a
  // write that can be rate limited (Dropbox 429s concurrent deletes), and
  // nothing a client sees depends on it. collect() drains the queue in batches.
  private async trash(blobId: string) {
    await this.db.prepare('INSERT INTO prototype_blob_garbage VALUES (?) ON CONFLICT DO NOTHING').bind(blobId).run();
  }

  /** Deletes queued blobs; returns how many. A Cron Trigger or waitUntil would call this on a Worker. */
  async collect(max = 1000): Promise<number> {
    const { results } = await this.db.prepare('SELECT blob_id FROM prototype_blob_garbage LIMIT ?').bind(max).all<{ blob_id: string }>();
    const ids = results.map((r) => r.blob_id);
    if (!ids.length) return 0;
    await this.blobs.deleteMany(ids);
    for (const id of ids) await this.db.prepare('DELETE FROM prototype_blob_garbage WHERE blob_id = ?').bind(id).run();
    return ids.length;
  }

  private row(key: string): Promise<Row | null> {
    return this.db.prepare('SELECT * FROM prototype_blob_index WHERE key = ?').bind(key).first<Row>();
  }

  async head(key: string) {
    const row = await this.row(key);
    return row && { contentType: row.content_type, contentLength: row.size, etag: row.etag, lastModified: row.last_modified };
  }

  async get(key: string, options?: StorageGetOptions) {
    const row = await this.row(key);
    if (!row) return null;
    const body = await this.blobs.get(row.blob_id, options?.range);
    return { body, metadata: { contentType: row.content_type, contentLength: row.size, etag: row.etag, lastModified: row.last_modified } };
  }

  // The blob is written first under a fresh ID; the index row then flips to it
  // in one conditional statement, so If-Match / If-None-Match are atomic on every
  // backend. A lost race leaves an orphan blob, which is deleted here.
  async put(key: string, body: ArrayBuffer, contentType: string, condition?: WriteCondition): Promise<string> {
    const etag = await contentEtag(body);
    const blobId = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.blobs.put(blobId, body);

    const previous = await this.row(key);
    let changes: number;
    if (condition?.ifNoneMatch === '*' || (!previous && !condition?.ifMatch)) {
      changes = (await this.db.prepare(
        `INSERT INTO prototype_blob_index VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING`,
      ).bind(key, blobId, etag, contentType, body.byteLength, now).run()).meta.changes;
    } else {
      if (!previous || (condition?.ifMatch && normalizeETag(previous.etag) !== normalizeETag(condition.ifMatch))) changes = 0;
      else changes = (await this.db.prepare(
        `UPDATE prototype_blob_index SET blob_id = ?, etag = ?, content_type = ?, size = ?, last_modified = ?
         WHERE key = ? AND blob_id = ?`,
      ).bind(blobId, etag, contentType, body.byteLength, now, key, previous.blob_id).run()).meta.changes;
    }
    if (changes === 0) {
      await this.trash(blobId);
      throw new PreconditionFailedError();
    }
    if (previous) await this.trash(previous.blob_id);
    return etag;
  }

  async delete(key: string, condition?: { ifMatch: string }): Promise<void> {
    const row = await this.row(key);
    if (!row) return;
    if (condition && normalizeETag(row.etag) !== normalizeETag(condition.ifMatch)) throw new PreconditionFailedError();
    const { changes } = (await this.db.prepare('DELETE FROM prototype_blob_index WHERE key = ? AND blob_id = ?')
      .bind(key, row.blob_id).run()).meta;
    if (changes === 0) throw new PreconditionFailedError();
    await this.trash(row.blob_id);
  }

  async list(prefix: string, options: { limit?: number } = {}) {
    const { results } = await this.db.prepare(
      `SELECT key, size, etag, content_type, last_modified FROM prototype_blob_index
       WHERE substr(key, 1, ?) = ? ORDER BY key LIMIT ?`,
    ).bind(prefix.length, prefix, options.limit ?? -1).all<Row>();
    return {
      objects: results.map((r) => ({ key: r.key, size: r.size, etag: r.etag, contentType: r.content_type, lastModified: r.last_modified })),
    };
  }
}
