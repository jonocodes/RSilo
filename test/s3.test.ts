import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getInstanceConfig, getStorageConfig } from '../src/config';
import { createServer } from '../src/index';
import { getStorage, R2Storage } from '../src/services/r2';
import { S3Storage, S3StorageError } from '../src/services/s3';
import { createFakeS3, type FakeS3 } from './helpers/fake-s3';
import { seedToken } from './helpers/tokens';

const S3_ENV = {
  S3_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com',
  S3_BUCKET: 'rsilo-test',
  S3_ACCESS_KEY_ID: 'AKIDTEST',
  S3_SECRET_ACCESS_KEY: 'secret-test-key',
};

const CONFIG = {
  endpoint: S3_ENV.S3_ENDPOINT,
  bucket: S3_ENV.S3_BUCKET,
  accessKeyId: S3_ENV.S3_ACCESS_KEY_ID,
  secretAccessKey: S3_ENV.S3_SECRET_ACCESS_KEY,
};

function fakeS3(pageSize?: number): FakeS3 {
  return createFakeS3({ bucket: CONFIG.bucket, accessKeyId: CONFIG.accessKeyId, pageSize });
}

async function text(body: ArrayBuffer | ReadableStream<Uint8Array>): Promise<string> {
  return new Response(body).text();
}

