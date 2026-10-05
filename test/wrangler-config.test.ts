import { describe, expect, it } from 'vitest';
import { PROD_CONFIG, configArgs } from '../src/scripts/wrangler-config';

describe('wrangler config selection', () => {
  it('uses no override when no local production config exists', () => {
    expect(configArgs(false)).toEqual([]);
  });

  it('points wrangler at the production config when present', () => {
    expect(configArgs(true)).toEqual(['--config', PROD_CONFIG]);
    expect(PROD_CONFIG).toBe('wrangler.prod.toml');
  });
});
