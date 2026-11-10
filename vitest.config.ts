import { defineConfig } from 'vitest/config';

// `unit` needs no infrastructure. `integration` talks to Postgres, Kafka and ClickHouse from docker-compose.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['{packages,apps}/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/*.int.test.ts', '**/dist/**'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['{packages,apps,tests}/**/*.int.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
