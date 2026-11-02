import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createServer } from '../src/index';
import { createSqliteD1, type SqliteD1 } from '../src/services/db/sqlite';
import { FOLDER_ETAG_MAX_AGE_SECONDS } from '../src/services/folder-etags';
import { putUserObject } from '../src/services/quota-storage';
import { MemoryStorage } from './helpers/memory-storage';
import { seedToken } from './helpers/tokens';

// The folder ETag cache (routes/storage.ts handleFolderGet): an unchanged
// folder is answered from D1 without listing storage; any write below it, or
// the max age, makes the next GET list again.

type Listing = Awaited<ReturnType<MemoryStorage['list']>>;

// Counts folder listings (a list with no limit; the PUT's 409 check lists one
// key). `afterNextListing` runs once, after a listing was read and before it is
// returned: a write landing mid-listing.
class CountingStorage extends MemoryStorage {
  folderLists = 0;
  afterNextListing?: () => Promise<unknown>;

  override async list(prefix: string, options: { limit?: number } = {}): Promise<Listing> {
    const listing = await super.list(prefix, options);
    if (options.limit === undefined) {
      this.folderLists++;
      const hook = this.afterNextListing;
      this.afterNextListing = undefined;
      if (hook) await hook();
    }
    return listing;
  }
}

const app = createServer({});
let env: { STORAGE: CountingStorage; DB: SqliteD1 };
let token: string;

beforeEach(() => {
  env = { STORAGE: new CountingStorage(), DB: createSqliteD1() };
  token = seedToken(env, 'alice', '*:rw');
});

