import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withoutEmptyVars } from './setup-config';
import { DEPLOY_CONFIG, PROD_CONFIG, configArgs } from './wrangler-config';

const ROOT = process.cwd();
const WRANGLER = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
const prodConfigPath = join(ROOT, PROD_CONFIG);

const migrateOnly = process.argv.includes('--migrate-only');

// On CI (Cloudflare Workers Builds) there is no local, gitignored prod config.
// Materialise one from build variables so account-specific resource IDs stay
// out of git while the deploy still targets the right D1 database.
if (!existsSync(prodConfigPath)) {
  const dbId = process.env.D1_DATABASE_ID;

  if (process.env.WORKERS_CI === '1' && !dbId) {
    console.error(
      'Workers Builds: set build variable D1_DATABASE_ID ' +
        '(Worker → Settings → Builds → Build variables), or provide a wrangler.prod.toml.'
    );
    process.exit(1);
  }

  if (dbId) {
    const toml = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8')
      .replace(/(database_id\s*=\s*)"[^"]*"/, `$1"${dbId}"`);
    writeFileSync(prodConfigPath, toml);
    console.log('Materialised wrangler.prod.toml from D1_DATABASE_ID');
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