describe('getStorageConfig', () => {
  it('uses the R2 binding when no S3_* var is set', () => {
    expect(getStorageConfig({ OWNER_EMAIL: 'a@b.c' })).toEqual({ ok: true, s3: null });
    expect(getStorageConfig({ S3_ENDPOINT: '  ', S3_BUCKET: '' })).toEqual({ ok: true, s3: null });
  });

  it('selects S3 when every required var is set, leaving the region to the signer', () => {
    expect(getStorageConfig({ ...S3_ENV, S3_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com/' })).toEqual({
      ok: true,
      s3: { ...CONFIG, region: undefined },
    });
    expect(getStorageConfig({ ...S3_ENV, S3_REGION: 'eu-central-003' })).toMatchObject({ s3: { region: 'eu-central-003' } });
  });

  it('names each missing var once any S3_* var is set', () => {
    const result = getStorageConfig({ S3_ENDPOINT: S3_ENV.S3_ENDPOINT });
    expect(result.ok).toBe(false);
    expect('problems' in result && result.problems.map((p) => p.split(' ')[0])).toEqual([
      'S3_BUCKET',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
    ]);
  });

  it('rejects an endpoint that is not an origin and a malformed bucket, without echoing them', () => {
    const result = getStorageConfig({ ...S3_ENV, S3_ENDPOINT: 'https://s3.example.com/bucket', S3_BUCKET: 'a/b' });
    expect(result.ok).toBe(false);
    const problems = 'problems' in result ? result.problems.join('\n') : '';
    expect(problems).toMatch(/S3_ENDPOINT must be/);
    expect(problems).toMatch(/S3_BUCKET must be/);
    expect(problems).not.toContain('s3.example.com/bucket');
    expect(problems).not.toContain('a/b');
  });

  it('never puts the secret in a problem', () => {
    const result = getStorageConfig({ S3_SECRET_ACCESS_KEY: 'hunter2' });
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('makes the Instance unconfigured, like any other invalid setting', () => {
    const result = getInstanceConfig({ S3_BUCKET: 'rsilo' }, 'https://rsilo.example/');
    expect(result.ok).toBe(false);
    expect('problems' in result && result.problems).toContain('S3_ENDPOINT is not set (other S3_* settings are)');
  });
});

describe('getStorage', () => {
  it('prefers S3 over an R2 binding that is still present', () => {
    const r2 = { createMultipartUpload() {} };
    expect(getStorage({ env: { ...S3_ENV, STORAGE: r2 } })).toBeInstanceOf(S3Storage);
    expect(getStorage({ env: { STORAGE: r2 } })).toBeInstanceOf(R2Storage);
  });
});

describe('S3Storage', () => {
  let s3: FakeS3;
  let storage: S3Storage;

  beforeEach(() => {
    s3 = fakeS3(2);
    storage = new S3Storage(CONFIG, s3.fetch);
  });

  it('puts, heads, gets and deletes an object', async () => {
    const etag = await storage.put('users/alice/storage/docs/a.txt', new TextEncoder().encode('hello').buffer as ArrayBuffer, 'text/plain');
    expect(etag).toMatch(/^"[0-9a-f]+"$/);

    expect(await storage.head('users/alice/storage/docs/a.txt')).toMatchObject({
      contentType: 'text/plain',
      contentLength: 5,
      etag,
    });

    const got = await storage.get('users/alice/storage/docs/a.txt');
    expect(got?.metadata).toMatchObject({ contentType: 'text/plain', contentLength: 5, etag });
    expect(got?.metadata.lastModified).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(await text(got!.body)).toBe('hello');

    await storage.delete('users/alice/storage/docs/a.txt');
    expect(await storage.head('users/alice/storage/docs/a.txt')).toBeNull();
    expect(await storage.get('users/alice/storage/docs/a.txt')).toBeNull();
  });

  it('treats deleting a missing object as done', async () => {
    await expect(storage.delete('users/alice/storage/nope')).resolves.toBeUndefined();
  });

  it('signs path-style requests for the bucket', async () => {
    await storage.head('users/alice/storage/x');
    const [request] = s3.requests;
    expect(new URL(request.url).pathname).toBe('/rsilo-test/users/alice/storage/x');
    expect(request.headers.get('Authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/us-west-004\/s3\/aws4_request, SignedHeaders=/
    );
    expect(request.headers.get('Authorization')).not.toContain('secret-test-key');
  });

  it('round-trips keys that need escaping in URLs and in the XML listing', async () => {
    const key = 'users/alice/storage/docs/a & b <c> "d" é+%.txt';
    await storage.put(key, new ArrayBuffer(3), 'application/octet-stream');
    expect(s3.objects.has(key)).toBe(true);
    expect((await storage.list('users/alice/storage/docs/')).objects.map((o) => o.key)).toEqual([key]);
    expect(await storage.head(key)).not.toBeNull();
  });

  it('lists every page under a prefix with sizes, ETags and ISO dates', async () => {
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      await storage.put(`users/alice/storage/docs/${name}`, new ArrayBuffer(name.charCodeAt(0) - 96), 'text/plain');
    }
    await storage.put('users/alice/storage/other/z', new ArrayBuffer(1), 'text/plain');

    const { objects } = await storage.list('users/alice/storage/docs/');
    expect(objects.map((o) => [o.key.split('/').pop(), o.size])).toEqual([['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]]);
    expect(objects[0].etag).toBe(s3.objects.get('users/alice/storage/docs/a')!.etag);
    expect(objects[0].lastModified).toMatch(/Z$/);
    expect(s3.requests.filter((r) => new URL(r.url).searchParams.get('list-type') === '2')).toHaveLength(3);
  });

  it('rejects a truncated listing without a continuation token', async () => {
    const truncated = async () => new Response('<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>');
    await expect(new S3Storage(CONFIG, truncated).list('x/')).rejects.toThrow(/TruncatedWithoutToken/);
  });

  it('reports failures with the status and S3 error code only', async () => {
    const denied = new S3Storage({ ...CONFIG, accessKeyId: 'WRONG' }, s3.fetch);
    const error = await denied.get('users/alice/storage/x').catch((e) => e);
    expect(error).toBeInstanceOf(S3StorageError);
    expect(error.message).toBe('S3 GET failed with HTTP 403 (InvalidAccessKeyId)');
    await expect(denied.head('users/alice/storage/x')).rejects.toThrow('S3 HEAD failed with HTTP 403');
  });
});

describe('storage routes on S3', () => {
  let s3: FakeS3;
  const env = { ...S3_ENV, DB: {} as any };
  const app = createServer(env);

  beforeEach(() => {
    s3 = fakeS3();
    vi.stubGlobal('fetch', (input: Request) => s3.fetch(input));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('serves the remoteStorage PUT / GET / folder / DELETE cycle from the bucket', async () => {
    const token = seedToken(env, 'alice');
    const auth = { Authorization: `Bearer ${token}` };
    const url = 'http://localhost/storage/alice/documents/notes/today.txt';

    const put = await app.request(url, { method: 'PUT', headers: { ...auth, 'Content-Type': 'text/plain' }, body: 'hi' }, env);
    expect(put.status).toBe(201);
    expect(s3.objects.has('users/alice/storage/documents/notes/today.txt')).toBe(true);

    const get = await app.request(url, { headers: auth }, env);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe('hi');
    expect(get.headers.get('ETag')).toBe(put.headers.get('ETag'));

    const conditional = await app.request(url, { headers: { ...auth, 'If-None-Match': get.headers.get('ETag')! } }, env);
    expect(conditional.status).toBe(304);

    const folder = await app.request('http://localhost/storage/alice/documents/', { headers: auth }, env);
    expect(folder.status).toBe(200);
    expect(Object.keys((await folder.json() as { items: object }).items)).toEqual(['notes/']);

    const del = await app.request(url, { method: 'DELETE', headers: auth }, env);
    expect(del.status).toBe(200);
    expect(s3.objects.size).toBe(0);
  });

  it('answers 503 naming the missing setting when the S3 config is incomplete', async () => {
    const broken = { S3_ENDPOINT: S3_ENV.S3_ENDPOINT, DB: {} as any };
    const token = seedToken(broken, 'alice');
    const res = await app.request('http://localhost/storage/alice/documents/x', { headers: { Authorization: `Bearer ${token}` } }, broken);
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/S3_BUCKET is not set/);
    expect(s3.requests).toHaveLength(0);
  });
});
