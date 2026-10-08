import { Hono } from 'hono';
import { corsMiddleware } from './middleware/cors';
import { mountRoutes } from './routes/mount';
import { mountDocs } from './routes/docs';
export { buildKey, R2Storage } from './services/r2';
export type { AppEnv } from './types';

const app = new Hono();

app.use('*', corsMiddleware());

mountRoutes(app);

app.get('/health', (c) => c.json({ status: 'ok' }));

mountDocs(app);

export function createServer(_env: unknown) {
  return app;
}

export default app;
