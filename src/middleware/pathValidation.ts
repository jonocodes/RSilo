import type { Context, Next } from 'hono';
import { isValidPath } from '../protocol/constants';

export function validatePath() {
  return async (c: Context, next: Next) => {
    const path = c.req.path;

    if (!isValidPath(path)) {
      return c.text('Invalid path', 400);
    }

    await next();
  };
}