/**
 * End-to-end smoke test of a running stack: ingest a hand-built OTLP trace, then wait for it to become visible through
 * the analytics API (API -> Kafka -> worker -> ClickHouse -> API). Also checks the main rejection paths.
 *
 * Usage: pnpm smoke      (requires `pnpm demo:setup` and running api + worker)
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadDotEnv } from '@traceforge/config';

loadDotEnv();
const API = process.env.API_URL ?? 'http://localhost:4000';
const ORIGIN = 'http://localhost:3000';
const env = Object.fromEntries(
  readFileSync('.env.demo', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const KEY = env.TRACEFORGE_API_KEY ?? '';
const PROJECT = env.DEMO_PROJECT_ID ?? '';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const nano = (ms: number) => String(BigInt(Math.round(ms)) * 1_000_000n);
const hex = (n: number) => randomBytes(n).toString('hex');
// Each run uses its own environment so counts are not polluted by earlier runs.
const ENVIRONMENT = `smoke-${hex(3)}`;

function buildTrace(traceId: string, now: number, failed: boolean) {
  const root = hex(8);
  const start = now - 400;
  const str = (key: string, v: string) => ({ key, value: { stringValue: v } });
  const num = (key: string, v: number) => ({ key, value: { intValue: String(v) } });
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            str('service.name', 'smoke-api'),
            str('deployment.environment', ENVIRONMENT),
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId,
                spanId: root,
                name: 'POST /smoke/orders',
                kind: 2,
                startTimeUnixNano: nano(start),
                endTimeUnixNano: nano(start + 320),
                attributes: [
                  str('http.method', 'POST'),
                  str('http.route', '/smoke/orders'),
                  num('http.status_code', failed ? 500 : 201),
                ],
                status: failed ? { code: 2, message: 'order failed' } : { code: 0 },
              },
              {
                traceId,
                spanId: hex(8),
                parentSpanId: root,
                name: 'SELECT inventory',
                kind: 3,
                startTimeUnixNano: nano(start + 20),
                endTimeUnixNano: nano(start + 220),
                attributes: [
                  str('db.system', 'postgresql'),
                  str('db.statement', "SELECT * FROM stock WHERE sku = 'ABC-1' AND qty > 5"),
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

async function ingest(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${API}/v1/traces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// --- rejection paths -------------------------------------------------------------------------------------------
check(
  'invalid API key is rejected with 401',
  (await ingest({}, { authorization: 'Bearer tf_live_' + 'x'.repeat(43) })).status === 401,
);
check(
  'missing API key is rejected with 401',
  (
    await fetch(`${API}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
  ).status === 401,
);
check(
  'protobuf content type is rejected with 415',
  (await ingest('x', { 'content-type': 'application/x-protobuf' })).status === 415,
);
check('malformed JSON is rejected with 400', (await ingest('{not json')).status === 400);
check('wrong shape is rejected with 400', (await ingest({ resourceSpans: 'nope' })).status === 400);

// --- happy path ------------------------------------------------------------------------------------------------
const traceId = hex(16);
const sentAt = Date.now();
const payload = buildTrace(traceId, sentAt, false);
const res = await ingest(payload);
check('valid trace is accepted (200)', res.status === 200, `HTTP ${res.status}`);
const failedTraceId = hex(16);
check(
  'failing trace is accepted (200)',
  (await ingest(buildTrace(failedTraceId, Date.now(), true))).status === 200,
);
// The identical payload again, as an at-least-once retry from an exporter would deliver it.
check('duplicate delivery is accepted (200)', (await ingest(payload)).status === 200);

// --- sign in and wait for visibility ---------------------------------------------------------------------------
const login = await fetch(`${API}/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: ORIGIN },
  body: JSON.stringify({
    email: 'demo@traceforge.local',
    password: process.env.DEMO_USER_PASSWORD ?? 'traceforge-demo-1',
  }),
});
check('demo user can sign in', login.ok, `HTTP ${login.status}`);
const cookie = (login.headers.getSetCookie()[0] ?? '').split(';')[0] ?? '';
const get = (path: string) => fetch(`${API}${path}`, { headers: { cookie } });

let visibleMs: number | null = null;
for (let i = 0; i < 60 && visibleMs === null; i++) {
  const t = await get(`/v1/projects/${PROJECT}/traces/${traceId}`);
  if (t.ok) visibleMs = Date.now() - sentAt;
  else await new Promise((r) => setTimeout(r, 500));
}
check(
  'trace becomes queryable',
  visibleMs !== null,
  visibleMs !== null ? `visible after ${visibleMs} ms` : 'timed out after 30 s',
);

if (visibleMs !== null) {
  const detail = (await (await get(`/v1/projects/${PROJECT}/traces/${traceId}`)).json()) as {
    spans: Array<{ name: string; attributes: Record<string, string> }>;
  };
  check(
    'trace has both spans, deduplicated',
    detail.spans.length === 2,
    `${detail.spans.length} spans`,
  );
  const db = detail.spans.find((s) => s.name === 'SELECT inventory');
  check(
    'SQL literals were masked before storage',
    db?.attributes['db.statement'] === 'SELECT * FROM stock WHERE sku = ? AND qty > ?',
    db?.attributes['db.statement'],
  );

  const ov = (await (
    await get(`/v1/projects/${PROJECT}/overview?range=15m&environment=${ENVIRONMENT}`)
  ).json()) as {
    totals: { requests: number; errors: number };
    slowestEndpoints: Array<{ route: string }>;
  };
  check(
    'overview counts 2 distinct requests (duplicate collapsed)',
    ov.totals.requests === 2,
    `requests=${ov.totals.requests}`,
  );
  check('overview counts the failed request', ov.totals.errors === 1, `errors=${ov.totals.errors}`);
  check(
    'endpoint ranking includes /smoke/orders',
    ov.slowestEndpoints.some((e) => e.route === '/smoke/orders'),
  );

  const errs = (await (
    await get(`/v1/projects/${PROJECT}/errors?range=15m&environment=${ENVIRONMENT}`)
  ).json()) as { groups: unknown[] };
  check(
    'error group created for the failed request',
    errs.groups.length >= 1,
    `${errs.groups.length} group(s)`,
  );
}

// --- authorization ---------------------------------------------------------------------------------------------
check(
  'analytics without a session is 401',
  (await fetch(`${API}/v1/projects/${PROJECT}/overview`)).status === 401,
);
check(
  'unknown project is 404 for a signed-in user',
  (await get('/v1/projects/00000000-0000-4000-8000-000000000000/overview')).status === 404,
);

console.log(failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} smoke check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
