import { readFileSync, writeFileSync } from 'node:fs';
import app from '../index';
import { buildOpenApiDocument } from '../openapi/spec';
import { renderApiMarkdown } from '../openapi/markdown';

const BEGIN = '<!-- BEGIN GENERATED API REFERENCE -->';
const END = '<!-- END GENERATED API REFERENCE -->';
const TARGET = decodeURIComponent(new URL('../../docs/api.md', import.meta.url).pathname);

const source = readFileSync(TARGET, 'utf8');
const start = source.indexOf(BEGIN);
const end = source.indexOf(END);

if (start === -1 || end === -1 || end < start) {
  throw new Error(`Could not find ${BEGIN} / ${END} markers in docs/api.md`);
}

const block = `${BEGIN}\n\n${renderApiMarkdown(buildOpenApiDocument(app))}\n\n${END}`;
const updated = source.slice(0, start) + block + source.slice(end + END.length);

if (updated === source) {
  console.log('docs/api.md is already up to date.');
  process.exit(0);
}

if (process.argv.includes('--check')) {
  console.error('docs/api.md is stale. Run `bun run docs:api` to regenerate it.');
  process.exit(1);
}

writeFileSync(TARGET, updated);
console.log('docs/api.md updated.');
