// Drives `bun run setup` end to end against a fake wrangler, so the script's
// flow (one prompt, one deploy, optional overrides, idempotent re-run) is tested without
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
  "secret list") if [ -f "$dir/secrets" ]; then printf '[{"name":"%s","type":"secret_text"}]\\n' "$(cat "$dir/secrets")"; else echo "[]"; fi;;
  "secret put") echo "$3" > "$dir/secrets"; cat > "$dir/secret-value";;
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
  it('with only --owner-email: writes just OWNER_EMAIL, deploys once, and prints the summary and Access steps', () => {
    const res = setup(['--owner-email', 'Me@Example.com']);
    expect(res.status, res.out).toBe(0);

    expect(prodVars()).toEqual({ OWNER_EMAIL: 'Me@Example.com' });
    expect(readFileSync(join(dir, 'wrangler.prod.toml'), 'utf8')).toContain('11111111-2222-3333-4444-555555555555');

    expect(deployed(0)).toEqual({ OWNER_EMAIL: 'Me@Example.com' });
    expect(calls().filter((c) => c.startsWith('deploy'))).toEqual([expect.stringContaining('--keep-vars')]);
    expect(calls().some((c) => /secret/.test(c))).toBe(false);

    expect(res.out).toContain('Storage address: me@rsilo.test-sub.workers.dev');
    expect(res.out).toContain('https://rsilo.test-sub.workers.dev/account');
    expect(res.out).toMatch(/1\. .*\n[\s\S]*domain rsilo\.test-sub\.workers\.dev, path account/);
    expect(res.out).toContain('https://one.dash.cloudflare.com/');
    expect(res.out).toContain('Workers & Pages → rsilo → Settings → Variables and Secrets → OWNER_EMAIL → Edit → Deploy');
    expect(res.out).toContain('Zero Trust → Access → Applications → RSilo app → Policies');
  });

  it('accepts --account-username as an optional override', () => {
    const res = setup(['--account-username=jono', '--owner-email=me@example.com']);
    expect(res.status, res.out).toBe(0);
    expect(prodVars()).toEqual({ ACCOUNT_USERNAME: 'jono', OWNER_EMAIL: 'me@example.com' });
    expect(res.out).toContain('jono@rsilo.test-sub.workers.dev');
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

describe('bun run setup with S3 storage (fake wrangler)', () => {
  const S3_FLAGS = [
    '--owner-email=me@example.com',
    '--s3-endpoint=https://s3.us-west-004.backblazeb2.com',
    '--s3-bucket=rsilo-files',
    '--s3-access-key-id=004abc',
  ];

  it('skips R2, drops the R2 binding, writes the S3 vars and sets the key as a Worker secret', () => {
    const res = setup(S3_FLAGS, { S3_SECRET_ACCESS_KEY: 'K004-very-secret' });
    expect(res.status, res.out).toBe(0);

    expect(calls().some((c) => c.startsWith('r2 '))).toBe(false);
    const prod = readFileSync(join(dir, 'wrangler.prod.toml'), 'utf8');
    expect(prod).not.toMatch(/r2_buckets|bucket_name/);
    expect(prod).toMatch(/\[\[d1_databases\]\]/);
    expect(prodVars()).toEqual({
      OWNER_EMAIL: 'me@example.com',
      S3_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com',
      S3_BUCKET: 'rsilo-files',
      S3_ACCESS_KEY_ID: '004abc',
    });

    expect(calls()).toContain('secret put S3_SECRET_ACCESS_KEY --config ' + join(dir, 'wrangler.prod.toml'));
    expect(readFileSync(join(dir, 'secret-value'), 'utf8')).toBe('K004-very-secret');
    expect(prod).not.toContain('K004-very-secret');
    expect(readFileSync(join(dir, 'deployed-0.toml'), 'utf8')).not.toContain('K004-very-secret');
    expect(res.out).not.toContain('K004-very-secret');
  });

  it('keeps the Worker secret on a re-run that does not pass one', () => {
    expect(setup(S3_FLAGS, { S3_SECRET_ACCESS_KEY: 'K004-very-secret' }).status).toBe(0);
    writeFileSync(join(dir, 'calls.log'), '');

    const res = setup([]);
    expect(res.status, res.out).toBe(0);
    expect(prodVars()).toMatchObject({ S3_BUCKET: 'rsilo-files' });
    expect(calls().some((c) => c.startsWith('secret put'))).toBe(false);
    expect(res.out).toContain('S3_SECRET_ACCESS_KEY already set');
  });

  it('warns that switching an R2 Instance to S3 does not copy its files', () => {
    expect(setup(['--owner-email=me@example.com']).status).toBe(0);
    const res = setup(S3_FLAGS, { S3_SECRET_ACCESS_KEY: 'k' });
    expect(res.status, res.out).toBe(0);
    expect(res.out).toMatch(/Files already in R2 are not copied/);
  });

  it('refuses an incomplete S3 setup, or one with no key to set, before touching Cloudflare', () => {
    const partial = setup(['--owner-email=me@example.com', '--s3-bucket=rsilo-files']);
    expect(partial.status).toBe(1);
    expect(partial.out).toMatch(/--s3-endpoint, --s3-access-key-id/);

    const badEndpoint = setup([...S3_FLAGS, '--s3-endpoint=s3.example.com'], { S3_SECRET_ACCESS_KEY: 'k' });
    expect(badEndpoint.status).toBe(1);
    expect(badEndpoint.out).toMatch(/S3_ENDPOINT must be/);

    const noKey = setup(S3_FLAGS);
    expect(noKey.status).toBe(1);
    expect(noKey.out).toMatch(/Set S3_SECRET_ACCESS_KEY/);

    expect(existsSync(join(dir, 'calls.log'))).toBe(false);
  });
});
