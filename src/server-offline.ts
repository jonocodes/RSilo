import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { storageRouter } from './routes/storage';
import { webfingerRouter } from './routes/webfinger';
import { oauthRouter } from './routes/oauth';
import { adminRouter } from './routes/admin';
import { accountRouter } from './routes/account';
import { corsMiddleware } from './middleware/cors';
import { mountDocs } from './routes/docs';
import { LocalStorage } from './services/local-storage';
import { LocalDatabase } from './services/db/local';
import { D1Adapter } from './services/db/d1-mock';
import { readFileSync } from 'fs';
import { DEV_ACCOUNT_USERNAME } from './config';

function loadDevVars(path: string) {
  try {
    const content = readFileSync(path, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {}
}

loadDevVars('.dev.vars');

const STORAGE_DIR = process.env.STORAGE_DIR || 'data/storage';
const DB_PATH = process.env.DB_PATH || 'data/remotestorage.db';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-session-secret-change-in-production';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'admin';
const port = parseInt(process.env.PORT || '8787');
// Offline mode is dev mode: unset values fall back to the dev defaults, with
// the public origin following the port actually listened on.
const ACCOUNT_USERNAME = process.env.ACCOUNT_USERNAME || DEV_ACCOUNT_USERNAME;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;

const localStorage = new LocalStorage(STORAGE_DIR);
const localDb = new LocalDatabase(DB_PATH);
const d1Adapter = new D1Adapter(localDb);

const app = new Hono();

app.use('*', corsMiddleware());

app.use('*', async (c, next) => {
  (c.env as any).STORAGE = localStorage;
  (c.env as any).DB = d1Adapter;
  (c.env as any).SESSION_SECRET = SESSION_SECRET;
  (c.env as any).ADMIN_SECRET = ADMIN_SECRET;
  (c.env as any).RSILO_DEV_MODE = 'true';
  (c.env as any).ACCOUNT_USERNAME = ACCOUNT_USERNAME;
  (c.env as any).PUBLIC_BASE_URL = PUBLIC_BASE_URL;
  await next();
});

app.route('/storage', storageRouter);
app.route('/oauth', oauthRouter);
app.get('/admin/', (c) => c.redirect('/admin', 301));
app.route('/admin', adminRouter);
app.get('/account/', (c) => c.redirect('/account', 301));
app.route('/account', accountRouter);
app.route('/', webfingerRouter);

app.get('/health', (c) => c.json({ status: 'ok', mode: 'offline' }));

mountDocs(app);

console.log(`RemoteStorage Worker (offline mode)`);
console.log(`Storage: ${STORAGE_DIR}`);
console.log(`Database: ${DB_PATH}`);
console.log(`Account: ${ACCOUNT_USERNAME} at ${PUBLIC_BASE_URL}`);
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