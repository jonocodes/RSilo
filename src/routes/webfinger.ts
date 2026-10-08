import { Hono } from 'hono';
import { PROTOCOL_VERSION } from '../protocol/constants';
import { requireInstanceConfig } from '../middleware/instance';
import { accountUrls, isAccountResource } from '../services/discovery';
import type { Context } from '../types';

export const webfingerRouter = new Hono();

webfingerRouter.get('/', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RSilo</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; color: #333; }
    h1 { color: #1a1a1a; margin-bottom: 1rem; }
    .info { background: #f5f5f5; padding: 1rem; border-radius: 8px; margin: 1rem 0; }
    code { background: #e8e8e8; padding: 0.2rem 0.4rem; border-radius: 4px; }
    a { color: #0066cc; }
    .tagline { color: #666; margin-top: -0.5rem; }
    nav a { margin-right: 1rem; }
  </style>
</head>
<body>
  <h1>RSilo</h1>
  <p class="tagline">A RemoteStorage server on Cloudflare Workers.</p>
  <nav>
    <a href="/account">Account</a>
    <a href="/api">API reference</a>
    <a href="https://github.com/jonocodes/RSilo">Source on GitHub</a>
  </nav>
  <div class="info">
    <p><strong>Storage API:</strong> <code>/storage/:username/*</code></p>
    <p><strong>WebFinger:</strong> <code>/.well-known/webfinger?resource=acct:user@example.com</code></p>
    <p><strong>OAuth:</strong> <code>/oauth/:username</code></p>
  </div>
  <p>This server implements the <a href="https://remotestorage.io">RemoteStorage</a> protocol.</p>
  <p>See <a href="https://remotestorage.io/protocol.html">protocol specification</a> for details.</p>
</body>
</html>`);
});

// Discovery for the one Account. Every URL comes from the resolved public
// origin, PUBLIC_BASE_URL or the request's own (see
// services/discovery.ts); any resource other than the Account is a 404.

const JRD = { 'Content-Type': 'application/jrd+json' };
const XRD = { 'Content-Type': 'application/xrd+xml' };

function notFound(c: Context): Response {
  return c.json({ error: 'not_found', error_description: 'Unknown resource' }, 404);
}

webfingerRouter.get('/.well-known/host-meta', requireInstanceConfig(), (c) => {
  const instance = c.get('instance');
  const urls = accountUrls(instance);
  return c.text(`<?xml version="1.0" encoding="UTF-8"?>
<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd/1.0"
   xmlns:hm="http://host-meta.net/xrd/1.0">
  <hm:Host>${instance.publicHost}</hm:Host>
  <Link rel="lrdd" template="${urls.lrddTemplate}"/>
</XRD>`, 200, XRD);
});

webfingerRouter.get('/.well-known/webfinger', requireInstanceConfig(), async (c) => {
  const instance = c.get('instance');
  const urls = accountUrls(instance);
  const resource = c.req.query('resource');
  if (!resource) {
    return c.json({ links: [{ rel: 'lrdd', template: urls.lrddTemplate }] }, 200, JRD);
  }
  if (!isAccountResource(resource, instance)) return notFound(c);

  return c.json({
    subject: resource,
    links: [
      {
        href: urls.storageRoot,
        rel: 'http://tools.ietf.org/id/draft-dejong-remotestorage',
        type: PROTOCOL_VERSION,
        properties: {
          'http://remotestorage.io/spec/version': PROTOCOL_VERSION,
          'http://tools.ietf.org/html/rfc6749#section-4.2': urls.authorize,
        }
      },
      {
        rel: 'remoteStorage',
        api: 'simple',
        auth: urls.authorize,
        template: `${urls.storageRoot}/{category}`,
      }
    ]
  }, 200, JRD);
});

webfingerRouter.get('/webfinger/jrd', requireInstanceConfig(), async (c) => {
  const instance = c.get('instance');
  const resource = c.req.query('resource');
  if (!resource) {
    return c.json({ error: 'invalid_request' }, 400);
  }
  if (!isAccountResource(resource, instance)) return notFound(c);

  const urls = accountUrls(instance);
  return c.json({
    subject: resource,
    links: [{
      rel: 'remoteStorage',
      api: 'simple',
      auth: urls.authorize,
      template: `${urls.storageRoot}/{category}`,
    }]
  }, 200, JRD);
});

webfingerRouter.get('/webfinger/xrd', requireInstanceConfig(), async (c) => {
  const instance = c.get('instance');
  const resource = c.req.query('resource');
  if (resource !== undefined && !isAccountResource(resource, instance)) {
    return c.text('Not Found', 404);
  }

  const urls = accountUrls(instance);
  return c.text(`<?xml version="1.0" encoding="UTF-8"?>
<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd/1.0">
  <Link rel="remoteStorage" api="simple" href="${urls.storageRoot}">
    <Property type="http://tools.ietf.org/html/rfc6749#section-4.2" href="${urls.authorize}"/>
  </Link>
</XRD>`, 200, XRD);
});