function request(method: string, path: string, headers: Record<string, string> = {}, body?: string) {
  return app.request(
    `http://localhost/storage/alice/${path}`,
    { method, headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain', ...headers }, body },
    env,
  );
}

const put = async (path: string, body: string) => expect((await request('PUT', path, {}, body)).status).toBeOneOf([200, 201]);
const etagOf = async (path: string) => (await request('GET', path)).headers.get('ETag')!;
const ifNoneMatch = (etag: string) => ({ 'If-None-Match': etag });

describe('folder ETag cache', () => {
  it('answers a matching If-None-Match with 304, and a HEAD, without listing', async () => {
    await put('documents/a/b/c', 'one');
    const etag = await etagOf('documents/');
    const lists = env.STORAGE.folderLists;

    const notModified = await request('GET', 'documents/', ifNoneMatch(etag));
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get('ETag')).toBe(etag);

    const head = await request('HEAD', 'documents/');
    expect(head.status).toBe(200);
    expect(head.headers.get('ETag')).toBe(etag);
    expect(head.headers.get('Content-Type')).toContain('application/ld+json');
    expect((await request('HEAD', 'documents/', ifNoneMatch(etag))).status).toBe(304);
    expect(env.STORAGE.folderLists).toBe(lists);

    // A 200 still needs the listing for its body, and serves the same ETag.
    const full = await request('GET', 'documents/', ifNoneMatch('"other"'));
    expect(full.status).toBe(200);
    expect(full.headers.get('ETag')).toBe(etag);
    expect(env.STORAGE.folderLists).toBe(lists + 1);
  });

  it('lists the folder and every ancestor again after a write or delete below it, and leaves siblings cached', async () => {
    await put('documents/a/b/c', 'one');
    await put('documents/x/y', 'sibling');
    const folders = ['', 'documents/', 'documents/a/', 'documents/a/b/'];
    let etags = await Promise.all(folders.map(etagOf));
    const sibling = await etagOf('documents/x/');

    for (const change of [() => put('documents/a/b/d/e', 'deep'), () => request('DELETE', 'documents/a/b/c')]) {
      await change();
      const lists = env.STORAGE.folderLists;
      const responses = await Promise.all(folders.map((folder, i) => request('GET', folder, ifNoneMatch(etags[i]))));
      expect(responses.map(res => res.status)).toEqual([200, 200, 200, 200]);
      expect(env.STORAGE.folderLists).toBe(lists + folders.length);
      const fresh = responses.map(res => res.headers.get('ETag')!);
      fresh.forEach((etag, i) => expect(etag).not.toBe(etags[i]));

      // The parent's entry for a/b/ is still the ETag a/b/ serves.
      const parent = await (await request('GET', 'documents/a/')).json() as { items: Record<string, { ETag: string }> };
      expect(`"${parent.items['b/'].ETag}"`).toBe(fresh[3]);

      expect((await request('GET', 'documents/x/', ifNoneMatch(sibling))).status).toBe(304);
      etags = fresh;
    }
  });

  it('does not cache an ETag when a write lands while the folder is listed', async () => {
    await put('documents/a', 'one');
    env.STORAGE.afterNextListing = () => putUserObject({
      storage: env.STORAGE,
      db: env.DB,
      username: 'alice',
      key: 'users/alice/storage/documents/b',
      body: new ArrayBuffer(3),
      contentType: 'text/plain',
    });
    const stale = await etagOf('documents/');

    const lists = env.STORAGE.folderLists;
    const res = await request('GET', 'documents/', ifNoneMatch(stale));
    expect(res.status).toBe(200);
    expect(env.STORAGE.folderLists).toBe(lists + 1);
    expect(res.headers.get('ETag')).not.toBe(stale);
  });

  it('lists again once the cached ETag is older than the max age, so direct bucket edits show', async () => {
    await put('documents/a', 'one');
    const etag = await etagOf('documents/');
    env.STORAGE.seed('users/alice/storage/documents/restored', 'outside RSilo');

    // Within the max age the cache cannot see an edit made outside RSilo.
    expect((await request('GET', 'documents/', ifNoneMatch(etag))).status).toBe(304);

    env.DB.sqlite.prepare('UPDATE folder_etags SET cached_at = cached_at - ?').run(FOLDER_ETAG_MAX_AGE_SECONDS);
    const lists = env.STORAGE.folderLists;
    const res = await request('GET', 'documents/', ifNoneMatch(etag));
    expect(res.status).toBe(200);
    expect(env.STORAGE.folderLists).toBe(lists + 1);
    expect(res.headers.get('ETag')).not.toBe(etag);
  });

  it('serves public folder listings from the cache too', async () => {
    await put('public/documents/shared', 'shared');
    const etag = await etagOf('public/documents/');
    const lists = env.STORAGE.folderLists;
    expect((await request('GET', 'public/documents/', ifNoneMatch(etag))).status).toBe(304);
    expect(env.STORAGE.folderLists).toBe(lists);
  });

  it('still completes a write when the cache cannot be invalidated, and folders still list', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    env.DB.sqlite.exec('DROP TABLE folder_etags');
    expect((await request('PUT', 'documents/a', {}, 'one')).status).toBe(201);
    const res = await request('GET', 'documents/');
    expect(res.status).toBe(200);
    expect(Object.keys((await res.json() as { items: object }).items)).toEqual(['a']);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe('folder versions on writes', () => {
  it("bumps every folder above a document, the storage root included, for writes from any route", async () => {
    const versions = () => env.DB.sqlite.prepare('SELECT path, version FROM folder_etags ORDER BY path').all();
    await putUserObject({
      storage: env.STORAGE,
      db: env.DB,
      username: 'alice',
      key: 'users/alice/storage/documents/a/b',
      body: new ArrayBuffer(1),
      contentType: 'text/plain',
    });
    expect(versions()).toEqual([
      { path: '', version: 1 },
      { path: 'documents/', version: 1 },
      { path: 'documents/a/', version: 1 },
    ]);

    await request('DELETE', 'documents/a/b');
    expect(versions()).toEqual([
      { path: '', version: 2 },
      { path: 'documents/', version: 2 },
      { path: 'documents/a/', version: 2 },
    ]);
  });
});
