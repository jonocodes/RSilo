import type { Context, Next } from 'hono';

// Every route answers any origin (remoteStorage apps run on arbitrary origins)
// and never sends Access-Control-Allow-Credentials. The request's Origin is
// echoed back, so responses carry Vary: Origin for caches. Preflights are
// answered here for every path; routers define no OPTIONS handlers.
export function corsMiddleware() {
  return async (c: Context, next: Next) => {
    const origin = c.req.header('Origin');

    if (c.req.method === 'OPTIONS') {
      const headers = new Headers();
      headers.set('Access-Control-Allow-Origin', origin || '*');
      headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-Match, If-None-Match, Origin, X-Requested-With');
      headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
      headers.set('Access-Control-Max-Age', '86400');
      headers.set('Access-Control-Expose-Headers', 'ETag');
      headers.set('Vary', 'Origin');
      return new Response(null, { status: 204, headers });
    }

    await next();

    const res = c.res;
    const headers = new Headers(res.headers);
    headers.set('Access-Control-Allow-Origin', origin || '*');
    headers.set('Access-Control-Expose-Headers', 'ETag, Content-Length, Content-Type');
    headers.append('Vary', 'Origin');

    c.res = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };
}