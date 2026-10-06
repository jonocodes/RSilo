import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import app from '../src/index';
import { buildOpenApiDocument } from '../src/openapi/spec';
import { ROUTE_METADATA } from '../src/openapi/registry';
import { routeKey, specRoutes } from '../src/openapi/routes';
import { renderApiMarkdown } from '../src/openapi/markdown';

const routes = specRoutes(app.routes);
const doc = buildOpenApiDocument(app);

function documentedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const [path, item] of Object.entries(doc.paths as Record<string, Record<string, unknown>>)) {
    for (const method of Object.keys(item)) keys.add(routeKey(method.toUpperCase(), path));
  }
  return keys;
}

describe('API docs', () => {
  it('serves the docs UI with the request console disabled', async () => {
    const res = await app.request('http://localhost/api');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('hideTestRequestButton');
    expect(html).toContain('@scalar/api-reference');
  });

  it('serves a valid OpenAPI document covering the full surface', async () => {
    const res = await app.request('http://localhost/openapi.json');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.openapi).toBe('3.1.0');
    expect(body.paths['/storage/{username}/{path}']).toHaveProperty('get');
    expect(body.paths['/storage/{username}/{path}']).toHaveProperty('head');
    expect(body.paths['/admin/debug/echo']).toHaveProperty('get');
    expect(body.paths['/admin/debug/echo']).toHaveProperty('post');
  });

  it('documents exactly the terminal routes the app exposes', () => {
    const documented = documentedKeys();
    const actual = new Set(routes.map((r) => routeKey(r.method, r.path)));

    const missing = [...actual].filter((k) => !documented.has(k));
    const stale = [...documented].filter((k) => !actual.has(k));
    expect(missing, `routes missing from the spec: ${missing.join(', ')}`).toEqual([]);
    expect(stale, `spec paths with no matching route: ${stale.join(', ')}`).toEqual([]);
  });

  it('has registry metadata for every documented route, and no stale metadata', () => {
    const actual = new Set(routes.map((r) => routeKey(r.method, r.path)));
    const missingMeta = [...actual].filter((k) => !ROUTE_METADATA[k]);
    const staleMeta = Object.keys(ROUTE_METADATA).filter((k) => !actual.has(k));
    expect(missingMeta, `routes without metadata: ${missingMeta.join(', ')}`).toEqual([]);
    expect(staleMeta, `metadata without a route: ${staleMeta.join(', ')}`).toEqual([]);
  });

  it('keeps the committed docs/api.md block current', () => {
    const begin = '<!-- BEGIN GENERATED API REFERENCE -->';
    const end = '<!-- END GENERATED API REFERENCE -->';
    const markdown = readFileSync(decodeURIComponent(new URL('../docs/api.md', import.meta.url).pathname), 'utf8');
    const start = markdown.indexOf(begin);
    const stop = markdown.indexOf(end);
    expect(start, 'docs/api.md is missing the generated-block markers').toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(start);

    const committed = markdown.slice(start + begin.length, stop).trim();
    expect(committed, 'run `bun run docs:api`').toBe(renderApiMarkdown(doc).trim());
  });
});
