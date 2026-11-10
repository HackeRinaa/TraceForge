/**
 * Captures the README screenshots from a running stack that has demo traffic (`pnpm demo:setup`, `pnpm dev:demo`,
 * `pnpm demo:traffic start`). Set PW_CHANNEL=msedge|chrome to use an installed browser.
 *
 *   pnpm screenshots
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { loadDotEnv } from '@traceforge/config';

loadDotEnv();
const WEB = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const demo = Object.fromEntries(
  readFileSync('.env.demo', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const project = demo.DEMO_PROJECT_ID ?? '';
const base = `${WEB}/projects/${project}`;
const scope = 'range=15m&env=demo';

mkdirSync('docs/screenshots', { recursive: true });
const browser = await chromium.launch({
  ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

await page.goto(`${WEB}/login`);
await page.getByLabel('Email').fill('demo@traceforge.local');
await page.getByLabel('Password').fill(process.env.DEMO_USER_PASSWORD ?? 'traceforge-demo-1');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL(/\/overview/);

const api = (path: string) =>
  page.evaluate(async (p) => (await fetch(`/api${p}`)).json() as Promise<unknown>, path);
const shot = async (name: string, url: string, ready: () => Promise<unknown>, fullPage = false) => {
  await page.goto(url);
  await ready();
  await page.waitForTimeout(1500); // let charts finish painting
  await page.screenshot({ path: `docs/screenshots/${name}.png`, fullPage });
  console.log('captured', name);
};

await shot(
  'overview',
  `${base}/overview?${scope}`,
  () => page.getByText('Slowest endpoints').waitFor(),
  true,
);
await shot('endpoints', `${base}/endpoints?${scope}`, () =>
  page.getByRole('table', { name: 'Endpoints' }).waitFor(),
);

// A slow order trace that crossed all three services.
const slow = (await api(
  `/v1/projects/${project}/traces?${scope}&route=/api/orders&minDurationMs=1000&limit=1`,
)) as { traces: Array<{ traceId: string }> };
const traceId = slow.traces[0]?.traceId;
if (traceId) {
  await shot('trace', `${base}/traces/${traceId}?${scope}`, () =>
    page.getByRole('listbox', { name: 'Spans' }).waitFor(),
  );
}
await shot('traces', `${base}/traces?${scope}`, () =>
  page.getByRole('table', { name: 'Trace search results' }).waitFor(),
);
await shot('errors', `${base}/errors?${scope}`, () =>
  page.getByRole('heading', { name: 'Errors' }).waitFor(),
);

const inc = (await api(`/v1/projects/${project}/incidents?limit=5`)) as {
  incidents: Array<{ id: string }>;
};
const incident = inc.incidents[0]?.id;
await shot('alerts', `${base}/alerts${incident ? `?incident=${incident}` : ''}`, () =>
  page.getByRole('heading', { name: 'Alerts' }).waitFor(),
);
await shot('settings', `${base}/settings`, () => page.getByText('Demo controls').waitFor(), true);

await page.emulateMedia({ colorScheme: 'light' });
await page.goto(`${base}/overview?${scope}`);
await page.evaluate(() => {
  document.documentElement.dataset.theme = 'light';
});
await page.waitForTimeout(2000);
await page.screenshot({ path: 'docs/screenshots/overview-light.png' });
console.log('captured overview-light');

await browser.close();
