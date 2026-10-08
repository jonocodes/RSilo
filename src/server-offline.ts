import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { mountRoutes } from './routes/mount';
import { corsMiddleware } from './middleware/cors';
import { mountDocs } from './routes/docs';
import { LocalStorage } from './services/local-storage';
import { LocalDatabase } from './services/db/local';
import { D1Adapter } from './services/db/d1-mock';
import { readFileSync } from 'fs';
import { DEV_ACCOUNT_USERNAME, DEV_OWNER_EMAIL } from './config';

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
const port = parseInt(process.env.PORT || '8787');
// Offline mode is dev mode: unset values fall back to the dev defaults, with
// the public origin following the port actually listened on. The origin is
// set explicitly because, unlike Cloudflare's edge, a plain Node server does
// not vet the Host header, so the request origin is not trusted here. Requests to
// localhost are signed in as the dev identity (RSILO_DEV_EMAIL, default
// OWNER_EMAIL), since there is no Cloudflare Access in front of this server.
const ACCOUNT_USERNAME = process.env.ACCOUNT_USERNAME || DEV_ACCOUNT_USERNAME;
const OWNER_EMAIL = process.env.OWNER_EMAIL || DEV_OWNER_EMAIL;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;

const localStorage = new LocalStorage(STORAGE_DIR);
const localDb = new LocalDatabase(DB_PATH);
const d1Adapter = new D1Adapter(localDb);

const app = new Hono();

app.use('*', corsMiddleware());

app.use('*', async (c, next) => {
  (c.env as any).STORAGE = localStorage;
  (c.env as any).DB = d1Adapter;
  (c.env as any).RSILO_DEV_MODE = 'true';
  (c.env as any).ACCOUNT_USERNAME = ACCOUNT_USERNAME;
  (c.env as any).OWNER_EMAIL = OWNER_EMAIL;
  if (process.env.RSILO_DEV_EMAIL) (c.env as any).RSILO_DEV_EMAIL = process.env.RSILO_DEV_EMAIL;
  (c.env as any).PUBLIC_BASE_URL = PUBLIC_BASE_URL;
  await next();
});

mountRoutes(app);

app.get('/health', (c) => c.json({ status: 'ok', mode: 'offline' }));

mountDocs(app);

console.log(`RemoteStorage Worker (offline mode)`);
console.log(`Storage: ${STORAGE_DIR}`);
console.log(`Database: ${DB_PATH}`);
console.log(`Account: ${ACCOUNT_USERNAME} at ${PUBLIC_BASE_URL} (owner ${OWNER_EMAIL})`);
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