import type { OtlpTraceRequest } from '@traceforge/contracts';
import { spanEventV1Schema } from '@traceforge/contracts';
import { describe, expect, it } from 'vitest';
import { convertOtlpTrace, countSpans, type ConvertContext } from './otlp';

const RECEIVED = Date.parse('2026-10-27T14:00:00Z');
const ctx: ConvertContext = {
  projectId: '7b0b9c77-3d52-4a47-a6d9-0d2a5b2f9a10',
  receivedAt: RECEIVED,
  maxAgeMs: 14 * 86_400_000,
  maxFutureMs: 5 * 60_000,
};

const nano = (ms: number) => String(BigInt(ms) * 1_000_000n);
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

function request(
  span: Record<string, unknown>,
  resourceAttrs: Array<{ key: string; value: object }> = [],
): OtlpTraceRequest {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'checkout-api' } },
            { key: 'deployment.environment', value: { stringValue: 'production' } },
            ...resourceAttrs,
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: TRACE,
                spanId: '00f067aa0ba902b7',
                name: 'GET /api/products',
                kind: 2,
                startTimeUnixNano: nano(RECEIVED - 1000),
                endTimeUnixNano: nano(RECEIVED - 900),
                ...span,
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('convertOtlpTrace', () => {
  it('produces schema-valid events with service, environment and microsecond timing', () => {
    const res = convertOtlpTrace(
      request({
        attributes: [
          { key: 'http.method', value: { stringValue: 'GET' } },
          { key: 'http.status_code', value: { intValue: '200' } },
        ],
      }),
      ctx,
    );
    expect(res.rejected).toBe(0);
    const [event] = res.events;
    expect(event).toBeDefined();
    expect(spanEventV1Schema.safeParse(event).success).toBe(true);
    expect(event?.serviceName).toBe('checkout-api');
    expect(event?.environment).toBe('production');
    expect(event?.durationUs).toBe(100_000);
    expect(event?.parentSpanId).toBeNull();
    expect(event?.attributes['http.status_code']).toBe('200');
  });

  it('defaults missing service and environment', () => {
    const req = request({});
    req.resourceSpans![0]!.resource = { attributes: [] };
    const [event] = convertOtlpTrace(req, ctx).events;
    expect(event?.serviceName).toBe('unknown_service');
    expect(event?.environment).toBe('default');
  });

  it('treats an all-zero parent id as no parent and lowercases ids', () => {
    const [event] = convertOtlpTrace(
      request({ traceId: TRACE.toUpperCase(), parentSpanId: '0000000000000000' }),
      ctx,
    ).events;
    expect(event?.parentSpanId).toBeNull();
    expect(event?.traceId).toBe(TRACE);
  });

  it('accepts string enum kind and status', () => {
    const [event] = convertOtlpTrace(
      request({ kind: 'SPAN_KIND_CLIENT', status: { code: 'STATUS_CODE_ERROR', message: 'boom' } }),
      ctx,
    ).events;
    expect(event?.kind).toBe(3);
    expect(event?.status).toEqual({ code: 2, message: 'boom' });
  });

  it('redacts sensitive attributes before anything is published', () => {
    const res = convertOtlpTrace(
      request({
        attributes: [
          { key: 'http.request.header.authorization', value: { stringValue: 'Bearer secret' } },
          { key: 'url.full', value: { stringValue: 'https://x.test/p?token=abc' } },
        ],
      }),
      ctx,
    );
    const attrs = res.events[0]?.attributes ?? {};
    expect(attrs).not.toHaveProperty('http.request.header.authorization');
    expect(attrs['url.full']).toBe('https://x.test/p');
    expect(res.redactedAttributes).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(res.events)).not.toContain('secret');
  });

  it.each([
    ['malformed trace id', { traceId: 'nope' }],
    ['all-zero trace id', { traceId: '0'.repeat(32) }],
    ['malformed span id', { spanId: 'xyz' }],
    [
      'end before start',
      { startTimeUnixNano: nano(RECEIVED), endTimeUnixNano: nano(RECEIVED - 10) },
    ],
    [
      'older than retention',
      {
        startTimeUnixNano: nano(RECEIVED - 30 * 86_400_000),
        endTimeUnixNano: nano(RECEIVED - 30 * 86_400_000 + 5),
      },
    ],
    [
      'far in the future',
      {
        startTimeUnixNano: nano(RECEIVED + 3_600_000),
        endTimeUnixNano: nano(RECEIVED + 3_600_010),
      },
    ],
  ])('rejects %s without failing the request', (_label, overrides) => {
    const res = convertOtlpTrace(request(overrides), ctx);
    expect(res.events).toHaveLength(0);
    expect(res.rejected).toBe(1);
    expect(res.rejectionReasons.length).toBe(1);
  });

  it('keeps valid spans when others in the batch are rejected', () => {
    const req = request({});
    req.resourceSpans![0]!.scopeSpans![0]!.spans!.push({
      traceId: 'bad',
      spanId: 'bad',
      name: 'x',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
    });
    const res = convertOtlpTrace(req, ctx);
    expect(res.events).toHaveLength(1);
    expect(res.rejected).toBe(1);
    expect(countSpans(req)).toBe(2);
  });

  it('preserves nanosecond precision beyond 2^53', () => {
    const start = 1_793_100_000_123_456_789n;
    const [event] = convertOtlpTrace(
      request({
        startTimeUnixNano: start.toString(),
        endTimeUnixNano: (start + 2_000_000n).toString(),
      }),
      { ...ctx, receivedAt: Number(start / 1_000_000n) },
    ).events;
    expect(event?.startTimeUs).toBe(1_793_100_000_123_456);
    expect(event?.durationUs).toBe(2000);
  });
});
