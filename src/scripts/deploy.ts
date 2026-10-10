import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withoutEmptyVars } from './setup-config';
import { DEPLOY_CONFIG, PROD_CONFIG, configArgs } from './wrangler-config';

const ROOT = process.cwd();
// RSILO_WRANGLER lets tests substitute a fake wrangler (test/deploy-script.test.ts).
const WRANGLER = process.env.RSILO_WRANGLER
  ?? join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
const prodConfigPath = join(ROOT, PROD_CONFIG);

const migrateOnly = process.argv.includes('--migrate-only');
const onCi = process.env.WORKERS_CI === '1';

const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000';

function findDatabaseId(name: string): string | undefined {
  const res = spawnSync(WRANGLER, ['d1', 'list', '--json'], { encoding: 'utf8' });
  if (res.status !== 0) return undefined;
  try {
    const list = JSON.parse(res.stdout.slice(res.stdout.indexOf('['))) as { name: string; uuid: string }[];
    return list.find((d) => d.name === name)?.uuid;
  } catch {
    return undefined;
  }
}

// On CI (Cloudflare Workers Builds) there is no local, gitignored prod config.
// Materialise one by looking the D1 database up by name, so no account-specific
// ID lives in git or in a build variable that goes stale if the database is
// recreated. RSILO_BUCKET / RSILO_DB name the resources, as for `bun run setup`.
if (!existsSync(prodConfigPath)) {
  const template = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8');
  const dbName = process.env.RSILO_DB ?? template.match(/database_name\s*=\s*"([^"]*)"/)?.[1] ?? '';
  const committedId = template.match(/database_id\s*=\s*"([^"]*)"/)?.[1];
  // A Deploy to Cloudflare fork has its real ID committed; keep it if the lookup fails.
  const dbId = findDatabaseId(dbName) ?? (committedId !== PLACEHOLDER_ID ? committedId : undefined);

  if (onCi && !dbId) {
    console.error(
      `No D1 database named '${dbName}' was found in this account. Create it with ` +
        '`bun run setup`, or set the build variable RSILO_DB to the name of your database.'
    );
    process.exit(1);
  }

  if (dbId) {
    let toml = template
      .replace(/(database_name\s*=\s*)"[^"]*"/, `$1"${dbName}"`)
      .replace(/(database_id\s*=\s*)"[^"]*"/, `$1"${dbId}"`);
    if (process.env.RSILO_BUCKET) toml = toml.replace(/(bucket_name\s*=\s*)"[^"]*"/, `$1"${process.env.RSILO_BUCKET}"`);
    writeFileSync(prodConfigPath, toml);
    console.log(`Materialised ${PROD_CONFIG} for D1 database '${dbName}' (${dbId})`);
  }
}

let args = configArgs(existsSync(prodConfigPath));
if (args.length > 0) {
  console.log(`Using ${PROD_CONFIG} (local production resource IDs)`);
} else {
  console.log('Using wrangler.toml (placeholders or Cloudflare-injected IDs)');
}

// Empty [vars] entries are placeholders (wrangler.toml ships OWNER_EMAIL
// empty for the deploy button). Deploying them would blank values the Owner set
// in the dashboard, so deploy a copy without them, and --keep-vars keeps any
// dashboard var the config does not mention.
const sourceConfig = join(ROOT, args.length > 0 ? PROD_CONFIG : 'wrangler.toml');
const sourceToml = readFileSync(sourceConfig, 'utf8');
const deployToml = withoutEmptyVars(sourceToml);
if (deployToml !== sourceToml) {
  writeFileSync(join(ROOT, DEPLOY_CONFIG), deployToml);
  args = ['--config', DEPLOY_CONFIG];
  console.log(`Leaving empty vars out of the deploy (${DEPLOY_CONFIG}); dashboard values are kept`);
}

function run(cliArgs: string[]): void {
  const res = spawnSync(WRANGLER, [...cliArgs, ...args], { stdio: 'inherit' });
  if ((res.status ?? 1) !== 0) process.exit(res.status ?? 1);
}

run(['d1', 'migrations', 'apply', 'DB', '--remote']);
if (!migrateOnly) run(['deploy', '--keep-vars']);
