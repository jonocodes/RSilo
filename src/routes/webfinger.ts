import { Hono } from 'hono';
import { PROTOCOL_VERSION } from '../protocol/constants';

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
    <a href="/admin">Admin</a>
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

webfingerRouter.get('/.well-known/host-meta', (c) => {
  const baseUrl = getBaseUrl(c);
  return c.text(`<?xml version="1.0" encoding="UTF-8"?>
<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd/1.0"
   xmlns:hm="http://host-meta.net/xrd/1.0">
  <hm:Host>${c.req.header('Host') || 'localhost'}</hm:Host>
  <Link rel="lrdd" template="${baseUrl}/webfinger/jrd?resource={uri}"/>
</XRD>`, 200, { 'Content-Type': 'application/xrd+xml' });
});

webfingerRouter.get('/.well-known/webfinger', async (c) => {
  const resource = c.req.query('resource');
  if (!resource) {
    return c.json({
      links: [{
        rel: 'lrdd',
        template: `${getBaseUrl(c)}/webfinger/jrd?resource={uri}`,
      }]
    }, 200, { 'Content-Type': 'application/jrd+json' } as any);
  }

  const user = resource.replace(/^acct:/, '').split('@')?.[0];
  if (!user) {
    return c.json({ error: 'invalid_request' }, 400);
  }

  return c.json({
    subject: resource,
    links: [
      {
        href: `${getBaseUrl(c)}/storage/${user}`,
        rel: 'http://tools.ietf.org/id/draft-dejong-remotestorage',
        type: PROTOCOL_VERSION,
        properties: {
          'http://remotestorage.io/spec/version': PROTOCOL_VERSION,
          'http://tools.ietf.org/html/rfc6749#section-4.2': `${getBaseUrl(c)}/oauth/${user}/authorize`,
        }
      },
      {
        rel: 'remoteStorage',
        api: 'simple',
        auth: `${getBaseUrl(c)}/oauth/${user}/authorize`,
        template: `${getBaseUrl(c)}/storage/${user}/{category}`,
      }
    ]
  }, 200, { 'Content-Type': 'application/jrd+json' } as any);
});

webfingerRouter.get('/webfinger/jrd', async (c) => {
  const resource = c.req.query('resource');
  const user = resource?.replace(/^acct:/, '').split('@')?.[0];

  if (!user) {
    return c.json({ error: 'invalid_request' }, 400);
  }

  return c.json({
    subject: resource,
    links: [{
      rel: 'remoteStorage',
      api: 'simple',
      auth: `${getBaseUrl(c)}/oauth/${user}/authorize`,
      template: `${getBaseUrl(c)}/storage/${user}/{category}`,
    }]
  }, 200, { 'Content-Type': 'application/jrd+json' } as any);
});

webfingerRouter.get('/webfinger/xrd', async (c) => {
  return c.text(`<?xml version="1.0" encoding="UTF-8"?>
<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd/1.0">
  <Link rel="remoteStorage" api="simple" href="${getBaseUrl(c)}/storage/">
    <Property type="http://tools.ietf.org/html/rfc6749#section-4.2" href="${getBaseUrl(c)}/oauth/"/>
  </Link>
</XRD>`, 200, { 'Content-Type': 'application/xrd+xml' });
});

webfingerRouter.get('/oauth/:user', async (c) => {
  const user = c.req.param('user');
  const baseUrl = getBaseUrl(c);

  return c.json({
    needs_grant: false,
    auth_method: 'popup',
    scopes: ['documents:rw', 'pictures:rw', 'music:rw'],
    owner: user,
    www: baseUrl,
    api: PROTOCOL_VERSION,
    auth: `${baseUrl}/oauth/${user}/authorize`,
    token_endpoint: `${baseUrl}/oauth/${user}/token`,
    storageapi: `${baseUrl}/storage/${user}`,
  }, 200, { 'Content-Type': 'application/json' } as any);
});

function getBaseUrl(c: { req: { header: (name: string) => string | undefined; url: string } }): string {
  let protocol = c.req.header('X-Forwarded-Proto');
  if (!protocol) {
    try {
      protocol = new URL(c.req.url).protocol.replace(':', '');
    } catch {
      protocol = 'https';
    }
  }
  const host = c.req.header('Host') || 'localhost';
  return `${protocol}://${host}`;
}