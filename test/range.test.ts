// Range requests on documents (draft-dejong-remotestorage §4 allows servers to
// support RFC 7233 byte ranges on GET and advertise it via WebFinger).

import { describe, it, expect, beforeEach } from 'vitest';
import { createServer } from '../src/index';
import { seedToken } from './helpers/tokens';
import { createSqliteD1 } from '../src/services/db/sqlite';
import { createMemoryStorage } from './helpers/memory-storage';

const URL_ = 'http://localhost/storage/alice/documents/digits.txt';

describe('range requests', () => {
  let env: { STORAGE: any; DB: ReturnType<typeof createSqliteD1> };
  let auth: { Authorization: string };
  const app = createServer({});
  const get = (headers: Record<string, string> = {}, method = 'GET') =>
    app.request(URL_, { method, headers: { ...auth, ...headers } }, env);

  beforeEach(async () => {
    env = { STORAGE: createMemoryStorage(), DB: createSqliteD1() };
    auth = { Authorization: `Bearer ${seedToken(env, 'alice', 'documents:rw')}` };
    const put = await app.request(URL_, { method: 'PUT', body: '0123456789', headers: { ...auth, 'Content-Type': 'text/plain' } }, env);
    expect(put.status).toBe(201);
  });

  it('advertises byte ranges on full responses', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(await res.text()).toBe('0123456789');
    expect((await get({}, 'HEAD')).headers.get('Accept-Ranges')).toBe('bytes');
  });

  for (const [range, body, contentRange] of [
    ['bytes=2-4', '234', 'bytes 2-4/10'],
    ['bytes=7-', '789', 'bytes 7-9/10'],
    ['bytes=-3', '789', 'bytes 7-9/10'],
    ['bytes=8-100', '89', 'bytes 8-9/10'],
    ['bytes=-100', '0123456789', 'bytes 0-9/10'],
  ]) {
    it(`serves ${range}`, async () => {
      const res = await get({ Range: range });
      expect(res.status).toBe(206);
      expect(res.headers.get('Content-Range')).toBe(contentRange);
      expect(res.headers.get('Content-Length')).toBe(String(body.length));
      expect(res.headers.get('ETag')).toBe((await get()).headers.get('ETag'));
      expect(await res.text()).toBe(body);
    });
  }

  it('answers 416 for a range past the end', async () => {
    const res = await get({ Range: 'bytes=10-20' });
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe('bytes */10');
  });

  for (const range of ['bytes=0-1,4-5', 'items=0-1', 'bytes=5-2', 'bytes=abc']) {
    it(`ignores unsupported or invalid range ${JSON.stringify(range)}`, async () => {
      const res = await get({ Range: range });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('0123456789');
    });
  }

  it('honours If-None-Match before Range', async () => {
    const etag = (await get()).headers.get('ETag')!;
    expect((await get({ Range: 'bytes=0-1', 'If-None-Match': etag })).status).toBe(304);
  });

  it('slices in the route when a storage backend ignores the range', async () => {
    const storage = env.STORAGE;
    env.STORAGE = { ...storage, get: (key: string) => storage.get(key) };
    const res = await get({ Range: 'bytes=2-4' });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('234');
  });

  it('advertises range support in WebFinger', async () => {
    const res = await app.request('http://localhost/.well-known/webfinger?resource=acct:alice@localhost', {}, env);
    const link = ((await res.json()) as { links: any[] }).links.find((l: any) => l.rel === 'http://tools.ietf.org/id/draft-dejong-remotestorage');
    expect(link.properties['http://tools.ietf.org/html/rfc7233']).toBe('GET');
  });
});
