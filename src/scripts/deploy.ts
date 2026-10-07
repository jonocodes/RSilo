import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROD_CONFIG, configArgs } from './wrangler-config';

const ROOT = process.cwd();
const WRANGLER = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
const prodConfigPath = join(ROOT, PROD_CONFIG);

const migrateOnly = process.argv.includes('--migrate-only');

// On CI (Cloudflare Workers Builds) there is no local, gitignored prod config.
// Materialise one from build variables so account-specific resource IDs stay
// out of git while the deploy still targets the right D1 database and KV namespace.
if (!existsSync(prodConfigPath)) {
  const dbId = process.env.D1_DATABASE_ID;
  const kvId = process.env.KV_NAMESPACE_ID;

  if (process.env.WORKERS_CI === '1' && (!dbId || !kvId)) {
    console.error(
      'Workers Builds: set build variables D1_DATABASE_ID and KV_NAMESPACE_ID ' +
        '(Worker → Settings → Builds → Build variables), or provide a wrangler.prod.toml.'
    );
    process.exit(1);
  }

  if (dbId && kvId) {
    const toml = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8')
      .replace(/(database_id\s*=\s*)"[^"]*"/, `$1"${dbId}"`)
      .replace(/(\[\[kv_namespaces\]\][\s\S]*?\bid\s*=\s*)"[^"]*"/, `$1"${kvId}"`);
    writeFileSync(prodConfigPath, toml);
    console.log('Materialised wrangler.prod.toml from D1_DATABASE_ID / KV_NAMESPACE_ID');
  }
}

const args = configArgs(existsSync(prodConfigPath));
if (args.length > 0) {
  console.log(`Using ${PROD_CONFIG} (local production resource IDs)`);
} else {
  console.log('Using wrangler.toml (placeholders or Cloudflare-injected IDs)');
}

function run(cliArgs: string[]): void {
  const res = spawnSync(WRANGLER, [...cliArgs, ...args], { stdio: 'inherit' });
  if ((res.status ?? 1) !== 0) process.exit(res.status ?? 1);
}

run(['d1', 'migrations', 'apply', 'DB', '--remote']);
if (!migrateOnly) run(['deploy']);
