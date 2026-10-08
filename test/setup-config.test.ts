import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getInstanceConfig, getOwnerEmail } from '../src/config';
import {
  INSTANCE_VARS,
  REQUIRED_VARS,
  accessSteps,
  parseSetupArgs,
  readVars,
  resolveSetting,
  setVars,
  validateSetting,
  withoutEmptyVars,
  workersDevUrl,
} from '../src/scripts/setup-config';

const TEMPLATE = `name = "rsilo"
main = "src/index.ts"

[[d1_databases]]
binding = "DB"
database_id = "abc"

[vars]
# The one Account
ACCOUNT_USERNAME = ""
OWNER_EMAIL = "" # trailing comment
PUBLIC_BASE_URL = ""

[observability]
enabled = true
`;

describe('readVars', () => {
  it('reads only keys inside the [vars] table', () => {
    const toml = TEMPLATE.replace('OWNER_EMAIL = ""', 'OWNER_EMAIL = "me@example.com"');
    expect(readVars(toml)).toEqual({ ACCOUNT_USERNAME: '', OWNER_EMAIL: 'me@example.com', PUBLIC_BASE_URL: '' });
  });

  it('returns nothing when there is no [vars] table', () => {
    expect(readVars('name = "rsilo"\n[observability]\nenabled = true\n')).toEqual({});
  });

  it('decodes basic-string escapes and literal strings', () => {
    expect(readVars('[vars]\nA = "x\\"y"\nB = \'c:\\\\d\'\n')).toEqual({ A: 'x"y', B: 'c:\\\\d' });
  });
});

describe('setVars', () => {
  it('replaces existing keys in place and round-trips', () => {
    const out = setVars(TEMPLATE, { ACCOUNT_USERNAME: 'jono', OWNER_EMAIL: 'me@example.com' });
    expect(readVars(out)).toEqual({ ACCOUNT_USERNAME: 'jono', OWNER_EMAIL: 'me@example.com', PUBLIC_BASE_URL: '' });
    expect(out).toContain('# The one Account');
    expect(out).toContain('[observability]\nenabled = true');
    expect(out.match(/ACCOUNT_USERNAME/g)).toHaveLength(1);
  });

  it('adds missing keys to an existing [vars] table, not to the table after it', () => {
    const out = setVars(TEMPLATE, { MAX_OBJECT_SIZE_BYTES: '1024' });
    expect(readVars(out).MAX_OBJECT_SIZE_BYTES).toBe('1024');
    expect(out.indexOf('MAX_OBJECT_SIZE_BYTES')).toBeLessThan(out.indexOf('[observability]'));
  });

  it('creates a [vars] table when there is none', () => {
    const out = setVars('name = "rsilo"\n\n[observability]\nenabled = true\n', { OWNER_EMAIL: 'me@example.com' });
    expect(readVars(out)).toEqual({ OWNER_EMAIL: 'me@example.com' });
    expect(out).toContain('[observability]\nenabled = true');
  });

  it('escapes quotes and backslashes', () => {
    const out = setVars(TEMPLATE, { OWNER_EMAIL: 'a"b\\c@example.com' });
    expect(readVars(out).OWNER_EMAIL).toBe('a"b\\c@example.com');
  });

  it('is idempotent', () => {
    const vars = { ACCOUNT_USERNAME: 'jono', PUBLIC_BASE_URL: 'https://rsilo.me.workers.dev' };
    const once = setVars(TEMPLATE, vars);
    expect(setVars(once, vars)).toBe(once);
  });
});

describe('withoutEmptyVars', () => {
  it('drops empty placeholders so a deploy cannot blank dashboard-set values', () => {
    const toml = TEMPLATE.replace('OWNER_EMAIL = ""', 'OWNER_EMAIL = "me@example.com"');
    const out = withoutEmptyVars(toml);
    expect(readVars(out)).toEqual({ OWNER_EMAIL: 'me@example.com' });
    expect(out).toContain('# The one Account');
    expect(out).toContain('database_id = "abc"');
  });

  it('leaves a config without empty vars unchanged', () => {
    const toml = setVars(TEMPLATE, { ACCOUNT_USERNAME: 'a', OWNER_EMAIL: 'b@c', PUBLIC_BASE_URL: 'https://x.dev' });
    expect(withoutEmptyVars(toml)).toBe(toml);
  });
});

describe('validateSetting', () => {
  it('uses the same rules as the Worker config', () => {
    expect(validateSetting('ACCOUNT_USERNAME', 'jono.b-1_x')).toBeNull();
    expect(validateSetting('ACCOUNT_USERNAME', 'Jono')).toMatch(/ACCOUNT_USERNAME/);
    expect(validateSetting('ACCOUNT_USERNAME', '..')).toMatch(/ACCOUNT_USERNAME/);
    expect(validateSetting('OWNER_EMAIL', 'Me@Example.com')).toBeNull();
    expect(validateSetting('OWNER_EMAIL', 'not an email')).toMatch(/OWNER_EMAIL/);
    expect(validateSetting('PUBLIC_BASE_URL', 'https://rsilo.me.workers.dev')).toBeNull();
    expect(validateSetting('PUBLIC_BASE_URL', 'https://rsilo.me.workers.dev/account')).toMatch(/PUBLIC_BASE_URL/);
  });

  it('rejects empty values', () => {
    for (const name of INSTANCE_VARS) {
      expect(validateSetting(name, '  ')).toBe(`${name} is not set`);
    }
  });
});

