import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const API = process.env.E2E_API_URL ?? 'http://localhost:4000';
const hex = (n: number) => randomBytes(n).toString('hex');

/** A three-span trace across two services: server root, an HTTP client call, and a downstream database span. */
function trace(opts: { durationMs: number; failed?: boolean }) {
  const now = Date.now();
  const nano = (ms: number) => String(BigInt(Math.round(ms)) * 1_000_000n);
  const traceId = hex(16);
  const root = hex(8);
  const client = hex(8);
  const str = (key: string, v: string) => ({ key, value: { stringValue: v } });
  const base = { traceId, startTimeUnixNano: nano(now - opts.durationMs - 10) };
  const end = (ms: number) => nano(now - 10 - ms);
  return {
    traceId,
    body: {
      resourceSpans: [
        {
          resource: {
            attributes: [str('service.name', 'storefront'), str('deployment.environment', 'e2e')],
          },
          scopeSpans: [
            {
              spans: [
                {
                  ...base,
                  spanId: root,
                  name: 'POST /checkout',
                  kind: 2,
                  endTimeUnixNano: nano(now - 10),
                  attributes: [
                    str('http.method', 'POST'),
                    str('http.route', '/checkout'),
                    { key: 'http.status_code', value: { intValue: opts.failed ? '500' : '200' } },
                  ],
                  status: opts.failed ? { code: 2, message: 'checkout failed' } : { code: 0 },
                },
                {
                  ...base,
                  spanId: client,
                  parentSpanId: root,
                  name: 'POST',
                  kind: 3,
                  endTimeUnixNano: end(opts.durationMs * 0.1),
                  attributes: [str('url.path', '/charge')],
                },
              ],
            },
          ],
        },
        {
          resource: {
            attributes: [str('service.name', 'payments'), str('deployment.environment', 'e2e')],
          },
          scopeSpans: [
            {
              spans: [
                {
                  ...base,
                  spanId: hex(8),
                  parentSpanId: client,
                  name: 'POST /charge',
                  kind: 2,
                  startTimeUnixNano: nano(now - opts.durationMs * 0.8),
                  endTimeUnixNano: end(opts.durationMs * 0.15),
                  attributes: [
                    str('http.method', 'POST'),
                    str('http.route', '/charge'),
                    { key: 'http.status_code', value: { intValue: '200' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

async function send(page: Page, key: string, body: unknown) {
  const res = await page.request.post(`${API}/v1/traces`, {
    headers: { authorization: `Bearer ${key}` },
    data: body,
  });
  expect(res.status()).toBe(200);
}

test('visitors must sign in; the full journey from API key to resolved incident works', async ({
  page,
  browser,
}) => {
  const email = `e2e-${hex(4)}@example.com`;
  const password = 'e2e-password-12345';

  // 1. Unauthenticated access is rejected, both in the UI and in the API.
  await page.goto('/projects/00000000-0000-4000-8000-000000000000/overview');
  await expect(page).toHaveURL(/\/login/);
  expect((await page.request.get(`${API}/v1/me`)).status()).toBe(401);

  // 2. Register through the UI.
  await page.goto('/register');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/projects$/);

  // 3. Create a project, then an API key; the secret is shown once.
  await page.getByLabel('Name').fill('Storefront');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/settings/);
  const projectId = /\/projects\/([0-9a-f-]+)\//.exec(page.url())?.[1] ?? '';
  await page.getByLabel('New key name').fill('e2e-key');
  await page.getByRole('button', { name: 'Create key' }).click();
  const secret = (await page.getByTestId('api-key-secret').textContent())?.trim() ?? '';
  expect(secret).toMatch(/^tf_live_/);
  await page.getByRole('button', { name: 'I have saved the key' }).click();
  await expect(page.getByText(secret)).toHaveCount(0); // the full secret is never shown again
  await expect(page.getByText('e2e-key')).toBeVisible();

  // 4. Before any telemetry the overview explains what to do next (empty state).
  await page.goto(`/projects/${projectId}/overview`);
  await expect(page.getByText('No telemetry in this time range')).toBeVisible();

  // 5. Create an alert rule that any real request will breach.
  await page.goto(`/projects/${projectId}/alerts?tab=rules`);
  await expect(page.getByText('No alert rules')).toBeVisible();
  await page.getByRole('button', { name: 'New alert rule' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Any latency');
  await dialog.getByLabel('Metric').selectOption('p95_latency_ms');
  await dialog.getByLabel(/Threshold/).fill('1');
  await dialog.getByLabel('Evaluation window (minutes)').fill('1');
  await dialog.getByLabel('Minimum requests').fill('1');
  await dialog.getByRole('button', { name: 'Save rule' }).click();
  await expect(page.getByText('Alert rule created')).toBeVisible();
  await expect(page.getByText('Any latency')).toBeVisible();

  // 6. Send real telemetry through the ingestion endpoint.
  const good = trace({ durationMs: 400 });
  await send(page, secret, good.body);
  await send(page, secret, trace({ durationMs: 900, failed: true }).body);

  // 7. It flows through Kafka and the worker into analytics and appears on the overview.
  await expect(async () => {
    await page.goto(`/projects/${projectId}/overview?range=15m`);
    await expect(page.getByRole('link', { name: /POST\s*\/checkout/ }).first()).toBeVisible({
      timeout: 3000,
    });
  }).toPass({ timeout: 60_000 });
  await expect(page.getByLabel('Environment')).toContainText('e2e');

  // 8. Endpoint analytics: filtering by environment and time range persist in the URL.
  await page.getByLabel('Environment').selectOption('e2e');
  await expect(page).toHaveURL(/env=e2e/);
  await page.getByRole('link', { name: 'Endpoints', exact: true }).click();
  await expect(page).toHaveURL(/env=e2e/);
  await page.getByLabel('Filter endpoints').fill('checkout');
  await expect(page.getByRole('link', { name: /POST\s*\/checkout/ })).toBeVisible();
  await page.getByLabel('Filter endpoints').fill('nothing-matches-this');
  await expect(page.getByText('No endpoints match your filter')).toBeVisible();
  await page.getByLabel('Filter endpoints').fill('');
  await page.getByRole('link', { name: /POST\s*\/checkout/ }).click();
  await expect(page.getByRole('heading', { name: '/checkout' })).toBeVisible();

  // 9. Open the trace and select a span: the waterfall shows both services and the detail panel updates in place.
  await page.goto(`/projects/${projectId}/traces/${good.traceId}?range=15m`);
  await expect(page.getByRole('heading', { name: 'Trace', exact: true })).toBeVisible();
  const options = page.getByRole('listbox', { name: 'Spans' }).getByRole('option');
  await expect(options).toHaveCount(3);
  await expect(page.getByRole('listbox', { name: 'Spans' })).toContainText('storefront');
  await expect(page.getByRole('listbox', { name: 'Spans' })).toContainText('payments');
  await options.filter({ hasText: 'POST /charge' }).last().click();
  await expect(page).toHaveURL(/span=/);
  await expect(page.getByText('payments · server')).toBeVisible();

  // 10. An unknown trace gets a clear not-found state rather than a blank page.
  await page.goto(`/projects/${projectId}/traces/${hex(16)}`);
  await expect(page.getByText('Trace not found')).toBeVisible();

  // 11. The alert fires; acknowledge and resolve it from the UI.
  await expect(async () => {
    await send(page, secret, trace({ durationMs: 700 }).body); // keep the 1-minute window populated
    await page.goto(`/projects/${projectId}/alerts`);
    await expect(page.getByRole('button', { name: /Any latency/ })).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 90_000 });
  await page.getByRole('button', { name: /Any latency/ }).click();
  await expect(page.getByText('Evidence (latest evaluation)')).toBeVisible();
  await page.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(page.getByText('Incident acknowledged')).toBeVisible();
  await expect(page.getByText('Acknowledged by E2E User')).toBeVisible();
  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(page.getByText('Incident resolved')).toBeVisible();
  await expect(page.getByText('Resolved manually by E2E User')).toBeVisible();

  // 12. Another user cannot see this project: workspace isolation holds end to end.
  const other = await (await browser.newContext()).newPage();
  const reg = await other.request.post(`${API}/v1/auth/register`, {
    headers: { origin: 'http://localhost:3000' },
    data: { email: `e2e-${hex(4)}@example.com`, name: 'Other', password },
  });
  expect(reg.status()).toBe(201);
  expect((await other.request.get(`${API}/v1/projects/${projectId}/overview`)).status()).toBe(404);
  expect((await other.request.get(`${API}/v1/projects/${projectId}/api-keys`)).status()).toBe(404);
  await other.context().close();
});

test('failed queries show a retryable error state instead of fabricated data', async ({ page }) => {
  const email = `e2e-${hex(4)}@example.com`;
  await page.goto('/register');
  await page.getByLabel('Name').fill('Err User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-password-12345');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await page.getByLabel('Name').fill('Errors');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/settings/);
  const projectId = /\/projects\/([0-9a-f-]+)\//.exec(page.url())?.[1] ?? '';

  let fail = true;
  await page.route('**/api/v1/projects/*/overview**', async (route) => {
    if (!fail) return route.continue();
    await route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'QUERY_FAILED',
          message: 'The analytics store could not answer this query.',
          requestId: 'req-e2e-1234',
        },
      }),
    });
  });
  await page.goto(`/projects/${projectId}/overview`);
  const alert = page.getByRole('alert').filter({ hasText: 'Could not load this data' });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('req-e2e-1234');
  fail = false;
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByText('No telemetry in this time range')).toBeVisible();
});

test('signing in with a wrong password is rejected, and sign-out ends the session', async ({
  page,
}) => {
  const email = `e2e-${hex(4)}@example.com`;
  await page.goto('/register');
  await page.getByLabel('Name').fill('Session User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-password-12345');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/projects$/);

  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('not-the-password-1');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Incorrect email or password')).toBeVisible();
  await page.getByLabel('Password').fill('e2e-password-12345');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/projects$/);
});
