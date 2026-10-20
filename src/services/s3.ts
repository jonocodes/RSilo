import { AwsClient } from 'aws4fetch';
import type { S3Config } from '../config';
import type { StorageGetOptions, StorageInterface } from '../types';
import type { BlobMetadata } from './r2';

// StorageInterface over any S3-compatible API (ADR-0005): Backblaze B2, AWS S3,
// MinIO, R2's own S3 endpoint, and so on. Requests are path-style
// (<endpoint>/<bucket>/<key>) and signed with SigV4 via aws4fetch, which uses
// only fetch and WebCrypto, so the same code runs in the Worker and offline.

/** A failed S3 request. Carries the status and S3 error code, never credentials. */
export class S3StorageError extends Error {
  constructor(readonly operation: string, readonly status: number, readonly code: string | null) {
    super(`S3 ${operation} failed with HTTP ${status}${code ? ` (${code})` : ''}`);
  }
}

type FetchLike = (request: Request) => Promise<Response>;

export class S3Storage implements StorageInterface {
  private client: AwsClient;
  private bucketUrl: string;

  constructor(config: S3Config, private fetchImpl: FetchLike = (request) => fetch(request)) {
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: 's3',
      region: config.region,
      retries: 0,
    });
    this.bucketUrl = `${config.endpoint}/${encodeURIComponent(config.bucket)}`;
  }

  async get(key: string, options?: StorageGetOptions): Promise<{ body: ReadableStream<Uint8Array> | ArrayBuffer; metadata: BlobMetadata } | null> {
    const range = options?.range;
    const response = await this.send('GET', this.objectUrl(key), range
      ? { headers: { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } }
      : {});
    if (response.status === 404) return null;
    await this.ensureOk('GET', response);
    const metadata = metadataFrom(response.headers);
    // A 206 carries the range's length; the full size is after the "/".
    const total = /\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '');
    if (response.status === 206 && total) metadata.contentLength = Number(total[1]);
    return { body: response.body ?? new ArrayBuffer(0), metadata };
  }

  async put(key: string, body: ArrayBuffer, contentType: string): Promise<string> {
    const response = await this.send('PUT', this.objectUrl(key), {
      body,
      headers: { 'Content-Type': contentType },
    });
    await this.ensureOk('PUT', response);
    await response.body?.cancel();
    const etag = response.headers.get('ETag');
    if (!etag) throw new S3StorageError('PUT', response.status, 'MissingETag');
    return etag;
  }

  async delete(key: string): Promise<void> {
    const response = await this.send('DELETE', this.objectUrl(key));
    if (response.status === 404) return;
    await this.ensureOk('DELETE', response);
    await response.body?.cancel();
  }

  async head(key: string): Promise<BlobMetadata | null> {
    const response = await this.send('HEAD', this.objectUrl(key));
    if (response.status === 404) return null;
    await this.ensureOk('HEAD', response);
    return metadataFrom(response.headers);
  }

  async list(prefix: string): Promise<{ objects: { key: string; size: number; etag: string; contentType?: string; lastModified?: string }[] }> {
    const objects: { key: string; size: number; etag: string; lastModified?: string }[] = [];
    let token: string | undefined;

    do {
      const url = new URL(this.bucketUrl);
      url.searchParams.set('list-type', '2');
      url.searchParams.set('prefix', prefix);
      // Keys may hold characters XML 1.0 can't carry (control characters,
      // allowed in item names), so have them URL-encoded in the listing.
      url.searchParams.set('encoding-type', 'url');
      if (token) url.searchParams.set('continuation-token', token);

      const response = await this.send('GET', url.href);
      await this.ensureOk('LIST', response);
      const xml = await response.text();

      for (const [, entry] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const lastModified = xmlField(entry, 'LastModified');
        objects.push({
          key: decodeListedKey(xmlField(entry, 'Key') ?? ''),
          size: Number(xmlField(entry, 'Size') ?? 0),
          etag: xmlField(entry, 'ETag') ?? '',
          lastModified: lastModified ? new Date(lastModified).toISOString() : undefined,
        });
      }

      if (xmlField(xml, 'IsTruncated') !== 'true') break;
      token = xmlField(xml, 'NextContinuationToken') ?? undefined;
      if (!token) throw new S3StorageError('LIST', response.status, 'TruncatedWithoutToken');
    } while (token);

    return { objects };
  }

  private objectUrl(key: string): string {
    return `${this.bucketUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  private async send(method: string, url: string, init: { body?: ArrayBuffer; headers?: Record<string, string> } = {}): Promise<Response> {
    const signed = await this.client.sign(url, { method, ...init });
    return this.fetchImpl(signed);
  }

  private async ensureOk(operation: string, response: Response): Promise<void> {
    if (response.ok) return;
    const body = operation === 'HEAD' ? '' : await response.text().catch(() => '');
    throw new S3StorageError(operation, response.status, xmlField(body, 'Code'));
  }
}

// Keys in a ListObjectsV2 response with encoding-type=url: form-style
// percent-encoding, where "+" stands for a space (a literal "+" is %2B).
function decodeListedKey(key: string): string {
  return decodeURIComponent(key.replace(/\+/g, ' '));
}

function metadataFrom(headers: Headers): BlobMetadata {
  const lastModified = headers.get('Last-Modified');
  return {
    contentType: headers.get('Content-Type') || 'application/octet-stream',
    contentLength: Number(headers.get('Content-Length') ?? 0),
    etag: headers.get('ETag') ?? '',
    lastModified: lastModified ? new Date(lastModified).toISOString() : undefined,
  };
}

function xmlField(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? decodeXml(match[1]) : null;
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    if (entity[0] === '#') {
      return String.fromCodePoint(entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10));
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity]!;
  });
}
