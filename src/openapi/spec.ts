import pkg from '../../package.json';
import { ROUTE_METADATA, OperationMeta } from './registry';
import { routeKey, specRoutes, type RouteLike } from './routes';

const VERSION = (pkg as { version?: string }).version || 'unknown';

const TAGS = [
  { name: 'Storage', description: 'RemoteStorage document and folder access.' },
  { name: 'Public files', description: "Unauthenticated access to a user's public folder." },
  { name: 'WebFinger', description: 'Discovery of the storage and auth endpoints.' },
  { name: 'OAuth', description: 'Authorization code, implicit and refresh flows.' },
  { name: 'Account', description: 'Cookie-based self-service web UI.' },
  { name: 'Admin', description: 'Operator dashboard. Requires the ADMIN_SECRET.' },
  { name: 'Debug', description: 'Read-only observability under /admin. Requires the ADMIN_SECRET.' },
  { name: 'Meta', description: 'Health and service metadata.' },
];

const SECURITY_SCHEMES = {
  bearerAuth: { type: 'http', scheme: 'bearer' },
  adminSecret: { type: 'http', scheme: 'bearer', description: 'The ADMIN_SECRET value.' },
};

function pathParameters(path: string) {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
    name: m[1],
    in: 'path' as const,
    required: true,
    schema: { type: 'string' },
  }));
}

function buildOperation(route: RouteLike, meta: OperationMeta | undefined) {
  const declared = new Set((meta?.parameters ?? []).map((p) => p.name));
  const parameters = [
    ...pathParameters(route.path).filter((p) => !declared.has(p.name)),
    ...(meta?.parameters ?? []),
  ];

  return {
    summary: meta?.summary ?? `${route.method} ${route.path}`,
    ...(meta?.description ? { description: meta.description } : {}),
    tags: meta?.tags ?? ['Other'],
    ...(meta?.security ? { security: meta.security } : {}),
    ...(parameters.length ? { parameters } : {}),
    responses: meta?.responses ?? { '200': { description: 'OK' } },
  };
}

export function buildOpenApiDocument(app: { routes: readonly RouteLike[] }) {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of specRoutes(app.routes)) {
    const meta = ROUTE_METADATA[routeKey(route.method, route.path)];
    paths[route.path] ??= {};
    paths[route.path][route.method.toLowerCase()] = buildOperation(route, meta);
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'RSilo API',
      version: VERSION,
      description:
        'The complete surface of this RemoteStorage-compatible server: storage, WebFinger, OAuth, account, admin and debug routes. ' +
        'Documentation only — the interactive request console is disabled. ' +
        'Protocol routes follow the RemoteStorage specification and the referenced RFCs. ' +
        'CORS preflight (OPTIONS) handlers are omitted.',
    },
    servers: [{ url: '/' }],
    tags: TAGS,
    components: { securitySchemes: SECURITY_SCHEMES },
    paths,
  };
}

export type OpenApiDocument = ReturnType<typeof buildOpenApiDocument>;
