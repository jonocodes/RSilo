// An in-memory S3 endpoint for tests: path-style object GET/HEAD/PUT/DELETE and
// ListObjectsV2 with pagination, answering the way S3 does (quoted ETags,
// XML-escaped listing). It checks requests are SigV4-signed for the bucket's
// access key but does not verify signatures; test/s3-live.test.ts covers that
// against a real S3 server.

export interface FakeS3Object {
  body: Uint8Array;
  contentType: string;
  etag: string;
  lastModified: Date;
}

export interface FakeS3 {
  fetch: (request: Request) => Promise<Response>;
  objects: Map<string, FakeS3Object>;
  requests: Request[];
}

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => XML_ESCAPES[char]);
}

async function etagOf(body: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
  return `"${Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('')}"`;
}

function s3Error(status: number, code: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>x</Message></Error>`, {
    status,
    headers: { 'Content-Type': 'application/xml' },
  });
}

export function createFakeS3(options: { bucket: string; accessKeyId: string; pageSize?: number }): FakeS3 {
  const objects = new Map<string, FakeS3Object>();
  const requests: Request[] = [];
  const pageSize = options.pageSize ?? 1000;

  async function handle(request: Request): Promise<Response> {
    requests.push(request.clone());
    const auth = request.headers.get('Authorization') ?? '';
    if (!auth.startsWith(`AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/`) || !auth.includes('/s3/aws4_request')) {
      return s3Error(403, 'InvalidAccessKeyId');
    }
    if (!request.headers.get('x-amz-content-sha256')) return s3Error(400, 'MissingContentSha256');

    const url = new URL(request.url);
    const [, bucket, ...rest] = url.pathname.split('/');
    if (decodeURIComponent(bucket) !== options.bucket) return s3Error(404, 'NoSuchBucket');
    const key = rest.map(decodeURIComponent).join('/');

    if (!key && request.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const start = Number(url.searchParams.get('continuation-token') ?? 0);
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const page = keys.slice(start, start + pageSize);
      const truncated = start + pageSize < keys.length;
      const contents = page.map((k) => {
        const object = objects.get(k)!;
        return `<Contents><Key>${escapeXml(k)}</Key><LastModified>${object.lastModified.toISOString()}</LastModified>` +
          `<ETag>${escapeXml(object.etag)}</ETag><Size>${object.body.byteLength}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
      }).join('');
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${options.bucket}</Name><Prefix>${escapeXml(prefix)}</Prefix>` +
          `<KeyCount>${page.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>` +
          (truncated ? `<NextContinuationToken>${start + pageSize}</NextContinuationToken>` : '') +
          `${contents}</ListBucketResult>`,
        { headers: { 'Content-Type': 'application/xml' } }
      );
    }
    if (!key) return s3Error(400, 'InvalidRequest');

    const object = objects.get(key);
    switch (request.method) {
      case 'PUT': {
        const body = new Uint8Array(await request.arrayBuffer());
        const etag = await etagOf(body);
        objects.set(key, {
          body,
          contentType: request.headers.get('Content-Type') ?? 'binary/octet-stream',
          etag,
          lastModified: new Date(),
        });
        return new Response(null, { status: 200, headers: { ETag: etag } });
      }
      case 'GET':
      case 'HEAD': {
        if (!object) return request.method === 'HEAD' ? new Response(null, { status: 404 }) : s3Error(404, 'NoSuchKey');
        const headers = {
          'Content-Type': object.contentType,
          'Content-Length': String(object.body.byteLength),
          ETag: object.etag,
          'Last-Modified': object.lastModified.toUTCString(),
        };
        return new Response(request.method === 'HEAD' ? null : object.body, { headers });
      }
      case 'DELETE':
        objects.delete(key);
        return new Response(null, { status: 204 });
      default:
        return s3Error(405, 'MethodNotAllowed');
    }
  }

  return { fetch: handle, objects, requests };
}
