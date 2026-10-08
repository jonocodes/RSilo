import type { Hono } from 'hono';
import { storageRouter } from './storage';
import { webfingerRouter } from './webfinger';
import { oauthRouter } from './oauth';
import { accountRouter } from './account';
import { debugRouter } from './debug';
import { devIdentityAllowed } from '../services/identity';

/** Mounts every route; shared by the Worker (index.ts) and server-offline.ts. */
export function mountRoutes(app: Hono): void {
  app.route('/storage', storageRouter);
  app.route('/oauth', oauthRouter);
  // The admin console was merged into /account (ADR-0004).
  app.get('/admin', (c) => c.redirect('/account', 301));
  app.get('/admin/*', (c) => c.redirect('/account', 301));
  app.get('/account/', (c) => c.redirect('/account', 301));
  app.route('/account', accountRouter);
  // Dev-only: outside the dev identity guard every /debug/* path is a 404.
  app.use('/debug/*', async (c, next) => {
    if (!devIdentityAllowed(c)) return c.notFound();
    await next();
  });
  app.route('/debug', debugRouter);
  app.route('/', webfingerRouter);
}
