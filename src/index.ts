import { Hono } from 'hono';
import { storageRouter } from './routes/storage';
import { webfingerRouter } from './routes/webfinger';
import { oauthRouter } from './routes/oauth';
import { adminRouter } from './routes/admin';
import { corsMiddleware } from './middleware/cors';
import type { AppEnv } from './types';

export { buildKey, R2Storage } from './services/r2';
export { createTestToken, verifyToken } from './services/auth';
export type { AppEnv } from './types';

const app = new Hono();

app.use('*', corsMiddleware());

app.route('/storage', storageRouter);
app.route('/oauth', oauthRouter);
app.route('/admin', adminRouter);
app.route('/', webfingerRouter);

app.get('/health', (c) => c.json({ status: 'ok' }));

export function createServer(env: AppEnv) {
  return app;
}

export default app;