describe('parseSetupArgs', () => {
  it('accepts --flag=value and --flag value forms', () => {
    expect(parseSetupArgs([
      '--account-username=jono',
      '--owner-email', 'me@example.com',
      '--public-base-url=https://rsilo.me.workers.dev',
    ])).toEqual({
      ACCOUNT_USERNAME: 'jono',
      OWNER_EMAIL: 'me@example.com',
      PUBLIC_BASE_URL: 'https://rsilo.me.workers.dev',
    });
  });

  it('rejects unknown flags and missing values', () => {
    expect(() => parseSetupArgs(['--admin-secret=x'])).toThrow(/--admin-secret/);
    expect(() => parseSetupArgs(['--owner-email'])).toThrow(/--owner-email/);
  });
});

describe('resolveSetting', () => {
  it('prefers a flag, then an env var, then the existing value', () => {
    const sources = { flags: { OWNER_EMAIL: 'flag@x.y' }, env: { OWNER_EMAIL: 'env@x.y' }, existing: { OWNER_EMAIL: 'old@x.y' } };
    expect(resolveSetting('OWNER_EMAIL', sources)).toBe('flag@x.y');
    expect(resolveSetting('OWNER_EMAIL', { ...sources, flags: {} })).toBe('env@x.y');
    expect(resolveSetting('OWNER_EMAIL', { flags: {}, env: {}, existing: sources.existing })).toBe('old@x.y');
    expect(resolveSetting('OWNER_EMAIL', { flags: {}, env: {}, existing: {} })).toBeUndefined();
  });

  it('ignores blank values', () => {
    expect(resolveSetting('OWNER_EMAIL', { flags: { OWNER_EMAIL: ' ' }, env: { OWNER_EMAIL: '' }, existing: { OWNER_EMAIL: 'old@x.y' } }))
      .toBe('old@x.y');
  });
});

describe('workersDevUrl', () => {
  it('extracts the deployed workers.dev origin', () => {
    const out = 'Uploaded rsilo (3.1 sec)\nDeployed rsilo triggers (0.5 sec)\n  https://rsilo.my-sub.workers.dev\nCurrent Version ID: 1';
    expect(workersDevUrl(out)).toBe('https://rsilo.my-sub.workers.dev');
  });

  it('returns null when there is none', () => {
    expect(workersDevUrl('Deployed rsilo triggers\n  No deploy targets')).toBeNull();
  });
});

describe('accessSteps', () => {
  const text = accessSteps('https://rsilo.my-sub.workers.dev');

  it('fills in the real hostname and the Access path', () => {
    expect(text).toContain('rsilo.my-sub.workers.dev');
    expect(text).toMatch(/path[^\n]*account/i);
    expect(text).toContain('https://one.dash.cloudflare.com/');
    expect(text).toContain('https://rsilo.my-sub.workers.dev/account');
  });

  it('numbers the steps and covers the policy and warning', () => {
    expect(text).toMatch(/^\s*1\. /m);
    expect(text).toMatch(/Self-hosted/);
    expect(text).toMatch(/one-time PIN/i);
    expect(text).toMatch(/OWNER_EMAIL/);
    expect(text).toMatch(/not.*Worker-level/i);
  });
});

describe('committed deploy config', () => {
  const toml = readFileSync('wrangler.toml', 'utf8');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

  it('declares only the required var, so the deploy button asks for exactly that', () => {
    expect(Object.keys(readVars(toml)).sort()).toEqual([...REQUIRED_VARS].sort());
  });

  it('ships an OWNER_EMAIL placeholder that never passes validation; the rest default', () => {
    const env = { ...readVars(toml), RSILO_DEV_MODE: 'false' };
    expect(getOwnerEmail(env)).toEqual({ ok: false, problem: 'OWNER_EMAIL is not set', missing: true });
    expect(getInstanceConfig(env, 'https://rsilo.me.workers.dev/x')).toEqual({
      ok: true,
      config: { accountUsername: 'me', publicBaseUrl: 'https://rsilo.me.workers.dev', publicHost: 'rsilo.me.workers.dev' },
    });
  });

  it('describes the required var, and no secret, for the deploy button', () => {
    const bindings = pkg.cloudflare.bindings as Record<string, { description: string }>;
    expect(Object.keys(bindings).sort()).toEqual([...REQUIRED_VARS].sort());
    for (const name of REQUIRED_VARS) expect(bindings[name].description.length).toBeGreaterThan(20);
  });

  it('declares no secrets', () => {
    expect(toml).not.toMatch(/SECRET/);
  });
});
