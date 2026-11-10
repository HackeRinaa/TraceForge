import { randomBytes } from 'node:crypto';
import type { SpanEventV1 } from '@traceforge/contracts';

export const hex = (bytes: number): string => randomBytes(bytes).toString('hex');

/** Builds a valid span event; override any field. Defaults to an HTTP server span finishing just now. */
export function spanEvent(projectId: string, over: Partial<SpanEventV1> = {}): SpanEventV1 {
  const now = Date.now();
  return {
    schemaVersion: 1,
    projectId,
    receivedAt: now,
    traceId: hex(16),
    spanId: hex(8),
    parentSpanId: null,
    name: 'GET /api/items',
    kind: 2,
    serviceName: 'it-service',
    environment: 'it',
    startTimeUs: (now - 200) * 1000,
    durationUs: 100_000,
    status: { code: 0 },
    attributes: { 'http.method': 'GET', 'http.route': '/api/items', 'http.status_code': '200' },
    resource: {},
    events: [],
    ...over,
  };
}

/** An OTLP/HTTP JSON export containing the given number of root server spans. */
export function otlpPayload(
  count: number,
  opts: { service?: string; environment?: string; status?: number; durationMs?: number } = {},
) {
  const now = Date.now();
  const nano = (ms: number) => String(BigInt(Math.round(ms)) * 1_000_000n);
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: opts.service ?? 'it-service' } },
            { key: 'deployment.environment', value: { stringValue: opts.environment ?? 'it' } },
          ],
        },
        scopeSpans: [
          {
            spans: Array.from({ length: count }, () => ({
              traceId: hex(16),
              spanId: hex(8),
              name: 'GET /api/items',
              kind: 2,
              startTimeUnixNano: nano(now - (opts.durationMs ?? 50) - 10),
              endTimeUnixNano: nano(now - 10),
              attributes: [
                { key: 'http.method', value: { stringValue: 'GET' } },
                { key: 'http.route', value: { stringValue: '/api/items' } },
                { key: 'http.status_code', value: { intValue: String(opts.status ?? 200) } },
              ],
            })),
          },
        ],
      },
    ],
  };
}

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 15_000,
  intervalMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
