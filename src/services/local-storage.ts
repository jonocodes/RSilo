import { mkdirSync } from 'node:fs';
import { mkdir, readFile, readdir, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type { StorageInterface } from '../types';

// The offline (dev-only) Storage backend: one file per object under baseDir.
//
// Each key segment is percent-encoded byte by byte, keeping only a-z, 0-9,
// '-', '_' and any '.' but a leading one. Distinct keys therefore never share
// a file, even on a case-insensitive filesystem, and no segment is '..' or
// starts with '.'. Content type and ETag live in a parallel tree under
// `.meta/`, a name no key can produce.

type Metadata = NonNullable<Awaited<ReturnType<StorageInterface['head']>>>;
type Listing = Awaited<ReturnType<StorageInterface['list']>>;
type ListedObject = Listing['objects'][number];

const META_DIR = '.meta';
const KEPT = /[a-z0-9_-]/;

function encodeSegment(segment: string): string {
  if (!segment) throw new Error('Storage keys cannot have empty segments');
  let encoded = '';
  for (const byte of new TextEncoder().encode(segment)) {
    const char = String.fromCharCode(byte);
    encoded += KEPT.test(char) || (char === '.' && encoded) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return encoded;
}

/** The key segment a file name encodes, or null for a name RSilo did not write. */
function decodeSegment(name: string): string | null {
  try {
    const segment = decodeURIComponent(name);
    return encodeSegment(segment) === name ? segment : null;
  } catch {
    return null;
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
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

  constructor(baseDir?: string) {
    this.baseDir = resolve(baseDir || join('data', 'storage'));
    mkdirSync(this.baseDir, { recursive: true });
  }

  private dataPath(key: string): string {
    return join(this.baseDir, ...key.split('/').map(encodeSegment));
  }

  private metaPath(key: string): string {
    return join(this.baseDir, META_DIR, ...key.split('/').map(encodeSegment));
  }

  private async metadata(key: string, stats: Stats): Promise<Metadata> {
    let stored: { contentType?: string; etag?: string } = {};
    try {
      stored = JSON.parse(await readFile(this.metaPath(key), 'utf-8'));
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

  async get(key: string): Promise<{ body: ArrayBuffer; metadata: Metadata } | null> {
    const path = this.dataPath(key);
    const stats = await fileStats(path);
    if (!stats) return null;
    try {
      const body = Uint8Array.from(await readFile(path)).buffer;
      return { body, metadata: await this.metadata(key, stats) };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async put(key: string, body: ArrayBuffer, contentType: string): Promise<string> {
    const path = this.dataPath(key);
    const metaPath = this.metaPath(key);
    const bytes = new Uint8Array(body);
    const etag = `"${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}"`;

    await mkdir(dirname(path), { recursive: true });
    await mkdir(dirname(metaPath), { recursive: true });
    await writeFile(path, bytes);
    await writeFile(metaPath, JSON.stringify({ contentType, etag }));
    return etag;
  }

  async delete(key: string): Promise<void> {
    const path = this.dataPath(key);
    const metaPath = this.metaPath(key);
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
  }

  private async removeEmptyParents(dir: string): Promise<void> {
    while (dir.length > this.baseDir.length && dir.startsWith(this.baseDir)) {
      try {
        await rmdir(dir);
      } catch {
        return; // not empty (or already gone)
      }
      dir = dirname(dir);
    }
  }

  async head(key: string): Promise<Metadata | null> {
    const stats = await fileStats(this.dataPath(key));
    return stats ? this.metadata(key, stats) : null;
  }

  async list(prefix: string): Promise<Listing> {
    // Walk the deepest folder the prefix names, then keep keys that match it.
    const folderKey = prefix.slice(0, prefix.lastIndexOf('/') + 1);
    const folderPath = folderKey ? this.dataPath(folderKey.slice(0, -1)) : this.baseDir;
    const objects: ListedObject[] = [];
    await this.walk(folderPath, folderKey, objects);
    return {
      objects: objects
        .filter(object => object.key.startsWith(prefix))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
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
      const segment = decodeSegment(entry.name);
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
