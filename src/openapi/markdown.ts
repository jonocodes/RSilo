import type { OpenApiDocument } from './spec';

const METHOD_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

interface RenderedOperation {
  method: string;
  path: string;
  summary: string;
  auth: string;
}

function authLabel(operation: Record<string, unknown>): string {
  const security = (operation.security as Array<Record<string, string[]>> | undefined) ?? [];
  const schemes = security.flatMap((entry) => Object.keys(entry));
  if (schemes.includes('cloudflareAccess')) return 'Cloudflare Access';
  if (schemes.includes('bearerAuth')) return '`Bearer`';
  return '';
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

/**
 * Renders the OpenAPI surface as Markdown, grouped by tag. The output is
 * committed into README.md between markers by `bun run docs:readme`; a test
 * fails if the committed copy is stale.
 */
export function renderApiMarkdown(doc: OpenApiDocument): string {
  const byTag = new Map<string, RenderedOperation[]>();

  for (const [path, item] of Object.entries(doc.paths as Record<string, Record<string, Record<string, unknown>>>)) {
    for (const [method, operation] of Object.entries(item)) {
      const tag = (operation.tags as string[] | undefined)?.[0] ?? 'Other';
      const ops = byTag.get(tag) ?? [];
      ops.push({
        method: method.toUpperCase(),
        path,
        summary: (operation.summary as string | undefined) ?? '',
        auth: authLabel(operation),
      });
      byTag.set(tag, ops);
    }
  }

  const tagOrder = [
    ...doc.tags.map((tag) => tag.name),
    ...[...byTag.keys()].filter((tag) => !doc.tags.some((t) => t.name === tag)).sort(),
  ];

  const sections = tagOrder
    .filter((tag) => byTag.has(tag))
    .map((tag) => {
      const ops = byTag.get(tag)!.sort((a, b) => {
        if (a.path !== b.path) return a.path < b.path ? -1 : 1;
        return METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method);
      });
      const rows = ops.map(
        (op) => `| \`${op.method}\` | \`${op.path}\` | ${op.auth} | ${escapeCell(op.summary)} |`
      );
      return [
        `### ${tag}`,
        '',
        '| Method | Path | Auth | Summary |',
        '| --- | --- | --- | --- |',
        ...rows,
      ].join('\n');
    });

  return sections.join('\n\n');
}
