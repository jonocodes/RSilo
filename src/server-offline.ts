import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { storageRouter } from './routes/storage';
import { webfingerRouter } from './routes/webfinger';
import { oauthRouter } from './routes/oauth';
import { adminRouter } from './routes/admin';
import { corsMiddleware } from './middleware/cors';
import { LocalStorage } from './services/local-storage';
import { LocalDatabase } from './services/db/local';
import { D1Adapter } from './services/db/d1-mock';

const STORAGE_DIR = process.env.STORAGE_DIR || 'data/storage';
const DB_PATH = process.env.DB_PATH || 'data/remotestorage.db';

const localStorage = new LocalStorage(STORAGE_DIR);
const localDb = new LocalDatabase(DB_PATH);
const d1Adapter = new D1Adapter(localDb);

const app = new Hono();

app.use('*', corsMiddleware());

app.use('*', async (c, next) => {
  (c.env as any).STORAGE = localStorage;
  (c.env as any).DB = d1Adapter;
  (c.env as any).OAUTH_CODES = new Map();
  (c.env as any).RATE_LIMIT_KV = undefined;
  await next();
});

app.route('/storage', storageRouter);
app.route('/oauth', oauthRouter);
app.route('/admin', adminRouter);
app.route('/', webfingerRouter);

app.get('/health', (c) => c.json({ status: 'ok', mode: 'offline' }));

const port = parseInt(process.env.PORT || '8787');

console.log(`RemoteStorage Worker (offline mode)`);
console.log(`Storage: ${STORAGE_DIR}`);
console.log(`Database: ${DB_PATH}`);
console.log(`Listening on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  localDb.close();
  process.exit(0);
});