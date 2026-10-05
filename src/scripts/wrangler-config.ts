export const PROD_CONFIG = 'wrangler.prod.toml';

export function configArgs(useProdConfig: boolean): string[] {
  return useProdConfig ? ['--config', PROD_CONFIG] : [];
}
