// `bun run setup`: provisions R2 + D1, writes wrangler.prod.toml (resource IDs
// and the Instance vars), migrates, deploys, and prints the manual Cloudflare
// Access steps. Sets no secrets. Safe to re-run: existing vars are kept unless
// changed. Pure logic lives in ./setup-config.ts (unit-tested).
//
// It asks for one thing, OWNER_EMAIL. ACCOUNT_USERNAME (default "me") and
// PUBLIC_BASE_URL (default: the request's own origin, so the workers.dev URL)
// are optional overrides, e.g. for a custom domain.
//
// Non-interactive use: pass --owner-email and optionally --account-username /
// --public-base-url (or the env vars of the same names as the Worker vars).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { DEFAULT_ACCOUNT_USERNAME } from '../config';
import {
  accessSteps,
  changeOwnerEmailSteps,
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

const OWNER_EMAIL_PROMPT = 'Your email (the one you will allow in Cloudflare Access)';

let flags: InstanceSettings;
try {
  flags = parseSetupArgs(process.argv.slice(2));
} catch (err) {
  fail((err as Error).message);
}

const existingVars = existsSync(PROD_CONFIG_PATH) ? readVars(readFileSync(PROD_CONFIG_PATH, 'utf8')) : {};
const sources = { flags, env: process.env, existing: existingVars };
const interactive = Boolean(process.stdin.isTTY);

function flagName(name: InstanceVar): string {
  return `--${name.toLowerCase().replace(/_/g, '-')}`;
}

// The one prompt. A flag or env var is an explicit answer; only prompt when
// there is none (an existing value is offered as the default).
async function askOwnerEmail(): Promise<string> {
  const explicit = resolveSetting('OWNER_EMAIL', { ...sources, existing: {} });
  const current = resolveSetting('OWNER_EMAIL', sources);
  if (explicit !== undefined || !interactive) {
    const problem = current === undefined ? 'OWNER_EMAIL is not set' : validateSetting('OWNER_EMAIL', current);
    if (problem) fail(`${problem}. Pass ${flagName('OWNER_EMAIL')}=… or set OWNER_EMAIL.`);
    return current!;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question(`${OWNER_EMAIL_PROMPT}${current ? ` [${current}]` : ''}: `)).trim() || current || '';
      const problem = validateSetting('OWNER_EMAIL', answer);
      if (!problem) return answer;
      console.log(`  ${problem}`);
    }
  } finally {
    rl.close();
  }
}

// Optional overrides: never prompted for, written only when given (or kept
// from an earlier run).
function optionalSetting(name: 'ACCOUNT_USERNAME' | 'PUBLIC_BASE_URL'): string | undefined {
  const value = resolveSetting(name, sources);
  if (value === undefined) return undefined;
  const problem = validateSetting(name, value);
  if (problem) fail(`${problem}. Fix ${flagName(name)} / ${name}, or leave it out to use the default.`);
  return name === 'PUBLIC_BASE_URL' ? new URL(value).origin : value;
}

console.log('RSilo setup — provisioning Cloudflare resources and deploying.\n');

const settings: Partial<Record<InstanceVar, string>> = {
  OWNER_EMAIL: await askOwnerEmail(),
  ACCOUNT_USERNAME: optionalSetting('ACCOUNT_USERNAME'),
  PUBLIC_BASE_URL: optionalSetting('PUBLIC_BASE_URL'),
};

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
// The bucket and database names are written too, so RSILO_BUCKET / RSILO_DB
// bind the Worker to the resources created above, not the committed defaults.
function writeProdConfig(): void {
  const template = readFileSync(CONFIG, 'utf8')
    .replace(/(bucket_name\s*=\s*)"[^"]*"/, `$1"${BUCKET}"`)
    .replace(/(database_name\s*=\s*)"[^"]*"/, `$1"${DB_NAME}"`)
    .replace(/(database_id\s*=\s*)"[^"]*"/, `$1"${dbId}"`);
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

// One deploy. The Worker needs no URL of its own (it answers on whatever host
// Cloudflare routes to it); the workers.dev URL is read back only for the
// summary and the Access steps below.
console.log('\nDeploying…');
const deployResult = wrangler(['deploy', '--config', PROD_CONFIG_PATH, '--keep-vars'], true);
console.log(deployResult.out);
if (deployResult.status !== 0) fail('Deploy failed.');
const deployedUrl = workersDevUrl(deployResult.out);

const baseUrl = settings.PUBLIC_BASE_URL ?? deployedUrl;
const username = settings.ACCOUNT_USERNAME ?? DEFAULT_ACCOUNT_USERNAME;

if (!baseUrl) {
  console.log(`
✔ Deployed!

  Could not find the workers.dev URL in the deploy output. Find it in the
  Cloudflare dashboard under Workers & Pages → your Worker. Your storage address
  is ${username}@<that host>, and your account area is at <that URL>/account.

${accessSteps('https://your-worker.your-subdomain.workers.dev', settings.OWNER_EMAIL)}

${changeOwnerEmailSteps(null)}
`);
  process.exit(0);
}

if (settings.PUBLIC_BASE_URL && deployedUrl && new URL(deployedUrl).host !== new URL(settings.PUBLIC_BASE_URL).host) {
  console.log(
    `\n! PUBLIC_BASE_URL is ${settings.PUBLIC_BASE_URL} but the Worker deployed to ${deployedUrl}.\n` +
      '  That is fine for a custom domain; otherwise remove PUBLIC_BASE_URL from wrangler.prod.toml and re-run.'
  );
}

console.log(`
✔ Deployed!

  Server:          ${baseUrl}
  Storage address: ${username}@${new URL(baseUrl).host}
  Account area:    ${baseUrl}/account

${accessSteps(baseUrl, settings.OWNER_EMAIL)}

${changeOwnerEmailSteps(new URL(deployedUrl ?? baseUrl).host)}
`);
