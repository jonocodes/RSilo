import type { AppEnv } from './types';

const DEV_SESSION_SECRET = 'dev-session-secret-change-in-production';

type SecurityEnv = Partial<Pick<AppEnv, 'SESSION_SECRET' | 'ADMIN_SECRET' | 'JWT_SECRET' | 'RSILO_DEV_MODE'>>;

function securityEnv(env: unknown): SecurityEnv {
  return typeof env === 'object' && env !== null ? env as SecurityEnv : {};
}

export function isLocalDevelopment(env?: unknown): boolean {
  const bindings = securityEnv(env);
  if (bindings.RSILO_DEV_MODE !== undefined) {
    return bindings.RSILO_DEV_MODE === 'true';
  }
  return typeof process !== 'undefined' && process.env.RSILO_DEV_MODE === 'true';
}

export function getSessionSecret(env?: unknown): string | null {
  const secret = securityEnv(env).SESSION_SECRET;
  if (secret) return secret;
  return isLocalDevelopment(env) ? DEV_SESSION_SECRET : null;
}

export function getAdminSecret(env?: unknown): string | null {
  return securityEnv(env).ADMIN_SECRET || null;
}

export function getJwtSecret(env?: unknown): string | null {
  return securityEnv(env).JWT_SECRET || null;
}
