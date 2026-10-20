import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync, readdirSync, renameSync, rmdirSync } from 'fs';
import { join, dirname, resolve, sep } from 'path';
import { randomUUID } from 'crypto';
import type { StorageGetOptions } from '../types';

export interface BlobMetadata {
  contentType: string;
  contentLength: number;
  etag: string;
  lastModified?: string;
}

// Offline stand-in for R2: each object is a file at <baseDir>/<key>, and its
// metadata a JSON file at <baseDir>/.meta/<key>.json. Keys always start with
// "users/", so the .meta tree can't collide with an object, and any item name
// (e.g. "x.meta", "a\b", ".hidden") is stored as is. Like R2, list() returns
// object keys only; folders exist only as prefixes of objects.
export class LocalStorage {
  private baseDir: string;
  private metaDir: string;

  constructor(baseDir?: string) {
    this.baseDir = resolve(baseDir || join(process.cwd(), 'data', 'storage'));
    this.metaDir = join(this.baseDir, '.meta');
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }
    this.migrateSidecars();
  }

  // Keys are made of item names checked by the routes (protocol/item-path.ts);
  // refuse anything that could still escape baseDir.
  private resolveKey(key: string, root = this.baseDir): string {
    const segments = key.replace(/^\//, '').replace(/\/$/, '').split('/');
    if (segments.some(s => s === '' || s === '.' || s === '..' || s.includes('\0'))) {
      throw new Error(`invalid storage key: ${JSON.stringify(key)}`);
    }
    const path = resolve(root, ...segments);
    if (!path.startsWith(root + sep)) {
      throw new Error(`invalid storage key: ${JSON.stringify(key)}`);
    }
    return path;
  }

  private metaPath(key: string): string {
    return this.resolveKey(key, this.metaDir) + '.json';
  }

  private readMeta(key: string, filePath: string): BlobMetadata {
    const stats = statSync(filePath);
    let metadata: BlobMetadata = {
      contentType: 'application/octet-stream',
      contentLength: stats.size,
      etag: `"${randomUUID().slice(0, 8)}"`,
      lastModified: stats.mtime.toISOString(),
    };
    const metaPath = this.metaPath(key);
    if (existsSync(metaPath)) {
      try {
        metadata = { ...metadata, ...JSON.parse(readFileSync(metaPath, 'utf-8')), contentLength: stats.size };
      } catch {}
    }
    return metadata;
  }

  async get(key: string, options?: StorageGetOptions): Promise<{ body: ArrayBuffer; metadata: BlobMetadata } | null> {
    const filePath = this.resolveKey(key);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      return null;
    }
    const metadata = this.readMeta(key, filePath);
    let body = readFileSync(filePath);
    if (options?.range) {
      body = body.subarray(options.range.offset, options.range.offset + options.range.length);
    }
    return { body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer, metadata };
  }

  async put(key: string, body: ArrayBuffer, contentType: string): Promise<string> {
    const filePath = this.resolveKey(key);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, Buffer.from(body));

    const etag = `"${randomUUID().slice(0, 8)}"`;
    const metadata: BlobMetadata = {
      contentType,
      contentLength: body.byteLength,
      etag,
      lastModified: statSync(filePath).mtime.toISOString(),
    };
    const metaPath = this.metaPath(key);
    mkdirSync(dirname(metaPath), { recursive: true });
    writeFileSync(metaPath, JSON.stringify(metadata));
    return etag;
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolveKey(key);
    if (existsSync(filePath)) unlinkSync(filePath);
    const metaPath = this.metaPath(key);
    if (existsSync(metaPath)) unlinkSync(metaPath);
    // An emptied folder no longer exists (draft-dejong-remotestorage §4)
    this.pruneEmptyDirs(dirname(filePath), this.baseDir);
    this.pruneEmptyDirs(dirname(metaPath), this.metaDir);
  }

  async head(key: string): Promise<BlobMetadata | null> {
    const filePath = this.resolveKey(key);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      return null;
    }
    return this.readMeta(key, filePath);
  }

  async list(prefix: string): Promise<{ objects: { key: string; size: number; etag: string; contentType?: string; lastModified?: string }[] }> {
    const objects: { key: string; size: number; etag: string; contentType?: string; lastModified?: string }[] = [];
    const keyPrefix = prefix.endsWith('/') ? prefix : prefix + '/';

    const walk = (dir: string, prefixKey: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        const key = prefixKey + entry.name;
        if (entry.isDirectory()) {
          walk(fullPath, key + '/');
        } else if (entry.isFile()) {
          const meta = this.readMeta(key, fullPath);
          objects.push({ key, size: meta.contentLength, etag: meta.etag, contentType: meta.contentType, lastModified: meta.lastModified });
        }
      }
    };

    const baseDir = this.resolveKey(keyPrefix);
    if (existsSync(baseDir) && statSync(baseDir).isDirectory()) walk(baseDir, keyPrefix);
    return { objects };
  }

  private pruneEmptyDirs(dir: string, root: string): void {
    while (dir.startsWith(root + sep) && existsSync(dir) && readdirSync(dir).length === 0) {
      rmdirSync(dir);
      dir = dirname(dir);
    }
  }

  // Older offline data kept metadata in a "<file>.meta" sidecar next to each
  // file, which hid documents named "*.meta". Move sidecars into .meta/.
  private migrateSidecars(): void {
    const usersDir = join(this.baseDir, 'users');
    if (!existsSync(usersDir)) return;
    const walk = (dir: string, prefixKey: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath, prefixKey + entry.name + '/');
        } else if (entry.name.endsWith('.meta')) {
          const owner = fullPath.slice(0, -'.meta'.length);
          if (!existsSync(owner) || !statSync(owner).isFile()) continue;
          const metaPath = this.metaPath(prefixKey + entry.name.slice(0, -'.meta'.length));
          mkdirSync(dirname(metaPath), { recursive: true });
          renameSync(fullPath, metaPath);
        }
      }
    };
    walk(usersDir, 'users/');
  }
}
