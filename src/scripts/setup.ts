// `bun run setup`: provisions R2 + D1, writes wrangler.prod.toml (resource IDs
// and the Instance vars), migrates, deploys, and prints the manual Cloudflare
// Access steps. Sets no secrets. Safe to re-run: existing vars are kept unless
// changed. Pure logic lives in ./setup-config.ts (unit-tested).
//
// Non-interactive use: pass --account-username, --owner-email and optionally
// --public-base-url (or the env vars of the same names as the Worker vars).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  accessSteps,
  parseSetupArgs,
  readVars,
  resolveSetting,
  setVars,
  validateSetting,
  withoutEmptyVars,
  workersDevUrl,
  type InstanceSettings,
  type InstanceVar,
} from './setup-config';
import { PROD_CONFIG } from './wrangler-config';

const ROOT = process.cwd();
// RSILO_WRANGLER lets tests substitute a fake wrangler (test/setup-script.test.ts).
const WRANGLER = process.env.RSILO_WRANGLER
  ?? join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
const CONFIG = join(ROOT, 'wrangler.toml');
const PROD_CONFIG_PATH = join(ROOT, PROD_CONFIG);

const BUCKET = process.env.RSILO_BUCKET ?? 'remotestorage';
const DB_NAME = process.env.RSILO_DB ?? 'remotestorage-db';

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

function parseJsonArray(raw: string): any[] {
  const start = raw.indexOf('[');
  if (start === -1) return [];
  try {
    return JSON.parse(raw.slice(start));
  } catch {
    return [];
  }
}

const PROMPTS: Record<'ACCOUNT_USERNAME' | 'OWNER_EMAIL', string> = {
  ACCOUNT_USERNAME: 'Storage username (lowercase letters, digits, . _ -)',
  OWNER_EMAIL: 'Your email (the one you will allow in Cloudflare Access)',
};

let flags: InstanceSettings;
try {
  flags = parseSetupArgs(process.argv.slice(2));
} catch (err) {
  fail((err as Error).message);
}

const existingVars = existsSync(PROD_CONFIG_PATH) ? readVars(readFileSync(PROD_CONFIG_PATH, 'utf8')) : {};
const sources = { flags, env: process.env, existing: existingVars };
const interactive = Boolean(process.stdin.isTTY);

async function askSetting(name: 'ACCOUNT_USERNAME' | 'OWNER_EMAIL'): Promise<string> {
  const explicit = resolveSetting(name, { ...sources, existing: {} });
  const current = resolveSetting(name, sources);
  // A flag or env var is an explicit answer; only prompt when there is none.
  if (explicit !== undefined || !interactive) {
    const problem = current === undefined ? `${name} is not set` : validateSetting(name, current);
    if (problem) fail(`${problem}. Pass --${name.toLowerCase().replace(/_/g, '-')}=… or set ${name}.`);
    return current!;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question(`${PROMPTS[name]}${current ? ` [${current}]` : ''}: `)).trim() || current || '';
      const problem = validateSetting(name, answer);
      if (!problem) return answer;
      console.log(`  ${problem}`);
    }
  } finally {
    rl.close();
  }
}

console.log('RSilo setup — provisioning Cloudflare resources and deploying.\n');

const settings: Partial<Record<InstanceVar, string>> = {
  ACCOUNT_USERNAME: await askSetting('ACCOUNT_USERNAME'),
  OWNER_EMAIL: await askSetting('OWNER_EMAIL'),
};

// PUBLIC_BASE_URL is the workers.dev URL, which only `wrangler deploy` reveals
// on a fresh account. Rather than ask a non-technical Owner for it, deploy once
// without it (the Instance stays on its safe "finish setup" page), read the
// URL from the deploy output, then write it and deploy again. A re-run reuses
// the stored value, and --public-base-url / PUBLIC_BASE_URL (e.g. a custom
// domain) skip the second deploy.
const knownBaseUrl = resolveSetting('PUBLIC_BASE_URL', sources);
if (knownBaseUrl !== undefined) {
  const problem = validateSetting('PUBLIC_BASE_URL', knownBaseUrl);
  if (problem) fail(problem);
  settings.PUBLIC_BASE_URL = new URL(knownBaseUrl).origin;
}

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

// Rebuilt from wrangler.toml each run; vars already in wrangler.prod.toml
// (including optional ones such as MAX_OBJECT_SIZE_BYTES) are carried over.
// Empty entries are left out so a deploy never blanks a dashboard value.
function writeProdConfig(): void {
  const template = readFileSync(CONFIG, 'utf8').replace(/(database_id\s*=\s*)"[^"]*"/, `$1"${dbId}"`);
  const vars = Object.fromEntries(
    Object.entries({ ...existingVars, ...settings }).filter((entry): entry is [string, string] => Boolean(entry[1]))
  );
  writeFileSync(PROD_CONFIG_PATH, withoutEmptyVars(setVars(template, vars)));
}

writeProdConfig();
console.log(`✓ ${PROD_CONFIG} written with resource IDs and vars (gitignored)`);

console.log('\nApplying D1 migrations…');
if (wrangler(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', PROD_CONFIG_PATH]).status !== 0) {
  fail('D1 migrations failed.');
}

function deploy(): string {
  console.log('\nDeploying…');
  const res = wrangler(['deploy', '--config', PROD_CONFIG_PATH, '--keep-vars'], true);
  console.log(res.out);
  if (res.status !== 0) fail('Deploy failed.');
  return res.out;
}

const deployedUrl = workersDevUrl(deploy());

if (!settings.PUBLIC_BASE_URL) {
  if (!deployedUrl) {
    fail(
      'Deployed, but could not find the workers.dev URL in the output. Re-run with ' +
        '--public-base-url=https://<worker>.<subdomain>.workers.dev'
    );
  }
  settings.PUBLIC_BASE_URL = deployedUrl;
  writeProdConfig();
  console.log(`✓ PUBLIC_BASE_URL set to ${deployedUrl}; deploying again so it takes effect`);
  deploy();
} else if (deployedUrl && new URL(deployedUrl).host !== new URL(settings.PUBLIC_BASE_URL).host) {
  console.log(
    `\n! PUBLIC_BASE_URL is ${settings.PUBLIC_BASE_URL} but the Worker deployed to ${deployedUrl}.\n` +
      '  That is fine for a custom domain; otherwise re-run with --public-base-url=' + deployedUrl
  );
}

const baseUrl = settings.PUBLIC_BASE_URL;
console.log(`
✔ Deployed!

  Server:          ${baseUrl}
  Storage address: ${settings.ACCOUNT_USERNAME}@${new URL(baseUrl).host}
  Account area:    ${baseUrl}/account

${accessSteps(baseUrl, settings.OWNER_EMAIL)}
`);
