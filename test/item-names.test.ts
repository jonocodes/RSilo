// Item names (draft-dejong-remotestorage §4): "Item names MAY contain all
// characters, before URI_ENCODE, except '/' and the null character '\0' and
// MUST NOT have zero length. Item names MUST NOT be equal to '.' or to '..'."
// Requests carry the percent-encoded name; listings show the name itself.

import { describe, it, expect, beforeEach } from 'vitest';
import { createServer } from '../src/index';
import { seedToken } from './helpers/tokens';
import { createSqliteD1 } from '../src/services/db/sqlite';
import { createMemoryStorage } from './helpers/memory-storage';

const ROOT = 'http://localhost/storage/alice/documents';

// Names a client (rclone's fstests, remotestorage.js apps) may use
const NAMES = [
  'a b?.txt',
  'hash#tag',
  '100%',
  'literal %41 escape',
  'a&b=c+d',
  'semi;colon,comma',
  'colon:at@dollar$',
  'tilde~bang!',
  'back\\slash',
  '\ttab',
  '\nleading LF',
  'trailing CR\r',
  '\x01\x1fcontrols\x7f',
  '.hidden',
  '..double..dots..',
  '世界 ≠',
  'x.meta',
];

describe('item names', () => {
  let env: ReturnType<typeof makeEnv>;
  let auth: { Authorization: string };
  function makeEnv() {
    return { STORAGE: createMemoryStorage() as any, DB: createSqliteD1() };
  }
  beforeEach(() => {
    env = makeEnv();
    auth = { Authorization: `Bearer ${seedToken(env, 'alice', 'documents:rw')}` };
  });
  const app = createServer({});
  const req = (url: string, init: RequestInit = {}) =>
    app.request(url, { ...init, headers: { ...auth, ...(init.headers as any) } }, env);
  async function listing(folder = '') {
    const res = await req(`${ROOT}/${folder}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { items: Record<string, unknown> }).items;
  }

  for (const name of NAMES) {
    it(`round-trips document ${JSON.stringify(name)}`, async () => {
      const url = `${ROOT}/${encodeURIComponent(name)}`;
      const put = await req(url, { method: 'PUT', body: 'content', headers: { 'Content-Type': 'text/plain' } });
      expect(put.status).toBe(201);
      const get = await req(url);
      expect(get.status).toBe(200);
      expect(await get.text()).toBe('content');
      expect(Object.keys(await listing())).toEqual([name]);
      expect((await req(url, { method: 'DELETE' })).status).toBe(200);
      expect((await req(url)).status).toBe(404);
    });

    it(`lists folder ${JSON.stringify(name)} by its name`, async () => {
      const url = `${ROOT}/${encodeURIComponent(name)}/doc.txt`;
      expect((await req(url, { method: 'PUT', body: 'x', headers: { 'Content-Type': 'text/plain' } })).status).toBe(201);
      expect(Object.keys(await listing())).toEqual([`${name}/`]);
      expect(Object.keys(await listing(`${encodeURIComponent(name)}/`))).toEqual(['doc.txt']);
    });
  }

  it('stores the decoded name as the key', async () => {
    await req(`${ROOT}/a%3Fb%25c`, { method: 'PUT', body: 'x', headers: { 'Content-Type': 'text/plain' } });
    expect([...env.STORAGE.items.keys()]).toEqual(['users/alice/storage/documents/a?b%c']);
  });

  it('accepts other encodings of the same name', async () => {
    await req(`${ROOT}/tilde~bang!`, { method: 'PUT', body: 'x', headers: { 'Content-Type': 'text/plain' } });
    expect((await req(`${ROOT}/tilde%7Ebang%21`)).status).toBe(200);
  });

  for (const [what, segment] of [
    ['an encoded slash', 'a%2Fb'],
    ['a NUL', 'a%00b'],
    ['"."', '%2E'],
    ['".."', '%2E%2E'],
    ['an empty segment', 'a//b'],
    ['a malformed escape', 'a%ZZb'],
  ]) {
    it(`rejects a name with ${what}`, async () => {
      const res = await req(`${ROOT}/${segment}`, { method: 'PUT', body: 'x', headers: { 'Content-Type': 'text/plain' } });
      // URL parsing resolves "%2E" and "%2E%2E" as dot segments before the
      // request reaches us, so those land on a folder (400) or on the
      // storage root, which a documents:rw token can't write (403).
      expect(res.status).toBeOneOf([400, 403]);
      expect(env.STORAGE.items.size).toBe(0);
    });
  }
});
