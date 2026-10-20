import { Hono } from 'hono';
import { corsMiddleware } from './middleware/cors';
import { mountRoutes } from './routes/mount';
import { mountDocs } from './routes/docs';
import { rawRequestPath } from './protocol/item-path';
export { buildKey, R2Storage } from './services/r2';
export type { AppEnv } from './types';

// Route on the raw path; handlers decode item names (protocol/item-path.ts).
const app = new Hono({ getPath: rawRequestPath });

app.use('*', corsMiddleware());

mountRoutes(app);

app.get('/health', (c) => c.json({ status: 'ok' }));

mountDocs(app);

export function createServer(_env: unknown) {
  return app;
}

export default app;
