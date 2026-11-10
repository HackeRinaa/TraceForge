/**
 * Reproducible ingestion load test against a running stack (api + worker + infrastructure).
 *
 *   pnpm loadtest [--rate 500] [--duration 30] [--concurrency 16] [--spans-per-request 20] [--payload-bytes 0]
 *
 * --rate               target spans per second (open loop: requests are scheduled on a clock, not when the last one ends)
 * --duration           seconds of sustained load
 * --concurrency        maximum in-flight ingestion requests
 * --spans-per-request  spans per OTLP request
 * --payload-bytes      extra attribute padding per span (to vary message size)
 *
 * Measures: ingestion throughput and response latency (p50/p95/p99), end-to-end visibility delay for marker traces,
 * consumer lag and failure counters from the worker, process CPU and memory, and dashboard query latency afterwards.
 * Results are printed and written to bench/results/. Requires `pnpm demo:setup` (for an API key and a user).
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { loadDotEnv } from '@traceforge/config';

loadDotEnv();

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : fallback;
  if (!Number.isFinite(v) || v <= 0) throw new Error(`--${name} must be a positive number`);
  return v;
}

const RATE = arg('rate', 500);
const DURATION = arg('duration', 30);
const CONCURRENCY = arg('concurrency', 16);
const SPANS_PER_REQUEST = arg('spans-per-request', 20);
const PAYLOAD_BYTES = Math.floor(arg('payload-bytes', 1)) - 1;

const API = process.env.API_URL ?? 'http://localhost:4000';
const WORKER = process.env.WORKER_URL ?? 'http://localhost:4001';
const demo = Object.fromEntries(
  readFileSync('.env.demo', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const KEY = demo.TRACEFORGE_API_KEY ?? '';
const PROJECT = demo.DEMO_PROJECT_ID ?? '';
const RUN_ENV = `load-${randomBytes(3).toString('hex')}`;

const hex = (n: number) => randomBytes(n).toString('hex');
const nano = (ms: number) => String(BigInt(Math.round(ms)) * 1_000_000n);
const pad = PAYLOAD_BYTES > 0 ? 'p'.repeat(PAYLOAD_BYTES) : '';

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;
}
const summarize = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  const r = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);
  return {
    count: s.length,
    p50: r(percentile(s, 50)),
    p95: r(percentile(s, 95)),
    p99: r(percentile(s, 99)),
    max: r(s.at(-1) ?? null),
  };
};

function payload(count: number, traceIds?: string[]) {
  const now = Date.now();
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'loadgen' } },
            { key: 'deployment.environment', value: { stringValue: RUN_ENV } },
          ],
        },
        scopeSpans: [
          {
            spans: Array.from({ length: count }, (_, i) => ({
              traceId: traceIds?.[i] ?? hex(16),
              spanId: hex(8),
              name: 'GET /load/items',
              kind: 2,
              startTimeUnixNano: nano(now - 25),
              endTimeUnixNano: nano(now - 5),
              attributes: [
                { key: 'http.method', value: { stringValue: 'GET' } },
                { key: 'http.route', value: { stringValue: '/load/items' } },
                { key: 'http.status_code', value: { intValue: '200' } },
                ...(pad ? [{ key: 'load.padding', value: { stringValue: pad } }] : []),
              ],
            })),
          },
        ],
      },
    ],
  };
}

async function post(body: unknown): Promise<{ ms: number; status: number }> {
  const started = performance.now();
  try {
    const res = await fetch(`${API}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    });
    await res.arrayBuffer();
    return { ms: performance.now() - started, status: res.status };
  } catch {
    return { ms: performance.now() - started, status: 0 };
  }
}

async function metric(base: string, name: string): Promise<number | null> {
  try {
    const text = await (await fetch(`${base}/metrics`)).text();
    const line = text.split('\n').find((l) => l.startsWith(`${name} `) || l.startsWith(`${name}{`));
    return line ? Number(line.split(' ').at(-1)) : null;
  } catch {
    return null;
  }
}

const procStats = async () => ({
  apiCpu: await metric(API, 'process_cpu_seconds_total'),
  apiRss: await metric(API, 'process_resident_memory_bytes'),
  workerCpu: await metric(WORKER, 'process_cpu_seconds_total'),
  workerRss: await metric(WORKER, 'process_resident_memory_bytes'),
  workerLag: await metric(WORKER, 'traceforge_worker_consumer_lag_messages'),
  failures: await metric(WORKER, 'traceforge_worker_batch_failures_total'),
  dlq: await metric(WORKER, 'traceforge_worker_messages_dead_lettered_total'),
});

// ---- sign in for read-side measurements ----
const login = await fetch(`${API}/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
  body: JSON.stringify({
    email: 'demo@traceforge.local',
    password: process.env.DEMO_USER_PASSWORD ?? 'traceforge-demo-1',
  }),
});
if (!login.ok) throw new Error('could not sign in as the demo user; run `pnpm demo:setup`');
const cookie = (login.headers.getSetCookie()[0] ?? '').split(';')[0] ?? '';
const get = (path: string) =>
  fetch(`${API}/v1/projects/${PROJECT}/${path}`, { headers: { cookie } });

console.log(
  `load test: ${RATE} spans/s for ${DURATION}s, ${SPANS_PER_REQUEST} spans/request, concurrency ${CONCURRENCY}, environment ${RUN_ENV}`,
);
const before = await procStats();

// ---- open-loop load ----
const latencies: number[] = [];
const statuses = new Map<number, number>();
let acceptedSpans = 0;
let inFlight = 0;
let skipped = 0;
const requestsPerSecond = RATE / SPANS_PER_REQUEST;
const intervalMs = 1000 / requestsPerSecond;
const startedAt = performance.now();
const markers: Array<{ traceId: string; sentAt: number }> = [];
const pending: Promise<void>[] = [];
const watchers: Promise<void>[] = [];
const visibility: number[] = [];

async function watchMarker(traceId: string, sentAt: number): Promise<void> {
  while (Date.now() - sentAt < 120_000) {
    const r = await get(`traces/${traceId}`);
    await r.arrayBuffer();
    if (r.ok) return void visibility.push(Date.now() - sentAt);
    await new Promise((r2) => setTimeout(r2, 100));
  }
}

let next = startedAt;
let lastMarker = startedAt;
while (performance.now() - startedAt < DURATION * 1000) {
  const wait = next - performance.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  next += intervalMs;
  if (inFlight >= CONCURRENCY) {
    skipped++; // the generator cannot keep up: reported, never hidden
    continue;
  }
  inFlight++;
  const isMarker = performance.now() - lastMarker >= 1000;
  const traceId = hex(16);
  if (isMarker) lastMarker = performance.now();
  const body = payload(SPANS_PER_REQUEST, isMarker ? [traceId] : undefined);
  const sentAt = Date.now();
  pending.push(
    post(body).then((r) => {
      inFlight--;
      latencies.push(r.ms);
      statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
      if (r.status === 200) {
        acceptedSpans += SPANS_PER_REQUEST;
        if (isMarker) {
          markers.push({ traceId, sentAt });
          // Poll from the moment the marker is accepted, so the delay reflects when it became queryable, not when we looked.
          watchers.push(watchMarker(traceId, sentAt));
        }
      }
    }),
  );
}
await Promise.all(pending);
const sendSeconds = (performance.now() - startedAt) / 1000;
const mid = await procStats();

// ---- end-to-end visibility: marker watchers were started during the run; wait for them and for the full drain ----
await Promise.all(watchers);
const waitStart = Date.now();
let drainedMs: number | null = null;
for (let i = 0; i < 600; i++) {
  const r = (await (await get(`overview?range=15m&environment=${RUN_ENV}`)).json()) as {
    totals?: { requests: number };
  };
  if ((r.totals?.requests ?? 0) >= acceptedSpans) {
    drainedMs = Date.now() - waitStart;
    break;
  }
  await new Promise((r2) => setTimeout(r2, 500));
}
// The worker samples consumer lag every 10 s; wait one interval so the value reflects the drained state.
await new Promise((r) => setTimeout(r, 11_000));
const after = await procStats();
const stored = (
  (await (await get(`overview?range=15m&environment=${RUN_ENV}`)).json()) as {
    totals: { requests: number };
  }
).totals.requests;

// ---- dashboard query latency (warm, sequential, same project) ----
const queryTimes: Record<string, number[]> = {};
for (const [name, path] of [
  ['overview', `overview?range=1h`],
  ['endpoints', `endpoints?range=1h&sort=p95`],
  ['traces', `traces?range=1h&limit=25`],
  ['errors', `errors?range=1h`],
] as const) {
  queryTimes[name] = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    const r = await get(path);
    await r.arrayBuffer();
    if (r.ok) queryTimes[name].push(performance.now() - t);
  }
}

const cpuSeconds = (a: number | null, b: number | null) =>
  a !== null && b !== null ? Math.round((b - a) * 100) / 100 : null;
const result = {
  generatedAt: new Date().toISOString(),
  environment: {
    os: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model,
    logicalCores: cpus().length,
    memoryGiB: Math.round(totalmem() / 2 ** 30),
  },
  config: {
    targetSpansPerSecond: RATE,
    durationSeconds: DURATION,
    concurrency: CONCURRENCY,
    spansPerRequest: SPANS_PER_REQUEST,
    extraPayloadBytesPerSpan: Math.max(0, PAYLOAD_BYTES),
    ingestEnvironment: RUN_ENV,
  },
  ingestion: {
    sendSeconds: Math.round(sendSeconds * 10) / 10,
    requests: latencies.length,
    skippedByGenerator: skipped,
    statusCounts: Object.fromEntries(statuses),
    acceptedSpans,
    achievedSpansPerSecond: Math.round(acceptedSpans / sendSeconds),
    responseLatencyMs: summarize(latencies),
  },
  endToEnd: {
    markerVisibilityDelayMs: summarize(visibility),
    markersSent: markers.length,
    timeToFullyDrainedAfterLoadEndMs: drainedMs,
    spansAccepted: acceptedSpans,
    requestsStoredAndCounted: stored,
  },
  pipeline: {
    consumerLagAtLoadEnd: mid.workerLag,
    consumerLagAfterDrain: after.workerLag,
    batchFailuresDuringRun:
      after.workerLag === null ? null : (after.failures ?? 0) - (before.failures ?? 0),
    // prom-client omits a labelled counter until it is first incremented, so "absent" means zero while the worker is reachable.
    deadLettersDuringRun: after.workerLag === null ? null : (after.dlq ?? 0) - (before.dlq ?? 0),
  },
  resources: {
    apiCpuSeconds: cpuSeconds(before.apiCpu, mid.apiCpu),
    workerCpuSecondsLoadAndDrain: cpuSeconds(before.workerCpu, after.workerCpu),
    apiRssMiB: mid.apiRss === null ? null : Math.round(mid.apiRss / 2 ** 20),
    workerRssMiB: after.workerRss === null ? null : Math.round(after.workerRss / 2 ** 20),
  },
  dashboardQueryLatencyMs: Object.fromEntries(
    Object.entries(queryTimes).map(([k, v]) => [k, summarize(v)]),
  ),
  notes: [
    'The load generator, API, worker, web app and all infrastructure share one machine, so CPU is contended and numbers understate dedicated hardware.',
    'Dashboard query latency is measured after the run against all data in the demo project, sequentially and warm.',
  ],
};

mkdirSync('bench/results', { recursive: true });
const file = `bench/results/${new Date().toISOString().replace(/[:.]/g, '-')}-${RATE}sps.json`;
writeFileSync(file, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
console.log(`\nWritten to ${file}`);
