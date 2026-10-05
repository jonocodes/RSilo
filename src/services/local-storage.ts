import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';

export interface BlobMetadata {
  contentType: string;
  contentLength: number;
  etag: string;
  lastModified?: string;
}

export class LocalStorage {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || join(process.cwd(), 'data', 'storage');
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }
  }

  private resolveKey(key: string): string {
    const sanitized = key.replace(/^\//, '').replace(/\.\./g, '');
    return join(this.baseDir, sanitized);
  }

  async get(key: string): Promise<{ body: ArrayBuffer; metadata: BlobMetadata } | null> {
    const filePath = this.resolveKey(key);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      return null;
    }

    const body = readFileSync(filePath);
    const stats = statSync(filePath);
    const metaPath = filePath + '.meta';

    let metadata: BlobMetadata = {
      contentType: 'application/octet-stream',
      contentLength: body.byteLength,
      etag: `"${randomUUID().slice(0, 8)}"`,
      lastModified: stats.mtime.toISOString(),
    };

    if (existsSync(metaPath)) {
      try {
        const storedMeta = JSON.parse(readFileSync(metaPath, 'utf-8'));
        metadata = { ...metadata, ...storedMeta };
      } catch {}
    }

    return { body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength), metadata };
  }

  async put(key: string, body: ArrayBuffer, contentType: string): Promise<string> {
    const filePath = this.resolveKey(key);
    const dir = dirname(filePath);

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(filePath, Buffer.from(body));

    const stats = statSync(filePath);
    const etag = `"${randomUUID().slice(0, 8)}"`;
    const metadata: BlobMetadata = {
      contentType,
      contentLength: body.byteLength,
      etag,
      lastModified: stats.mtime.toISOString(),
    };

    writeFileSync(filePath + '.meta', JSON.stringify(metadata));

    return etag;
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolveKey(key);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    const metaPath = filePath + '.meta';
    if (existsSync(metaPath)) {
      unlinkSync(metaPath);
    }
  }

  async head(key: string): Promise<BlobMetadata | null> {
    const filePath = this.resolveKey(key);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      return null;
    }

    const stats = statSync(filePath);
    const metaPath = filePath + '.meta';

    let metadata: BlobMetadata = {
      contentType: 'application/octet-stream',
      contentLength: stats.size,
      etag: `"${randomUUID().slice(0, 8)}"`,
      lastModified: stats.mtime.toISOString(),
    };

    if (existsSync(metaPath)) {
      try {
        const storedMeta = JSON.parse(readFileSync(metaPath, 'utf-8'));
        metadata = { ...metadata, ...storedMeta };
      } catch {}
    }

    return metadata;
  }

  async list(prefix: string): Promise<{ objects: { key: string; size: number; etag: string; contentType?: string; lastModified?: string }[] }> {
    const objects: { key: string; size: number; etag: string; contentType?: string; lastModified?: string }[] = [];
    const keyPrefix = prefix.endsWith('/') ? prefix : prefix + '/';
    const baseDir = this.resolveKey(keyPrefix);

    const walk = (dir: string, prefixKey: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.endsWith('.meta')) continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          objects.push({
            key: (prefixKey + entry.name + '/').replace(/\\/g, '/'),
            size: 0,
            etag: '',
            lastModified: statSync(fullPath).mtime.toISOString(),
          });
          walk(fullPath, prefixKey + entry.name + '/');
        } else {
          const stats = statSync(fullPath);
          const metaPath = fullPath + '.meta';
          let etag = `"${randomUUID().slice(0, 8)}"`;
          let contentType = 'application/octet-stream';

          if (existsSync(metaPath)) {
            try {
              const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
              etag = meta.etag || etag;
              contentType = meta.contentType || contentType;
            } catch {}
          }

          objects.push({
            key: (prefixKey + entry.name).replace(/\\/g, '/'),
            size: stats.size,
            etag,
            contentType,
            lastModified: stats.mtime.toISOString(),
          });
        }
      }
    };

    walk(baseDir, keyPrefix);

    return { objects };
  }
}