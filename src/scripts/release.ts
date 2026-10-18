// The steps `bun run deploy` and `bun run setup` share between choosing a
// config and `wrangler deploy`: refuse a dev-mode config, bundle the Worker,
// then apply pending D1 migrations. Bundling first means a Worker that does not
// build never leaves the new schema behind the old code.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type Wrangler = (args: string[], capture?: boolean) => { status: number; out: string };

/** A config that would deploy dev mode (the dev identity, /debug, no rate limits). */
export function devModeProblem(vars: Record<string, string>): string | null {
  return vars.RSILO_DEV_MODE === 'true'
    ? 'RSILO_DEV_MODE=true is set in the production config. Dev mode is for local servers only; remove it from [vars] and re-run.'
    : null;
}

/** `wrangler d1 migrations list` output with nothing left to apply (checked against wrangler 4.147). */
export function noPendingMigrations(listOutput: string): boolean {
  return /No migrations to apply/.test(listOutput);
}

function bookmark(infoOutput: string): string | undefined {
  try {
    const value: unknown = JSON.parse(infoOutput.slice(infoOutput.indexOf('{')));
    if (typeof value === 'object' && value !== null && 'bookmark' in value && typeof value.bookmark === 'string') {
      return value.bookmark;
    }
  } catch {
    // fall through to the timestamp
  }
  return undefined;
}

/**
 * Bundles the Worker (unless `bundle` is false), then applies pending D1
 * migrations. Before migrating it prints how to restore D1 to this moment.
 * Returns a problem, or null when the Worker may be deployed.
 */
export function prepareRelease(wrangler: Wrangler, config: string[], { bundle = true } = {}): string | null {
  if (bundle) {
    const outdir = mkdtempSync(join(tmpdir(), 'rsilo-bundle-'));
    try {
      const built = wrangler(['deploy', '--dry-run', '--outdir', outdir, ...config], true);
      if (built.status !== 0) return `The Worker does not build, so nothing was migrated or deployed:\n${built.out}`;
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
    console.log('✓ Worker bundle builds');
  }

  const list = (): { status: number; out: string } => wrangler(['d1', 'migrations', 'list', 'DB', '--remote', ...config], true);
  const before = list();
  if (before.status !== 0) return `Could not list the D1 migrations:\n${before.out}`;
  if (noPendingMigrations(before.out)) {
    console.log('✓ D1 migrations up to date');
    return null;
  }

  const info = wrangler(['d1', 'time-travel', 'info', 'DB', '--json', ...config], true);
  const mark = info.status === 0 ? bookmark(info.out) : undefined;
  const point = mark ? `--bookmark=${mark}` : `--timestamp=${new Date().toISOString()}`;
  const flags = config.length > 0 ? ` ${config.join(' ')}` : '';
  console.log(`
Applying D1 migrations. If this release has to be undone, restore the database
to this moment and roll the Worker back (Time Travel keeps 7 days on Free, 30 on Paid):

  wrangler d1 time-travel restore DB ${point}${flags}
  wrangler rollback${flags}
`);

  if (wrangler(['d1', 'migrations', 'apply', 'DB', '--remote', ...config]).status !== 0) return 'D1 migrations failed.';
  // Answering "no" at wrangler's prompt exits 0 without applying anything.
  const after = list();
  if (after.status !== 0 || !noPendingMigrations(after.out)) {
    return 'D1 migrations were not applied, so the Worker was not deployed: the new code needs the new schema.';
  }
  return null;
}
