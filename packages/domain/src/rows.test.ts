import type { SpanEventV1 } from '@traceforge/contracts';
import { describe, expect, it } from 'vitest';
import { deriveRows, formatClickHouseTime } from './rows';

const START_US = Date.parse('2026-10-27T14:00:00.250Z') * 1000 + 123;

function event(overrides: Partial<SpanEventV1> = {}): SpanEventV1 {
  return {
    schemaVersion: 1,
    projectId: '7b0b9c77-3d52-4a47-a6d9-0d2a5b2f9a10',
    receivedAt: Date.parse('2026-10-27T14:00:01Z'),
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    spanId: '00f067aa0ba902b7',
    parentSpanId: null,
    name: 'POST /api/orders',
    kind: 2,
    serviceName: 'checkout-api',
    environment: 'production',
    startTimeUs: START_US,
    durationUs: 125_000,
    status: { code: 0 },
    attributes: { 'http.method': 'POST', 'http.route': '/api/orders', 'http.status_code': '201' },
    resource: {},
    events: [],
    ...overrides,
  };
}

describe('formatClickHouseTime', () => {
  it('keeps microsecond precision', () => {
    expect(formatClickHouseTime(START_US, 6)).toBe('2026-10-27 14:00:00.250123');
    expect(formatClickHouseTime(START_US, 3)).toBe('2026-10-27 14:00:00.250');
  });
});

describe('deriveRows', () => {
  it('derives a request row for HTTP server spans', () => {
    const { span, request, error } = deriveRows(event(), Date.parse('2026-10-27T14:00:02Z'));
    expect(span.is_entry).toBe(1);
    expect(span.is_root).toBe(1);
    expect(span.http_status_code).toBe(201);
    expect(request).toMatchObject({
      method: 'POST',
      route: '/api/orders',
      duration_ms: 125,
      is_error: 0,
      status_code: 201,
    });
    expect(error).toBeNull();
  });

  it('does not create request rows for client or internal spans', () => {
    const { request, span } = deriveRows(event({ kind: 3, parentSpanId: '5c3e90b1d4a8e602' }), 0);
    expect(request).toBeNull();
    expect(span.is_entry).toBe(0);
    expect(span.is_root).toBe(0);
  });

  it('treats 5xx on a server span as an error even if the SDK left status unset', () => {
    const { span, request, error } = deriveRows(
      event({
        attributes: { 'http.method': 'GET', 'http.route': '/api/x', 'http.status_code': '503' },
      }),
      0,
    );
    expect(span.status_code).toBe(2);
    expect(request?.is_error).toBe(1);
    expect(error?.error_type).toBe('HTTP 503');
  });

  it('does not treat 4xx as a server error', () => {
    const { request, error } = deriveRows(
      event({
        attributes: { 'http.method': 'GET', 'http.route': '/api/x', 'http.status_code': '404' },
      }),
      0,
    );
    expect(request?.is_error).toBe(0);
    expect(error).toBeNull();
  });

  it('extracts exception details and a stable fingerprint', () => {
    const exception = (msg: string) =>
      event({
        kind: 3,
        attributes: {},
        status: { code: 2, message: 'failed' },
        events: [
          {
            name: 'exception',
            timeUs: START_US,
            attributes: { 'exception.type': 'TimeoutError', 'exception.message': msg },
          },
        ],
      });
    const a = deriveRows(exception('Timeout after 2000ms (order 11)'), 0);
    const b = deriveRows(exception('Timeout after 2400ms (order 12)'), 0);
    expect(a.error?.error_type).toBe('TimeoutError');
    expect(a.span.error_fingerprint).toBe(a.error?.fingerprint);
    expect(a.error?.fingerprint).toBe(b.error?.fingerprint);
  });

  it('is deterministic apart from the ingestion timestamp', () => {
    const a = deriveRows(event(), 1000);
    const b = deriveRows(event(), 2000);
    expect({ ...a.span, ingested_at: '' }).toEqual({ ...b.span, ingested_at: '' });
    expect(a.span.trace_id).toBe(b.span.trace_id);
  });
});
