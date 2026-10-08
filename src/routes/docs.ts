import type { Hono } from 'hono';
import { buildOpenApiDocument } from '../openapi/spec';

/**
 * Public API reference. The spec is derived from the running app, so the page
 * always lists the complete surface. The request console ("Try it out") is
 * disabled on purpose: this page is for discovery, not for firing requests at
 * account/debug endpoints.
 */
export function apiDocsHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>RSilo API Reference</title>
</head>
<body>
  <script id="api-reference" data-url="/openapi.json"></script>
  <script>
    document.getElementById('api-reference').dataset.configuration = JSON.stringify({
      hideTestRequestButton: true,
      documentDownloadType: 'none',
      showDeveloperTools: 'never'
    });
  </script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`;
}

export function mountDocs(app: Hono): void {
  app.get('/api', (c) => c.html(apiDocsHtml()));
  app.get('/openapi.json', (c) => c.json(buildOpenApiDocument(app)));
}
