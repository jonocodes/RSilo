import { Hono } from 'hono';
import { storageRouter } from './routes/storage';
import { webfingerRouter } from './routes/webfinger';
import { oauthRouter } from './routes/oauth';
import { adminRouter } from './routes/admin';
import { accountRouter } from './routes/account';
import { corsMiddleware } from './middleware/cors';
import type { AppEnv } from './types';

export { buildKey, R2Storage } from './services/r2';
export { createTestToken, verifyToken } from './services/auth';
export type { AppEnv } from './types';

const app = new Hono();

app.use('*', corsMiddleware());

app.route('/storage', storageRouter);
app.route('/oauth', oauthRouter);
app.get('/admin/', (c) => c.redirect('/admin', 301));
app.route('/admin', adminRouter);
app.get('/account/', (c) => c.redirect('/account', 301));
app.route('/account', accountRouter);
app.route('/', webfingerRouter);

app.get('/health', (c) => c.json({ status: 'ok' }));

export function createServer(_env: AppEnv) {
  return app;
}

export default app;