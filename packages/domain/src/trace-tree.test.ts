import type { SpanDto } from '@traceforge/contracts';
import { describe, expect, it } from 'vitest';
import { layoutTrace } from './trace-tree';

function span(
  id: string,
  parent: string | null,
  service: string,
  offsetMs: number,
  durationMs: number,
): SpanDto {
  return {
    spanId: id,
    parentSpanId: parent,
    name: `op-${id}`,
    kind: 1,
    service,
    startTime: new Date(Date.UTC(2026, 9, 27, 14, 0, 0) + offsetMs).toISOString(),
    offsetMs,
    durationMs,
    status: 'ok',
    statusMessage: '',
    httpMethod: null,
    httpStatus: null,
    route: null,
    attributes: {},
    resource: {},
    events: [],
  };
}

describe('layoutTrace', () => {
  it('orders spans depth-first and computes self time', () => {
    const layout = layoutTrace([
      span('c', 'a', 'db', 20, 30),
      span('a', null, 'api', 0, 100),
      span('b', 'a', 'pay', 60, 40),
      span('d', 'c', 'db', 25, 10),
    ]);
    expect(layout.rows.map((r) => [r.span.spanId, r.depth])).toEqual([
      ['a', 0],
      ['c', 1],
      ['d', 2],
      ['b', 1],
    ]);
    const self = Object.fromEntries(layout.rows.map((r) => [r.span.spanId, r.selfMs]));
    expect(self).toEqual({ a: 30, c: 20, d: 10, b: 40 });
    expect(layout.issues).toEqual([]);
    expect(layout.totalMs).toBe(100);
  });

  it('does not double count overlapping parallel children in self time', () => {
    const layout = layoutTrace([
      span('a', null, 'api', 0, 100),
      span('b', 'a', 'x', 10, 50),
      span('c', 'a', 'y', 20, 50),
    ]);
    // Children cover [10, 70] once (60 ms), not 50 + 50 = 100 ms.
    expect(layout.rows.find((r) => r.span.spanId === 'a')?.selfMs).toBe(40);
  });

  it('breaks time down by service using self time', () => {
    const layout = layoutTrace([span('a', null, 'api', 0, 100), span('b', 'a', 'pay', 20, 60)]);
    expect(layout.serviceBreakdown.map((s) => [s.service, Math.round(s.pct)])).toEqual([
      ['pay', 60],
      ['api', 40],
    ]);
  });

  it('flags orphans instead of inventing a parent', () => {
    const layout = layoutTrace([
      span('b', 'missing', 'pay', 10, 20),
      span('a', null, 'api', 0, 100),
    ]);
    expect(layout.rows.find((r) => r.span.spanId === 'b')?.orphan).toBe(true);
    expect(layout.issues.some((i) => i.includes('not received'))).toBe(true);
  });

  it('reports multiple roots, duplicates and cycles', () => {
    expect(
      layoutTrace([span('a', null, 's', 0, 10), span('b', null, 's', 5, 10)]).issues.join(' '),
    ).toMatch(/2 root spans/);
    expect(
      layoutTrace([span('a', null, 's', 0, 10), span('a', null, 's', 0, 10)]).issues.join(' '),
    ).toMatch(/duplicate/);
    const cyc = layoutTrace([span('x', 'y', 's', 0, 10), span('y', 'x', 's', 0, 10)]);
    expect(cyc.rows).toHaveLength(0);
    expect(cyc.issues.join(' ')).toMatch(/cycle/);
  });

  it('flags probable clock skew without hiding the span', () => {
    const layout = layoutTrace([span('a', null, 'api', 100, 50), span('b', 'a', 'pay', 80, 20)]);
    expect(layout.rows).toHaveLength(2);
    expect(layout.issues.join(' ')).toMatch(/skew/);
  });

  it('handles an empty trace', () => {
    expect(layoutTrace([])).toEqual({ rows: [], totalMs: 0, serviceBreakdown: [], issues: [] });
  });
});
