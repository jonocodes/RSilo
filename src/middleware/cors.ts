import type { Context, Next } from 'hono';

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
      return new Response(null, { status: 204, headers });
    }

    await next();

    const res = c.res;
    const headers = new Headers(res.headers);
    headers.set('Access-Control-Allow-Origin', origin || '*');
    headers.set('Access-Control-Expose-Headers', 'ETag, Content-Length, Content-Type');

    c.res = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };
}