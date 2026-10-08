// Drives `bun run setup` end to end against a fake wrangler, so the script's
// flow (vars, two-pass PUBLIC_BASE_URL, idempotent re-run) is tested without
// touching Cloudflare.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readVars } from '../src/scripts/setup-config';

const SETUP = resolve('src/scripts/setup.ts');

const FAKE_WRANGLER = `#!/usr/bin/env bash
dir="$(dirname "$0")"
echo "$*" >> "$dir/calls.log"
case "$1 $2" in
  "whoami "*) echo "You are logged in";;
  "r2 bucket") echo "ok";;
  "d1 create") echo 'database_id = "11111111-2222-3333-4444-555555555555"';;
  "d1 migrations") echo "migrated";;
  "deploy "*)
    cfg=""; prev=""
    for a in "$@"; do [ "$prev" = "--config" ] && cfg="$a"; prev="$a"; done
    n=$(ls "$dir"/deployed-*.toml 2>/dev/null | wc -l)
    cp "$cfg" "$dir/deployed-$n.toml"
    echo "Uploaded rsilo"
    echo "  https://rsilo.test-sub.workers.dev"
    ;;
esac
`;

let dir: string;

function setup(args: string[], env: Record<string, string> = {}) {
  const res = spawnSync('bun', ['run', SETUP, ...args], {
    cwd: dir,
    encoding: 'utf8',
    input: '',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      RSILO_WRANGLER: join(dir, 'wrangler'),
      ...env,
    },
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

const prodVars = () => readVars(readFileSync(join(dir, 'wrangler.prod.toml'), 'utf8'));
const deployed = (n: number) => readVars(readFileSync(join(dir, `deployed-${n}.toml`), 'utf8'));
const calls = () => readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rsilo-setup-'));
  copyFileSync('wrangler.toml', join(dir, 'wrangler.toml'));
  writeFileSync(join(dir, 'wrangler'), FAKE_WRANGLER);
  chmodSync(join(dir, 'wrangler'), 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('bun run setup (fake wrangler)', () => {
  it('writes the vars, learns PUBLIC_BASE_URL from the first deploy, and prints the Access steps', () => {
    const res = setup(['--account-username=jono', '--owner-email', 'Me@Example.com']);
    expect(res.status, res.out).toBe(0);

    expect(prodVars()).toEqual({
      ACCOUNT_USERNAME: 'jono',
      OWNER_EMAIL: 'Me@Example.com',
      PUBLIC_BASE_URL: 'https://rsilo.test-sub.workers.dev',
    });
    expect(readFileSync(join(dir, 'wrangler.prod.toml'), 'utf8')).toContain('11111111-2222-3333-4444-555555555555');

    // First deploy has no PUBLIC_BASE_URL at all (never an empty one); the second has it.
    expect(deployed(0)).toEqual({ ACCOUNT_USERNAME: 'jono', OWNER_EMAIL: 'Me@Example.com' });
    expect(deployed(1).PUBLIC_BASE_URL).toBe('https://rsilo.test-sub.workers.dev');
    expect(calls().filter((c) => c.startsWith('deploy'))).toEqual(Array(2).fill(expect.stringContaining('--keep-vars')));
    expect(calls().some((c) => /secret/.test(c))).toBe(false);

    expect(res.out).toContain('jono@rsilo.test-sub.workers.dev');
    expect(res.out).toMatch(/1\. .*\n[\s\S]*domain rsilo\.test-sub\.workers\.dev, path account/);
    expect(res.out).toContain('https://one.dash.cloudflare.com/');
  });

  it('keeps existing vars on a re-run and deploys once', () => {
    expect(setup([], { ACCOUNT_USERNAME: 'jono', OWNER_EMAIL: 'me@example.com' }).status).toBe(0);
    writeFileSync(join(dir, 'calls.log'), '');
    const before = prodVars();

    const res = setup([]);
    expect(res.status, res.out).toBe(0);
    expect(prodVars()).toEqual(before);
    expect(calls().filter((c) => c.startsWith('deploy'))).toHaveLength(1);
  });

  it('changes only what is passed on a re-run', () => {
    expect(setup(['--account-username=jono', '--owner-email=me@example.com']).status).toBe(0);
    expect(setup(['--owner-email=new@example.com']).status).toBe(0);
    expect(prodVars()).toMatchObject({ ACCOUNT_USERNAME: 'jono', OWNER_EMAIL: 'new@example.com' });
  });

  it('binds the Worker to the bucket and database it created when RSILO_BUCKET / RSILO_DB are set', () => {
    const res = setup(['--account-username=jono', '--owner-email=me@example.com'], {
      RSILO_BUCKET: 'rsilo-other',
      RSILO_DB: 'rsilo-other-db',
    });
    expect(res.status, res.out).toBe(0);

    const prod = readFileSync(join(dir, 'wrangler.prod.toml'), 'utf8');
    expect(prod).toMatch(/^bucket_name = "rsilo-other"$/m);
    expect(prod).toMatch(/^database_name = "rsilo-other-db"$/m);
    expect(prod).not.toMatch(/"remotestorage"|"remotestorage-db"/);
    expect(calls()).toContain('r2 bucket create rsilo-other');
  });

  it('uses a given PUBLIC_BASE_URL and deploys once', () => {
    const res = setup(['--account-username=jono', '--owner-email=me@example.com', '--public-base-url=https://rsilo.test-sub.workers.dev/']);
    expect(res.status, res.out).toBe(0);
    expect(prodVars().PUBLIC_BASE_URL).toBe('https://rsilo.test-sub.workers.dev');
    expect(calls().filter((c) => c.startsWith('deploy'))).toHaveLength(1);
  });

  it('refuses invalid or missing values before touching Cloudflare', () => {
    const bad = setup(['--account-username=Jono', '--owner-email=me@example.com']);
    expect(bad.status).toBe(1);
    expect(bad.out).toMatch(/ACCOUNT_USERNAME must match/);

    const missing = setup(['--account-username=jono']);
    expect(missing.status).toBe(1);
    expect(missing.out).toMatch(/OWNER_EMAIL is not set/);

    expect(existsSync(join(dir, 'calls.log'))).toBe(false);
  });
});
