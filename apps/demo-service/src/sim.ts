import { SpanKind, SpanStatusCode, trace } from '@traceforge/telemetry';

/** Deterministic PRNG (mulberry32) so a given DEMO_SEED reproduces the same traffic and fault pattern. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const SCENARIOS = {
  'slow-db': 'Database-like operations take 400-900 ms longer',
  'slow-downstream': 'The payments service responds 800-1500 ms slower',
  'intermittent-errors': 'About 18% of order creations fail with a database deadlock',
  'downstream-timeout': 'The payments service hangs, so the gateway times out after 2 s',
  'high-volume': 'Traffic generator runs at 5x the configured rate',
} as const;

export type Scenario = keyof typeof SCENARIOS;

export const isScenario = (v: string): v is Scenario => v in SCENARIOS;

/** Faults travel between demo services in this header (honoured only when DEMO_MODE is on). */
export const FAULT_HEADER = 'x-demo-faults';

export function parseFaults(header: string | string[] | undefined): Set<Scenario> {
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(isScenario),
  );
}

/**
 * Emits a CLIENT span that looks like a database call but only sleeps. The `demo.simulated` attribute marks it so
 * simulated operations are never mistaken for real database telemetry.
 */
export async function simulatedDb(operation: string, statement: string, ms: number): Promise<void> {
  await trace.getTracer('demo').startActiveSpan(
    operation,
    {
      kind: SpanKind.CLIENT,
      attributes: { 'db.system': 'postgresql', 'db.statement': statement, 'demo.simulated': true },
    },
    async (span) => {
      await sleep(ms);
      span.end();
    },
  );
}

/** Emits an INTERNAL span for a simulated unit of work. */
export async function simulatedWork(name: string, ms: number, fail?: Error): Promise<void> {
  await trace
    .getTracer('demo')
    .startActiveSpan(name, { attributes: { 'demo.simulated': true } }, async (span) => {
      await sleep(ms);
      if (fail) {
        span.recordException(fail);
        span.setStatus({ code: SpanStatusCode.ERROR, message: fail.message });
      }
      span.end();
      if (fail) throw fail;
    });
}
