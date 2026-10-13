// Runs S3Storage against a real S3-compatible server, so request signing is
// checked by an actual implementation rather than the fake in helpers/fake-s3.
// Skipped unless RSILO_S3_LIVE_ENDPOINT is set. Every object it writes is under
// a fresh prefix and deleted again. Example with a local SeaweedFS (as CI uses;
// the fixture holds the credentials below):
//
//   weed server -dir=/tmp/seaweedfs -s3 -s3.config=test/fixtures/seaweedfs-s3.json
//   RSILO_S3_LIVE_ENDPOINT=http://127.0.0.1:8333 RSILO_S3_LIVE_BUCKET=rsilo-live \
//   RSILO_S3_LIVE_ACCESS_KEY_ID=rsiloadmin RSILO_S3_LIVE_SECRET_ACCESS_KEY=rsilo-secret-123 \
//   bun run test test/s3-live.test.ts
//
// The bucket is created if it does not exist (needs a key allowed to create
// buckets; otherwise create it first). RSILO_S3_LIVE_REGION is optional.
import { AwsClient } from 'aws4fetch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { S3Config } from '../src/config';
import { S3Storage } from '../src/services/s3';

const live = process.env.RSILO_S3_LIVE_ENDPOINT;

describe.skipIf(!live)('S3Storage against a live S3 server', () => {
  const config: S3Config = {
    endpoint: live!,
    bucket: process.env.RSILO_S3_LIVE_BUCKET ?? 'rsilo-live',
    region: process.env.RSILO_S3_LIVE_REGION || undefined,
    accessKeyId: process.env.RSILO_S3_LIVE_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.RSILO_S3_LIVE_SECRET_ACCESS_KEY ?? '',
  };
  const storage = new S3Storage(config);
  const prefix = `rsilo-live-test/${Date.now()}-${Math.random().toString(36).slice(2)}/`;
  const keys = [`${prefix}a.txt`, `${prefix}dir/b & c é.json`];

  beforeAll(async () => {
    const client = new AwsClient({ ...config, service: 's3', retries: 0 });
    const res = await client.fetch(`${config.endpoint}/${config.bucket}`, { method: 'PUT' });
    await res.body?.cancel();
  });

  afterAll(async () => {
    for (const key of keys) await storage.delete(key).catch(() => {});
  });

  it('writes, reads, lists and deletes objects', async () => {
    const etag = await storage.put(keys[0], new TextEncoder().encode('hello').buffer as ArrayBuffer, 'text/plain');
    await storage.put(keys[1], new TextEncoder().encode('{}').buffer as ArrayBuffer, 'application/json');

    expect(await storage.head(keys[0])).toMatchObject({ contentType: 'text/plain', contentLength: 5, etag });
    const got = await storage.get(keys[0]);
    expect(await new Response(got!.body).text()).toBe('hello');
    expect(got!.metadata.etag).toBe(etag);

    const listed = await storage.list(prefix);
    expect(listed.objects.map((o) => o.key).sort()).toEqual([...keys].sort());
    expect(listed.objects.find((o) => o.key === keys[0])).toMatchObject({ size: 5, etag });

    await storage.delete(keys[0]);
    expect(await storage.head(keys[0])).toBeNull();
    expect(await storage.get(keys[0])).toBeNull();
    await storage.delete(keys[0]);
  });
});
