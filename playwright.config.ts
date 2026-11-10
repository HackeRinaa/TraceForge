import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests drive the real stack (web, api, worker, Postgres, Kafka, ClickHouse). Start it first with
 * `pnpm infra:up && pnpm db:migrate && pnpm dev`. Set PW_CHANNEL=msedge or chrome to use an installed browser instead
 * of Playwright's bundled Chromium (`pnpm exec playwright install chromium`).
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
