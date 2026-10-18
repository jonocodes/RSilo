// Drives `bun run deploy` against a fake wrangler, so the CI path (no local
// wrangler.prod.toml, as on Cloudflare Workers Builds) is tested without
// touching Cloudflare.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const DEPLOY = resolve('src/scripts/deploy.ts');
const PROD_ID = '03fa4c6b-ebff-4588-a2f5-bb11ff5a14ad';

// `d1 list --json` answers from $dir/d1.json; deploy copies the config it used.
// One migration is pending until `migrations apply` runs, unless $dir/decline
// exists (the Owner answered "n" at wrangler's prompt, which exits 0). A
// $dir/broken file makes the bundle fail to build.
const FAKE_WRANGLER = `#!/usr/bin/env bash
dir="$(dirname "$0")"
echo "$*" >> "$dir/calls.log"
cfg=""; prev=""
for a in "$@"; do [ "$prev" = "--config" ] && cfg="$a"; prev="$a"; done
case "$1 $2 $3" in
  "d1 list "*) if [ -f "$dir/d1.json" ]; then cat "$dir/d1.json"; else echo "Not logged in" >&2; exit 1; fi;;
  "d1 migrations list") if [ -f "$dir/applied" ]; then echo "No migrations to apply!"; else echo "Migrations to be applied: 0006_refresh_expiry.sql"; fi;;
  "d1 migrations apply") cp "\${cfg:-wrangler.toml}" "$dir/migrated.toml"; [ -f "$dir/decline" ] || touch "$dir/applied"; echo "migrated";;
  "d1 time-travel info") echo '{"bookmark": "00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683"}';;
  "deploy --dry-run "*) if [ -f "$dir/broken" ]; then echo "Build failed: no such module" >&2; exit 1; fi; echo "--dry-run: exiting now.";;
  "deploy "*) cp "\${cfg:-wrangler.toml}" "$dir/deployed.toml"; echo "Uploaded rsilo";;
esac
`;

let dir: string;

