import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROD_CONFIG, configArgs } from './wrangler-config';

const ROOT = process.cwd();
const WRANGLER = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');

const migrateOnly = process.argv.includes('--migrate-only');
const args = configArgs(existsSync(join(ROOT, PROD_CONFIG)));
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
