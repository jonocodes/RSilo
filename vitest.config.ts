import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    env: { RSILO_DEV_MODE: 'true' },
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules', 'armadietto-master'],
  },
});