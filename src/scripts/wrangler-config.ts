export const PROD_CONFIG = 'wrangler.prod.toml';
/** Gitignored copy of the chosen config with empty [vars] placeholders removed. */
export const DEPLOY_CONFIG = 'wrangler.deploy.toml';

export function configArgs(useProdConfig: boolean): string[] {
  return useProdConfig ? ['--config', PROD_CONFIG] : [];
}
