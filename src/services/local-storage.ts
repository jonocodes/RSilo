import { mkdirSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type { StorageGetOptions, StorageInterface, WriteCondition } from '../types';
import { conditionHolds, KeyTooLongError, PathConflictError, PreconditionFailedError } from './storage-errors';

// The offline (dev-only) Storage backend: one file per object under baseDir.
//
// Each key segment is percent-encoded byte by byte, keeping only a-z, 0-9,
// '-', '_' and any '.' but a leading one. Distinct keys therefore never share
// a file, even on a case-insensitive filesystem, and no segment is '..' or
// starts with '.'. Content type and ETag live in a parallel tree under
// `.meta/`, a name no key can produce.
//
// A file name holds at most 255 bytes, so a segment whose encoding is longer
// is stored as the start of its encoding, '~' (which encoding never keeps) and
// the SHA-256 of the segment. `.meta/.names/<sha256>` holds the segment
// itself, for listings. Name records stay after a delete: they are small and
// every key with that segment shares one.

type Metadata = NonNullable<Awaited<ReturnType<StorageInterface['head']>>>;
type Listing = Awaited<ReturnType<StorageInterface['list']>>;
type ListedObject = Listing['objects'][number];

const META_DIR = '.meta';
const NAMES_DIR = join(META_DIR, '.names');
const KEPT = /[a-z0-9_-]/;
const MAX_NAME_BYTES = 255;
const SHORTENED_PREFIX_BYTES = 128;
const SHORTENED = /~([0-9a-f]{64})$/;

function encodeSegment(segment: string): string {
  if (!segment) throw new Error('Storage keys cannot have empty segments');
  let encoded = '';
  for (const byte of new TextEncoder().encode(segment)) {
    const char = String.fromCharCode(byte);
    encoded += KEPT.test(char) || (char === '.' && encoded) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return encoded;
}

/** The file name for a key segment. */
function fileName(segment: string): string {
  const encoded = encodeSegment(segment);
  if (encoded.length <= MAX_NAME_BYTES) return encoded;
  const prefix = encoded.slice(0, SHORTENED_PREFIX_BYTES).replace(/%[0-9A-F]?$/, '');
  return `${prefix}~${createHash('sha256').update(segment).digest('hex')}`;
}

/** Whether `name` is the file name for `segment`. */
function namesSegment(name: string, segment: string): boolean {
  try {
    return fileName(segment) === name;
  } catch {
    return false; // an empty segment
  }
}

/** The key segment a (not shortened) file name encodes, or null for a name RSilo did not write. */
function decodeSegment(name: string): string | null {
  try {
    const segment = decodeURIComponent(name);
    return namesSegment(name, segment) ? segment : null;
  } catch {
    return null;
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

// A path too long to exist names nothing.
function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENAMETOOLONG';
}

async function fileStats(path: string): Promise<Stats | null> {
  try {
    const stats = await stat(path);
    return stats.isFile() ? stats : null;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export class LocalStorage implements StorageInterface {
  private baseDir: string;
  private locks = new Map<string, Promise<void>>();

  constructor(baseDir?: string) {
    this.baseDir = resolve(baseDir || join('data', 'storage'));
    mkdirSync(this.baseDir, { recursive: true });
  }

  private dataPath(key: string): string {
    return join(this.baseDir, ...key.split('/').map(fileName));
  }

  private metaPath(key: string): string {
    return join(this.baseDir, META_DIR, ...key.split('/').map(fileName));
  }

  private namePath(hash: string): string {
    return join(this.baseDir, NAMES_DIR, hash);
  }

  /** The segment recorded for a shortened name's hash, or null. */
  private async recordedSegment(hash: string): Promise<string | null> {
    try {
      return await readFile(this.namePath(hash), 'utf-8');
    } catch {
      return null;
    }
  }

  // Keys that share a segment share its record, so no key lock covers it:
  // each record is written whole (a rename), and rewritten if it is wrong.
  private async recordNames(key: string): Promise<void> {
    for (const segment of key.split('/')) {
      const hash = SHORTENED.exec(fileName(segment))?.[1];
      if (!hash || (await this.recordedSegment(hash)) === segment) continue;
      const temp = this.namePath(`${hash}.${randomUUID()}`);
      await mkdir(dirname(temp), { recursive: true });
      await writeFile(temp, segment);
      await rename(temp, this.namePath(hash));
    }
  }

  /** The key segment a directory entry stands for, or null for one RSilo did not write. */
  private async entrySegment(name: string): Promise<string | null> {
    const hash = SHORTENED.exec(name)?.[1];
    if (!hash) return decodeSegment(name);
    const segment = await this.recordedSegment(hash);
    return segment !== null && namesSegment(name, segment) ? segment : null;
  }

  private async metadata(key: string, stats: Stats): Promise<Metadata> {
    let stored: { contentType?: string; etag?: string } = {};
    try {
      stored = JSON.parse(await readFile(this.metaPath(key), 'utf-8')) as typeof stored;
    } catch {
      // No (readable) metadata, e.g. a file copied in by hand: fall back to
      // an ETag that still changes only when the file does.
    }
    return {
      contentType: stored.contentType || 'application/octet-stream',
      contentLength: stats.size,
      etag: stored.etag || `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs * 1000).toString(16)}"`,
      lastModified: stats.mtime.toISOString(),
    };
  }

  async get(key: string, options?: StorageGetOptions): Promise<{ body: ArrayBuffer; metadata: Metadata } | null> {
    const path = this.dataPath(key);
    const stats = await fileStats(path);
    if (!stats) return null;
    try {
      let bytes = await readFile(path);
      if (options?.range) bytes = bytes.subarray(options.range.offset, options.range.offset + options.range.length);
      const body = Uint8Array.from(bytes).buffer;
      return { body, metadata: await this.metadata(key, stats) };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  // One write or delete per key at a time, so a condition is checked and the
  // change made with nothing in between. Enough for the one offline process.
  private async locked<T>(key: string, change: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(key) ?? Promise.resolve()).then(change);
    const tail = run.then(() => {}, () => {});
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  async put(key: string, body: ArrayBuffer, contentType: string, condition?: WriteCondition): Promise<string> {
    const path = this.dataPath(key);
    const metaPath = this.metaPath(key);
    const bytes = new Uint8Array(body);
    const etag = `"${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}"`;

    return this.locked(key, async () => {
      if (condition && !conditionHolds(await this.head(key), condition)) throw new PreconditionFailedError();
      await this.recordNames(key);
      try {
        await mkdir(dirname(path), { recursive: true });
        await mkdir(dirname(metaPath), { recursive: true });
        // Open the metadata file, the longer path, before writing anything,
        // so a path over the filesystem's limit stores nothing.
        await (await open(metaPath, 'a')).close();
        await writeFile(path, bytes);
      } catch (error) {
        // A file cannot also be a directory, nor sit inside a file.
        const code = errorCode(error);
        if (code === 'EEXIST' || code === 'ENOTDIR' || code === 'EISDIR') throw new PathConflictError();
        if (code === 'ENAMETOOLONG') {
          await this.removeEmptyParents(dirname(path));
          await this.removeEmptyParents(dirname(metaPath));
          throw new KeyTooLongError();
        }
        throw error;
      }
      await writeFile(metaPath, JSON.stringify({ contentType, etag }));
      return etag;
    });
  }

  async delete(key: string, condition?: { ifMatch: string }): Promise<void> {
    const path = this.dataPath(key);
    const metaPath = this.metaPath(key);
    return this.locked(key, async () => {
      if (condition && !conditionHolds(await this.head(key), condition)) throw new PreconditionFailedError();
      if (!(await fileStats(path))) return;
      for (const file of [path, metaPath]) {
        try {
          await unlink(file);
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      // Folders exist only while they hold documents.
      await this.removeEmptyParents(dirname(path));
      await this.removeEmptyParents(dirname(metaPath));
    });
  }

  private async removeEmptyParents(dir: string): Promise<void> {
    while (dir.length > this.baseDir.length && dir.startsWith(this.baseDir)) {
      try {
        await rmdir(dir);
      } catch (error) {
        if (!isMissing(error)) return; // not empty
      }
      dir = dirname(dir);
    }
  }

  async head(key: string): Promise<Metadata | null> {
    const stats = await fileStats(this.dataPath(key));
    return stats ? this.metadata(key, stats) : null;
  }

  async list(prefix: string, options: { limit?: number } = {}): Promise<Listing> {
    // Walk the deepest folder the prefix names, then keep keys that match it.
    const folderKey = prefix.slice(0, prefix.lastIndexOf('/') + 1);
    const folderPath = folderKey ? this.dataPath(folderKey.slice(0, -1)) : this.baseDir;
    const objects: ListedObject[] = [];
    await this.walk(folderPath, folderKey, objects);
    return {
      objects: objects
        .filter(object => object.key.startsWith(prefix))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .slice(0, options.limit),
    };
  }

  private async walk(dir: string, keyPrefix: string, objects: ListedObject[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    await Promise.all(entries.map(async (entry) => {
      const segment = await this.entrySegment(entry.name);
      if (segment === null) return; // `.meta/` and anything RSilo did not write
      const key = keyPrefix + segment;
      if (entry.isDirectory()) return this.walk(join(dir, entry.name), key + '/', objects);
      const stats = entry.isFile() ? await fileStats(join(dir, entry.name)) : null;
      if (!stats) return;
      const { contentType, etag, lastModified } = await this.metadata(key, stats);
      objects.push({ key, size: stats.size, etag, contentType, lastModified });
    }));
  }
}
