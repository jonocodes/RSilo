// The file manager under /account uses the same item names as the storage API
// (protocol/item-path.ts): links encode each name, routes decode each segment.

import { describe, it, expect, beforeEach } from 'vitest';
import { createServer } from '../src/index';
import { createSqliteD1 } from '../src/services/db/sqlite';
import { createMemoryStorage } from './helpers/memory-storage';

// Dev mode signs localhost requests in as the Owner (see account.test.ts)
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };
const KEY = 'users/alice/storage/documents/my notes?/to do#1.txt';

describe('file manager with special characters in names', () => {
  const app = createServer({});
  let env: { STORAGE: ReturnType<typeof createMemoryStorage>; DB: ReturnType<typeof createSqliteD1> };
  const get = (path: string) => app.request(`http://localhost${path}`, {}, env as any);

  beforeEach(async () => {
    env = { STORAGE: createMemoryStorage(), DB: createSqliteD1() };
    await env.STORAGE.put(KEY, new TextEncoder().encode('hello').buffer as ArrayBuffer, 'text/plain');
  });

  it('links folders and documents with each name encoded', async () => {
    const top = await (await get('/account/browse/documents')).text();
    expect(top).toContain('href="/account/browse/documents/my%20notes%3F"');

    const res = await get('/account/browse/documents/my%20notes%3F');
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain('href="/account/download/documents/my%20notes%3F/to%20do%231.txt"');
    // breadcrumbs encode per name, never "/" as %2F
    expect(page).toContain('href="/account/browse/documents/my%20notes%3F"');
    expect(page).not.toContain('%2F');
  });

  it('downloads and views by the encoded path', async () => {
    const download = await get('/account/download/documents/my%20notes%3F/to%20do%231.txt');
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('hello');
    expect((await get('/account/view/documents/my%20notes%3F/to%20do%231.txt')).status).toBe(200);
  });

  it('deletes by the encoded path and returns to the folder', async () => {
    const res = await app.request('http://localhost/account/delete/documents/my%20notes%3F/to%20do%231.txt',
      { method: 'POST', headers: SAME_ORIGIN }, env as any);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/account/browse/documents/my%20notes%3F');
    expect(env.STORAGE.items.has(KEY)).toBe(false);
  });
});
