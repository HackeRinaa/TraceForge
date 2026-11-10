import { deriveRows } from '@traceforge/domain';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestInfra, type TestInfra } from '../../../../tests/helpers/infra';
import { hex, spanEvent } from '../../../../tests/helpers/spans';
import { analytics, insertDerivedRows } from '../index';

describe('ClickHouse storage and analytics (real ClickHouse)', () => {
  let infra: TestInfra;
  const projectId = randomUUID();
  const otherProject = randomUUID();
  const now = Date.now();

  beforeAll(async () => {
    infra = await createTestInfra();
  });
  afterAll(async () => {
    await infra.cleanup();
  });

  const scope = () => ({
    projectId,
    from: new Date(now - 10 * 60_000),
    to: new Date(now + 60_000),
  });

  it('inserts spans, request rows and error rows', async () => {
    const trace = hex(16);
    const root = hex(8);
    const events = [
      spanEvent(projectId, {
        traceId: trace,
        spanId: root,
        name: 'POST /api/orders',
        attributes: {
          'http.method': 'POST',
          'http.route': '/api/orders',
          'http.status_code': '500',
        },
        status: { code: 2, message: 'boom' },
        durationUs: 900_000,
      }),
      spanEvent(projectId, {
        traceId: trace,
        spanId: hex(8),
        parentSpanId: root,
        kind: 3,
        name: 'SELECT',
        attributes: {},
        durationUs: 400_000,
      }),
      ...Array.from({ length: 8 }, () => spanEvent(projectId, { durationUs: 50_000 })),
      spanEvent(otherProject, { durationUs: 50_000 }), // must never appear in projectId's results
    ];
    const stats = await insertDerivedRows(
      infra.ch,
      events.map((e) => deriveRows(e, now)),
    );
    expect(stats).toEqual({ spans: 11, requests: 10, errors: 1 });

    const totals = await analytics.getTotals(infra.ch, scope());
    expect(totals.requests).toBe(9);
    expect(totals.errors).toBe(1);
    expect(totals.errorRate).toBeCloseTo((1 / 9) * 100, 5);
    expect(totals.p99).toBeGreaterThan(totals.p50 ?? 0);
  });

  it('is idempotent: re-delivered messages do not change counts', async () => {
    const before = await analytics.getTotals(infra.ch, scope());
    const dup = spanEvent(projectId, { durationUs: 70_000 });
    const rows = deriveRows(dup, now);
    await insertDerivedRows(infra.ch, [rows]);
    await insertDerivedRows(infra.ch, [rows]); // same message delivered twice
    await insertDerivedRows(infra.ch, [deriveRows(dup, now + 5000)]); // redelivered later (newer ingested_at)
    const after = await analytics.getTotals(infra.ch, scope());
    expect(after.requests).toBe(before.requests + 1);
  });

  it('keeps projects isolated', async () => {
    const other = await analytics.getTotals(infra.ch, { ...scope(), projectId: otherProject });
    expect(other.requests).toBe(1);
  });

  it('returns a complete, gap-filled time series with null latency for empty buckets', async () => {
    const series = await analytics.getTimeseries(infra.ch, scope(), 60);
    expect(series.length).toBeGreaterThanOrEqual(10);
    expect(series.reduce((n, p) => n + p.requests, 0)).toBe(
      (await analytics.getTotals(infra.ch, scope())).requests,
    );
    const empty = series.find((p) => p.requests === 0);
    expect(empty).toMatchObject({ requests: 0, errors: 0, errorRate: null, p50: null, p95: null });
    const times = series.map((p) => Date.parse(p.t));
    expect(times.every((t, i) => i === 0 || t - (times[i - 1] ?? 0) === 60_000)).toBe(true);
  });

  it('ranks endpoints with validated sort fields, search and pagination', async () => {
    const list = await analytics.listEndpoints(infra.ch, scope(), {
      sort: 'p95',
      order: 'desc',
      limit: 1,
      offset: 0,
    });
    expect(list.total).toBe(2);
    expect(list.endpoints[0]?.route).toBe('/api/orders');
    const searched = await analytics.listEndpoints(infra.ch, scope(), {
      search: 'items',
      sort: 'requests',
      order: 'asc',
      limit: 10,
      offset: 0,
    });
    expect(searched.endpoints.map((e) => e.route)).toEqual(['/api/items']);
    // The search term is a bound parameter, so SQL metacharacters are inert.
    const hostile = await analytics.listEndpoints(infra.ch, scope(), {
      search: "'; DROP TABLE requests; --",
      sort: 'requests',
      order: 'desc',
      limit: 10,
      offset: 0,
    });
    expect(hostile.total).toBe(0);
    expect((await analytics.getTotals(infra.ch, scope())).requests).toBeGreaterThan(0);
  });

  it('searches traces with duplicate-safe counts, filters and keyset pagination', async () => {
    const failing = await analytics.searchTraces(infra.ch, scope(), { status: 'error', limit: 10 });
    expect(failing.traces).toHaveLength(1);
    expect(failing.traces[0]).toMatchObject({
      method: 'POST',
      route: '/api/orders',
      spanCount: 2,
      errorCount: 1,
      status: 'error',
    });

    const page1 = await analytics.searchTraces(infra.ch, scope(), { limit: 3 });
    expect(page1.traces).toHaveLength(3);
    expect(page1.nextCursor).not.toBeNull();
    const cursor = analytics.decodeTraceCursor(page1.nextCursor as string);
    const page2 = await analytics.searchTraces(infra.ch, scope(), {
      limit: 3,
      cursor: cursor ?? undefined,
    });
    const ids1 = new Set(page1.traces.map((t) => t.traceId));
    expect(page2.traces.every((t) => !ids1.has(t.traceId))).toBe(true);
    expect(analytics.decodeTraceCursor('not-a-cursor')).toBeNull();
  });

  it('loads a trace with all spans', async () => {
    const [t] = (await analytics.searchTraces(infra.ch, scope(), { status: 'error', limit: 1 }))
      .traces;
    const detail = await analytics.getTraceSpans(infra.ch, projectId, t?.traceId ?? '');
    expect(detail?.spans).toHaveLength(2);
    expect(detail?.spans.find((s) => s.parentSpanId === null)?.status).toBe('error');
    expect(await analytics.getTraceSpans(infra.ch, otherProject, t?.traceId ?? '')).toBeNull();
  });

  it('groups errors by fingerprint', async () => {
    const groups = await analytics.listErrorGroups(infra.ch, scope(), {
      sort: 'count',
      limit: 10,
      offset: 0,
    });
    expect(groups.total).toBe(1);
    expect(groups.groups[0]).toMatchObject({ count: 1, message: 'boom' });
    expect(groups.groups[0]?.endpoints).toEqual([{ method: 'POST', route: '/api/orders' }]);
  });

  it('reports ingestion health from stored timestamps', async () => {
    const h = await analytics.getIngestionHealth(infra.ch, projectId);
    expect(h.lastSpanAt).not.toBeNull();
    expect(h.spansLastMinute).toBeGreaterThan(0);
  });
});
