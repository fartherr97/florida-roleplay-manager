import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js', 'packages/**/*.test.js', 'apps/**/*.test.js'],
    environment: 'node',
    globals: false,
    setupFiles: ['tests/setup.js'],
    pool: 'forks',
    // Test files run one at a time. The integration suites share a single Postgres
    // database and truncate it between tests, so running two files concurrently would
    // have them delete each other's fixtures. The whole suite takes well under a
    // minute, which is a good trade for eliminating that entire class of flakiness.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/*/src/**/*.js', 'apps/*/src/**/*.js'],
      exclude: ['**/generated/**', '**/*.test.js'],
    },
  },
});
