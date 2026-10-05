import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const WRANGLER = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
const CONFIG = join(ROOT, 'wrangler.toml');
const PROD_CONFIG = join(ROOT, 'wrangler.prod.toml');

const BUCKET = process.env.RSILO_BUCKET ?? 'remotestorage';
const DB_NAME = process.env.RSILO_DB ?? 'remotestorage-db';
const KV_TITLE = process.env.RSILO_KV ?? 'RATE_LIMIT_KV';

function fail(msg: string): never {
  console.error(`\n✘ ${msg}\n`);
  process.exit(1);
}

function wrangler(args: string[], capture = false): { status: number; out: string } {
  const res = spawnSync(WRANGLER, args, {
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });
  return { status: res.status ?? 1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

function setSecret(name: string, value: string): void {
  const res = spawnSync(WRANGLER, ['secret', 'put', name], {
    input: value,
    encoding: 'utf8',
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if ((res.status ?? 1) !== 0) fail(`Failed to set secret ${name}`);
}

function randomHex(bytes = 32): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function parseJsonArray(raw: string): any[] {
  const start = raw.indexOf('[');
  if (start === -1) return [];
  try {
    return JSON.parse(raw.slice(start));
  } catch {
    return [];
  }
}

console.log('RSilo setup — provisioning Cloudflare resources and deploying.\n');

const who = wrangler(['whoami'], true);
if (who.status !== 0 || /not authenticated/i.test(who.out)) {
  fail('Not logged in to Cloudflare. Run `wrangler login` (or set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID), then re-run `bun run setup`.');
}
console.log('✓ Cloudflare authenticated');

const buckets = wrangler(['r2', 'bucket', 'list'], true);
if (/enable R2/i.test(buckets.out)) {
  fail('R2 is not enabled on this account. Enable it in the Cloudflare dashboard (R2 → Enable) and re-run.');
}

const r2 = wrangler(['r2', 'bucket', 'create', BUCKET], true);
if (r2.status === 0) console.log(`✓ R2 bucket '${BUCKET}' ready`);
else if (/already exists/i.test(r2.out)) console.log(`• R2 bucket '${BUCKET}' already exists`);
else fail(`Could not create R2 bucket:\n${r2.out}`);

let dbId = wrangler(['d1', 'create', DB_NAME], true).out.match(/database_id\s*=\s*"([0-9a-fA-F-]+)"/)?.[1];
if (dbId) {
  console.log(`✓ D1 database '${DB_NAME}' ready`);
} else {
  const list = wrangler(['d1', 'list', '--json'], true);
  dbId = parseJsonArray(list.out).find((d) => d.name === DB_NAME)?.uuid;
  if (!dbId) fail(`Could not create or find D1 database '${DB_NAME}'.`);
  console.log(`• D1 database '${DB_NAME}' already exists`);
}

let kvId = wrangler(['kv', 'namespace', 'create', KV_TITLE], true).out.match(/\[\[kv_namespaces\]\][\s\S]*?id\s*=\s*"([0-9a-fA-F]+)"/)?.[1];
if (kvId) {
  console.log(`✓ KV namespace '${KV_TITLE}' ready`);
} else {
  const list = wrangler(['kv', 'namespace', 'list'], true);
  kvId = parseJsonArray(list.out).find((n) => n.title === KV_TITLE)?.id;
  if (!kvId) fail(`Could not create or find KV namespace '${KV_TITLE}'.`);
  console.log(`• KV namespace '${KV_TITLE}' already exists`);
}

let toml = readFileSync(CONFIG, 'utf8');
toml = toml.replace(/(database_id\s*=\s*)"[^"]*"/, `$1"${dbId}"`);
toml = toml.replace(/(\[\[kv_namespaces\]\][\s\S]*?\bid\s*=\s*)"[^"]*"/, `$1"${kvId}"`);
writeFileSync(PROD_CONFIG, toml);
console.log('✓ wrangler.prod.toml written with resource IDs (gitignored)');

console.log('\nApplying D1 migrations…');
if (wrangler(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', PROD_CONFIG]).status !== 0) {
  fail('D1 migrations failed.');
}

console.log('\nSetting secrets…');
const adminSecret = randomHex(24);
setSecret('SESSION_SECRET', randomHex(32));
setSecret('JWT_SECRET', randomHex(32));
setSecret('ADMIN_SECRET', adminSecret);

console.log('\nDeploying…');
const deploy = wrangler(['deploy', '--config', PROD_CONFIG], true);
console.log(deploy.out);
if (deploy.status !== 0) fail('Deploy failed.');

const url = deploy.out.match(/https?:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0] ?? '<your-worker-url>';

console.log(`
✔ Setup complete!

  Server:       ${url}
  Admin page:   ${url}/admin/
  Admin secret: ${adminSecret}

Sign in to the admin page with the admin secret, create your first user,
then sign in at ${url}/account.
`.trim());
