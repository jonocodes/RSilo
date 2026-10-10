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
const FAKE_WRANGLER = `#!/usr/bin/env bash
dir="$(dirname "$0")"
echo "$*" >> "$dir/calls.log"
cfg=""; prev=""
for a in "$@"; do [ "$prev" = "--config" ] && cfg="$a"; prev="$a"; done
case "$1 $2" in
  "d1 list") if [ -f "$dir/d1.json" ]; then cat "$dir/d1.json"; else echo "Not logged in" >&2; exit 1; fi;;
  "d1 migrations") cp "\${cfg:-wrangler.toml}" "$dir/migrated.toml"; echo "migrated";;
  "deploy "*) cp "\${cfg:-wrangler.toml}" "$dir/deployed.toml"; echo "Uploaded rsilo";;
esac
`;

let dir: string;

function deploy(env: Record<string, string> = {}) {
  const res = spawnSync('bun', ['run', DEPLOY], {
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
    expect(calls().filter((c) => c.startsWith('deploy'))).toEqual([expect.stringContaining('--keep-vars')]);
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
    writeFileSync(
      join(dir, 'wrangler.prod.toml'),
      read('wrangler.toml').replace(/database_id = "[^"]*"/, `database_id = "${PROD_ID}"`)
    );
    const res = deploy();
    expect(res.status, res.out).toBe(0);
    expect(calls().some((c) => c.startsWith('d1 list'))).toBe(false);
    expect(read('deployed.toml')).toContain(`database_id = "${PROD_ID}"`);
  });
});
