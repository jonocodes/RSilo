// PROTOTYPE — throwaway. The offline server with STORAGE replaced by
// IndexedStorage (D1 index + BlobStore). BLOB_STORE=dir (default) or dropbox
// (needs DROPBOX_TOKEN). Logs per-request Dropbox calls and latency.
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { mountRoutes } from '../../src/routes/mount';
import { corsMiddleware } from '../../src/middleware/cors';
import { rawRequestPath } from '../../src/protocol/item-path';
import { createSqliteD1 } from '../../src/services/db/sqlite';
import { DEV_ACCOUNT_USERNAME, DEV_OWNER_EMAIL } from '../../src/config';
import { IndexedStorage, SCHEMA } from './indexed-storage';
import { DirBlobStore, DropboxBlobStore, dropboxCalls } from './blob-stores';

const port = parseInt(process.env.PORT || '8791');
const db = createSqliteD1(process.env.DB_PATH || '/tmp/d1-blob-index/PROTOTYPE-wipe-me.db');
for (const sql of SCHEMA) await db.prepare(sql).bind().run();

const blobs = process.env.BLOB_STORE === 'dropbox'
  ? new DropboxBlobStore(process.env.DROPBOX_TOKEN!, process.env.DROPBOX_ROOT || '/rsilo-blobs')
  : new DirBlobStore(process.env.BLOB_DIR || '/tmp/d1-blob-index/blobs');
const storage = new IndexedStorage(db as any, blobs);

const app = new Hono({ getPath: rawRequestPath });
app.use('*', corsMiddleware());
app.use('*', async (c, next) => {
  Object.assign(c.env as any, {
    STORAGE: storage,
    DB: db,
    RSILO_DEV_MODE: 'true',
    ACCOUNT_USERNAME: DEV_ACCOUNT_USERNAME,
    OWNER_EMAIL: DEV_OWNER_EMAIL,
    PUBLIC_BASE_URL: `http://localhost:${port}`,
  });
  const calls: { op: string; ms: number }[] = [];
  const start = performance.now();
  await dropboxCalls.run(calls, next);
  if (c.req.path.startsWith('/storage/')) {
    console.log(`[req] ${c.req.method}${c.req.path.endsWith("/") ? "-folder" : ""} ${c.res.status} ${Math.round(performance.now() - start)}ms dropbox=${calls.map((x) => `${x.op}:${x.ms}ms`).join(',') || '-'}`);
  }
});
mountRoutes(app);
// Blob garbage collection, off the request path (a Cron Trigger on a Worker).
async function collect() {
  const calls: { op: string; ms: number }[] = [];
  const deleted = await dropboxCalls.run(calls, () => storage.collect());
  if (deleted) console.log(`[gc] ${deleted} blobs, dropbox=${calls.map((x) => `${x.op}:${x.ms}ms`).join(',') || '-'}`);
  return deleted;
}
setInterval(() => collect().catch((e) => console.log(`[gc] failed: ${e}`)), Number(process.env.GC_INTERVAL_MS || 15000));
app.post('/prototype/gc', async (c) => c.json({ deleted: await collect() }));
app.get('/prototype/stats', async (c) => c.json({
  indexed: (await db.prepare('SELECT count(*) AS n FROM prototype_blob_index').first<{ n: number }>())!.n,
  queued: (await db.prepare('SELECT count(*) AS n FROM prototype_blob_garbage').first<{ n: number }>())!.n,
}));
app.get('/health', (c) => c.json({ status: 'ok', mode: 'prototype-d1-blob-index' }));

console.log(`PROTOTYPE d1-blob-index: blobs in ${process.env.BLOB_STORE === 'dropbox' ? 'Dropbox' : 'a local directory'}`);
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
