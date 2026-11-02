import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    env: { RSILO_DEV_MODE: 'true' },
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules', 'armadietto-master'],
    // The setup/deploy script and e2e suites spawn Bun processes. On a cold,
    // shared machine (Workers Builds runs the suite before every deploy) one
    // spawn took 17s, far past vitest's 5s/10s defaults.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Security events (services/security-log.ts) would flood the output of
    // every test that is refused on purpose; test/security-log.test.ts spies on them.
    onConsoleLog: (log) => !log.startsWith('{"event":'),
  },
});