function deploy(env: Record<string, string> = {}, args: string[] = []) {
  const res = spawnSync('bun', ['run', DEPLOY, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      RSILO_WRANGLER: join(dir, 'wrangler'),
      ...env,
    },
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

const databases = (list: { name: string; uuid: string }[]) =>
  writeFileSync(join(dir, 'd1.json'), JSON.stringify(list));
const read = (name: string) => readFileSync(join(dir, name), 'utf8');
const calls = () => (existsSync(join(dir, 'calls.log')) ? read('calls.log').trim().split('\n') : []);
const deploys = () => calls().filter((c) => c.startsWith('deploy') && !c.includes('--dry-run'));
const withProdConfig = (extra = '') => writeFileSync(
  join(dir, 'wrangler.prod.toml'),
  read('wrangler.toml').replace(/database_id = "[^"]*"/, `database_id = "${PROD_ID}"`) + extra
);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rsilo-deploy-'));
  copyFileSync('wrangler.toml', join(dir, 'wrangler.toml'));
  writeFileSync(join(dir, 'wrangler'), FAKE_WRANGLER);
  chmodSync(join(dir, 'wrangler'), 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('bun run deploy without a local wrangler.prod.toml (Workers Builds)', () => {
  it('looks the database up by name, then migrates and deploys against it', () => {
    databases([
      { name: 'other-db', uuid: '99999999-9999-9999-9999-999999999999' },
      { name: 'remotestorage-db', uuid: PROD_ID },
    ]);
    const res = deploy({ WORKERS_CI: '1' });
    expect(res.status, res.out).toBe(0);
    expect(read('migrated.toml')).toContain(`database_id = "${PROD_ID}"`);
    expect(read('deployed.toml')).toContain(`database_id = "${PROD_ID}"`);
    expect(deploys()).toEqual([expect.stringContaining('--keep-vars')]);
  });

  it('ignores a stale D1_DATABASE_ID build variable', () => {
    databases([{ name: 'remotestorage-db', uuid: PROD_ID }]);
    const res = deploy({ WORKERS_CI: '1', D1_DATABASE_ID: '4952ded9-7a41-41bf-97fd-7348ba1d47bd' });
    expect(res.status, res.out).toBe(0);
    expect(read('deployed.toml')).toContain(`database_id = "${PROD_ID}"`);
    expect(read('deployed.toml')).not.toContain('4952ded9');
  });

  it('binds the bucket and database named by RSILO_BUCKET / RSILO_DB, as setup does', () => {
    databases([{ name: 'rsilo-other-db', uuid: PROD_ID }]);
    const res = deploy({ WORKERS_CI: '1', RSILO_BUCKET: 'rsilo-other', RSILO_DB: 'rsilo-other-db' });
    expect(res.status, res.out).toBe(0);
    const toml = read('deployed.toml');
    expect(toml).toMatch(/^bucket_name = "rsilo-other"$/m);
    expect(toml).toMatch(/^database_name = "rsilo-other-db"$/m);
    expect(toml).toContain(`database_id = "${PROD_ID}"`);
  });

  it('leaves the R2 binding out when RSILO_STORAGE=s3 (files in an S3 bucket)', () => {
    databases([{ name: 'remotestorage-db', uuid: PROD_ID }]);
    const res = deploy({ WORKERS_CI: '1', RSILO_STORAGE: 's3' });
    expect(res.status, res.out).toBe(0);
    const toml = read('deployed.toml');
    expect(toml).not.toMatch(/r2_buckets|bucket_name/);
    expect(toml).toContain(`database_id = "${PROD_ID}"`);
  });

  it('fails on CI, before migrating, when no database has that name', () => {
    databases([{ name: 'something-else', uuid: PROD_ID }]);
    const res = deploy({ WORKERS_CI: '1' });
    expect(res.status).not.toBe(0);
    expect(res.out).toContain("No D1 database named 'remotestorage-db'");
    expect(calls().some((c) => c.startsWith('d1 migrations') || c.startsWith('deploy'))).toBe(false);
  });

  it('keeps a real database_id already in wrangler.toml (Deploy to Cloudflare forks) when the lookup fails', () => {
    writeFileSync(
      join(dir, 'wrangler.toml'),
      read('wrangler.toml').replace(/database_id = "[^"]*"/, `database_id = "${PROD_ID}"`)
    );
    const res = deploy({ WORKERS_CI: '1' });
    expect(res.status, res.out).toBe(0);
    expect(read('deployed.toml')).toContain(`database_id = "${PROD_ID}"`);
  });
});

describe('bun run deploy with a local wrangler.prod.toml', () => {
  it('uses it as is and does not look anything up', () => {
    withProdConfig();
    const res = deploy();
    expect(res.status, res.out).toBe(0);
    expect(calls().some((c) => c.startsWith('d1 list'))).toBe(false);
    expect(read('deployed.toml')).toContain(`database_id = "${PROD_ID}"`);
  });
});

describe('bun run deploy safety', () => {
  it('bundles, prints how to restore D1, migrates, then deploys, in that order', () => {
    withProdConfig();
    const res = deploy();
    expect(res.status, res.out).toBe(0);
    expect(calls().map((c) => c.split(' --')[0])).toEqual([
      'deploy',
      'd1 migrations list DB',
      'd1 time-travel info DB',
      'd1 migrations apply DB',
      'd1 migrations list DB',
      'deploy',
    ]);
    expect(calls()[0]).toContain('--dry-run');
    expect(res.out).toContain('wrangler d1 time-travel restore DB --bookmark=00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683 --config wrangler.deploy.toml');
    expect(res.out).toContain('wrangler rollback --config wrangler.deploy.toml');
  });

  it('skips the migration step when nothing is pending', () => {
    withProdConfig();
    writeFileSync(join(dir, 'applied'), '');
    const res = deploy();
    expect(res.status, res.out).toBe(0);
    expect(calls().some((c) => c.startsWith('d1 migrations apply') || c.startsWith('d1 time-travel'))).toBe(false);
    expect(deploys()).toHaveLength(1);
  });

  it('migrates and deploys nothing when the Worker does not build', () => {
    withProdConfig();
    writeFileSync(join(dir, 'broken'), '');
    const res = deploy();
    expect(res.status).not.toBe(0);
    expect(res.out).toContain('does not build');
    expect(res.out).toContain('no such module');
    expect(calls().some((c) => c.startsWith('d1 migrations'))).toBe(false);
    expect(deploys()).toHaveLength(0);
  });

  it('does not deploy when the migrations were declined at the prompt', () => {
    withProdConfig();
    writeFileSync(join(dir, 'decline'), '');
    const res = deploy();
    expect(res.status).not.toBe(0);
    expect(res.out).toContain('D1 migrations were not applied');
    expect(deploys()).toHaveLength(0);
  });

  it('refuses a production config that enables RSILO_DEV_MODE, before touching Cloudflare', () => {
    withProdConfig('RSILO_DEV_MODE = "true"\n');
    const res = deploy();
    expect(res.status).not.toBe(0);
    expect(res.out).toContain('RSILO_DEV_MODE=true');
    expect(calls()).toEqual([]);
  });

  it('--migrate-only migrates without bundling or deploying', () => {
    withProdConfig();
    const res = deploy({}, ['--migrate-only']);
    expect(res.status, res.out).toBe(0);
    expect(calls().some((c) => c.startsWith('deploy'))).toBe(false);
    expect(calls()).toContainEqual(expect.stringMatching(/^d1 migrations apply DB --remote/));
  });
});
