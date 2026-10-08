// Pure helpers for `bun run setup` (src/scripts/setup.ts) and `bun run deploy`:
// Instance var validation, [vars] editing in wrangler TOML, and the manual
// Cloudflare Access steps. No I/O here, so it is unit-tested without Cloudflare.
import { accountUsernameProblem, ownerEmailProblem, publicBaseUrlProblem } from '../config';

export const INSTANCE_VARS = ['ACCOUNT_USERNAME', 'OWNER_EMAIL', 'PUBLIC_BASE_URL'] as const;
export type InstanceVar = (typeof INSTANCE_VARS)[number];
export type InstanceSettings = Partial<Record<InstanceVar, string>>;

const FIELD_RULES: Record<InstanceVar, (value: string) => string | null> = {
  ACCOUNT_USERNAME: accountUsernameProblem,
  OWNER_EMAIL: ownerEmailProblem,
  PUBLIC_BASE_URL: publicBaseUrlProblem,
};

/** The problem with a setting, using the Worker's own rules, or null if valid. */
export function validateSetting(name: InstanceVar, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return `${name} is not set`;
  return FIELD_RULES[name](trimmed);
}

const FLAGS: Record<string, InstanceVar> = {
  '--account-username': 'ACCOUNT_USERNAME',
  '--owner-email': 'OWNER_EMAIL',
  '--public-base-url': 'PUBLIC_BASE_URL',
};

/** Parses `--account-username=x` / `--account-username x` style flags. Throws on anything else. */
export function parseSetupArgs(argv: string[]): InstanceSettings {
  const out: InstanceSettings = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const name = FLAGS[flag];
    if (!name) throw new Error(`Unknown option ${flag}. Expected one of: ${Object.keys(FLAGS).join(', ')}`);
    let value: string | undefined;
    if (eq !== -1) value = arg.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) value = argv[++i];
    if (value === undefined) throw new Error(`Option ${flag} needs a value`);
    out[name] = value;
  }
  return out;
}

export interface SettingSources {
  flags: InstanceSettings;
  env: Partial<Record<string, string | undefined>>;
  existing: Record<string, string>;
}

/** First non-blank value from a flag, then an env var, then the existing config. */
export function resolveSetting(name: InstanceVar, sources: SettingSources): string | undefined {
  for (const value of [sources.flags[name], sources.env[name], sources.existing[name]]) {
    if (value !== undefined && value.trim()) return value.trim();
  }
  return undefined;
}

// --- Minimal [vars] editing -------------------------------------------------
// Wrangler configs here are generated from the committed wrangler.toml, so a
// line-based editor for `KEY = "value"` lines in the [vars] table is enough.

const HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/;
const KEY_LINE = /^(\s*)([A-Za-z0-9_-]+)\s*=\s*(.*)$/;

interface ParsedValue {
  value: string;
  /** Text after the value, e.g. a trailing comment. */
  rest: string;
}

function parseValue(raw: string): ParsedValue {
  const basic = raw.match(/^"((?:[^"\\]|\\.)*)"(.*)$/);
  if (basic) return { value: JSON.parse(`"${basic[1]}"`) as string, rest: basic[2] };
  const literal = raw.match(/^'([^']*)'(.*)$/);
  if (literal) return { value: literal[1], rest: literal[2] };
  const hash = raw.indexOf('#');
  return hash === -1
    ? { value: raw.trim(), rest: '' }
    : { value: raw.slice(0, hash).trim(), rest: ` ${raw.slice(hash)}` };
}

function encodeValue(value: string): string {
  return JSON.stringify(value);
}

/** Line range [start, end) of the [vars] table body, or null when absent. */
function varsRange(lines: string[]): { header: number; end: number } | null {
  const header = lines.findIndex((line) => line.match(HEADER)?.[1] === 'vars' && !line.trim().startsWith('[['));
  if (header === -1) return null;
  let end = lines.length;
  for (let i = header + 1; i < lines.length; i++) {
    if (HEADER.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { header, end };
}

/** Values of the [vars] table. */
export function readVars(toml: string): Record<string, string> {
  const lines = toml.split('\n');
  const range = varsRange(lines);
  const vars: Record<string, string> = {};
  if (!range) return vars;
  for (let i = range.header + 1; i < range.end; i++) {
    const m = lines[i].match(KEY_LINE);
    if (m) vars[m[2]] = parseValue(m[3]).value;
  }
  return vars;
}

/** Sets [vars] entries, replacing existing keys in place and adding the rest. */
export function setVars(toml: string, vars: Record<string, string>): string {
  const lines = toml.split('\n');
  const range = varsRange(lines);
  if (!range) {
    const body = Object.entries(vars).map(([key, value]) => `${key} = ${encodeValue(value)}`);
    const base = toml.endsWith('\n') ? toml : `${toml}\n`;
    return `${base}\n[vars]\n${body.join('\n')}\n`;
  }

  const pending = new Map(Object.entries(vars));
  let lastKey = range.header;
  for (let i = range.header + 1; i < range.end; i++) {
    const m = lines[i].match(KEY_LINE);
    if (!m) continue;
    lastKey = i;
    const next = pending.get(m[2]);
    if (next === undefined) continue;
    lines[i] = `${m[1]}${m[2]} = ${encodeValue(next)}${parseValue(m[3]).rest}`;
    pending.delete(m[2]);
  }
  const added = [...pending].map(([key, value]) => `${key} = ${encodeValue(value)}`);
  lines.splice(lastKey + 1, 0, ...added);
  return lines.join('\n');
}

/**
 * Drops empty-string [vars] entries. The committed wrangler.toml declares the
 * Instance vars empty so the deploy button asks for them; deploying those
 * placeholders would blank values the Owner set in the dashboard.
 */
export function withoutEmptyVars(toml: string): string {
  const lines = toml.split('\n');
  const range = varsRange(lines);
  if (!range) return toml;
  const kept = lines.filter((line, i) => {
    if (i <= range.header || i >= range.end) return true;
    const m = line.match(KEY_LINE);
    return !m || parseValue(m[3]).value !== '';
  });
  return kept.join('\n');
}

/** The workers.dev origin printed by `wrangler deploy`, if any. */
export function workersDevUrl(deployOutput: string): string | null {
  return deployOutput.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev/i)?.[0] ?? null;
}

export const ZERO_TRUST_DASHBOARD_URL = 'https://one.dash.cloudflare.com/';

/** Numbered manual Cloudflare Access steps for this Instance (see README). */
export function accessSteps(publicBaseUrl: string, ownerEmail?: string): string {
  const host = new URL(publicBaseUrl).host;
  const email = ownerEmail ? `${ownerEmail} (your OWNER_EMAIL)` : 'your OWNER_EMAIL';
  return `Last step: protect /account with Cloudflare Access (about 5 minutes).

Open ${ZERO_TRUST_DASHBOARD_URL} (Cloudflare Zero Trust), then:

  1. If asked, pick a team name and the Free plan.
  2. Go to Access → Applications → Add an application → Self-hosted.
  3. Add a public hostname: domain ${host}, path account
  4. Add a policy: action Allow, Include → Emails → ${email}
  5. Under login methods, keep One-time PIN (or choose another identity provider).
  6. Save the application.
  7. Open ${new URL('/account', publicBaseUrl).href} and sign in.

Do not use the Worker-level "protect this Worker" / workers.dev Access toggle
in the Worker's settings: it gates the whole Worker, including /storage and
WebFinger, so your apps could no longer sync.`;
}
