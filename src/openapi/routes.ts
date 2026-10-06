export interface RouteLike {
  path: string;
  method: string;
}

/**
 * CORS preflight handlers are registered explicitly for the OAuth and storage
 * routes. They are part of the HTTP surface but not useful as API documentation,
 * so the docs page omits them deliberately (the coverage test enforces this via
 * the same constant, so the exclusion is explicit rather than silent).
 */
export const IGNORED_METHODS = new Set(['OPTIONS']);

/** The docs endpoints describe the surface, so they are not part of it. */
export const IGNORED_PATHS = new Set(['/api', '/openapi.json']);

/**
 * `debugRouter.all('/echo', ...)` handles any method. We document the two
 * meaningful ones; the generator and the drift test share this list.
 */
export const ALL_HANDLER_METHODS = ['GET', 'POST'];

/**
 * Hono serves HEAD for GET handlers without registering a HEAD route, so the
 * enumerated routes never include it. Declare the real HEAD endpoints here.
 */
export const EXTRA_ROUTES: RouteLike[] = [
  { method: 'HEAD', path: '/storage/{username}/{path}' },
];

export function routeKey(method: string, path: string): string {
  return `${method} ${path}`;
}

export function normalizePath(path: string): string {
  let out = path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  out = out.replace(/\*$/, '{path}');
  if (out.length > 1 && out.endsWith('/')) out = out.replace(/\/+$/, '');
  return out;
}

function isWildcardMiddleware(path: string): boolean {
  return path === '/*' || path.endsWith('*');
}

/** Terminal (non-middleware) routes, normalised to OpenAPI-style paths. */
export function terminalRoutes(routes: readonly RouteLike[]): RouteLike[] {
  const seen = new Set<string>();
  const result: RouteLike[] = [];

  const add = (method: string, path: string) => {
    const key = routeKey(method, path);
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ method, path });
  };

  for (const route of routes) {
    const path = normalizePath(route.path);
    if (IGNORED_PATHS.has(path)) continue;

    if (route.method === 'ALL') {
      if (isWildcardMiddleware(route.path)) continue;
      for (const method of ALL_HANDLER_METHODS) add(method, path);
      continue;
    }

    if (IGNORED_METHODS.has(route.method)) continue;
    add(route.method, path);
  }

  return result;
}

/** Everything the spec should contain: enumerated routes plus declared extras. */
export function specRoutes(routes: readonly RouteLike[]): RouteLike[] {
  const seen = new Set<string>();
  const result: RouteLike[] = [];
  for (const route of [...terminalRoutes(routes), ...EXTRA_ROUTES]) {
    const key = routeKey(route.method, route.path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(route);
  }
  return result;
}
