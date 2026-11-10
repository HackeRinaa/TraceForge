import type { DeadLetterV1, SpanEventV1 } from '@traceforge/contracts';
import type { DerivedRows } from '@traceforge/domain';
import { describe, expect, it, vi } from 'vitest';
import { isTransientClickHouseError } from './clickhouse-errors';
import { processChunk, type PipelineDeps, type RawMessage } from './pipeline';

const PROJECT = '7b0b9c77-3d52-4a47-a6d9-0d2a5b2f9a10';

function event(i: number): SpanEventV1 {
  return {
    schemaVersion: 1,
    projectId: PROJECT,
    receivedAt: 1_000,
    traceId: i.toString(16).padStart(32, '1'),
    spanId: i.toString(16).padStart(16, '2'),
    parentSpanId: null,
    name: `op-${i}`,
    kind: 2,
    serviceName: 'svc',
    environment: 'test',
    startTimeUs: 1_790_000_000_000_000 + i,
    durationUs: 1000,
    status: { code: 0 },
    attributes: { 'http.method': 'GET', 'http.route': '/x' },
    resource: {},
    events: [],
  };
}

const msg = (i: number, value: Buffer | null, offset = String(i)): RawMessage => ({
  topic: 't',
  partition: 0,
  offset,
  key: String(i),
  value,
});
const good = (i: number) => msg(i, Buffer.from(JSON.stringify(event(i))));

/** A ClickHouse-shaped error with the given server code. */
function chError(code: string, message = 'server error'): Error {
  return Object.assign(new Error(message), { code, type: 'SOME_ERROR' });
}

function harness(overrides: Partial<PipelineDeps> = {}) {
  const dead: DeadLetterV1[] = [];
  const inserted: DerivedRows[][] = [];
  const hooks = {
    onBatch: vi.fn(),
    onRetry: vi.fn(),
    onInsert: vi.fn(),
    onPersisted: vi.fn(),
    onDeadLetter: vi.fn(),
  };
  const deps: PipelineDeps = {
    insert: (rows) => {
      inserted.push(rows);
      return Promise.resolve();
    },
    deadLetter: (e) => {
      dead.push(...e);
      return Promise.resolve();
    },
    isTransient: isTransientClickHouseError,
    retry: { maxAttempts: 3, baseMs: 1, maxMs: 2 },
    consumerGroup: 'g',
    now: () => 5_000,
    sleep: () => Promise.resolve(),
    hooks,
    ...overrides,
  };
  return { deps, dead, inserted, hooks };
}

describe('processChunk', () => {
  it('persists valid messages in one batch', async () => {
    const h = harness();
    const out = await processChunk([good(1), good(2), good(3)], h.deps);
    expect(out).toEqual({ persisted: 3, deadLettered: 0 });
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0]).toHaveLength(3);
    expect(h.hooks.onBatch).toHaveBeenCalledWith(3);
  });

  it('dead-letters malformed JSON and schema violations without blocking valid messages', async () => {
    const h = harness();
    const invalidSchema = msg(9, Buffer.from(JSON.stringify({ ...event(9), traceId: 'nope' })));
    const out = await processChunk(
      [good(1), msg(2, Buffer.from('{not json')), invalidSchema, msg(4, null), good(5)],
      h.deps,
    );
    expect(out).toEqual({ persisted: 2, deadLettered: 3 });
    expect(h.dead.map((d) => d.reason).sort()).toEqual([
      'invalid_json',
      'invalid_json',
      'invalid_schema',
    ]);
    expect(h.dead[0]).toMatchObject({ sourceTopic: 't', consumerGroup: 'g', schemaVersion: 1 });
  });

  it('retries transient store failures and then succeeds', async () => {
    let calls = 0;
    const h = harness({
      insert: () => (++calls < 3 ? Promise.reject(new Error('ECONNREFUSED')) : Promise.resolve()),
    });
    const out = await processChunk([good(1)], h.deps);
    expect(out.persisted).toBe(1);
    expect(calls).toBe(3);
    expect(h.hooks.onRetry).toHaveBeenCalledTimes(2);
  });

  it('rethrows when the store stays down, dead-lettering nothing, so offsets are not committed', async () => {
    const h = harness({ insert: () => Promise.reject(new Error('connect ECONNREFUSED')) });
    await expect(processChunk([good(1), good(2)], h.deps)).rejects.toThrow('ECONNREFUSED');
    expect(h.dead).toHaveLength(0);
  });

  it('isolates a poison message by bisection and persists the rest', async () => {
    const poisonSpan = event(3).spanId;
    const h = harness({
      insert: (rows) =>
        rows.some((r) => r.span.span_id === poisonSpan)
          ? Promise.reject(chError('27', 'cannot parse input'))
          : Promise.resolve(),
    });
    const out = await processChunk([1, 2, 3, 4, 5, 6, 7].map(good), h.deps);
    expect(out).toEqual({ persisted: 6, deadLettered: 1 });
    expect(h.dead).toHaveLength(1);
    expect(h.dead[0]).toMatchObject({ reason: 'processing_failed', sourceOffset: '3' });
    expect(h.dead[0]?.error).toContain('cannot parse input');
  });

  it('treats unknown server errors as transient and data errors as permanent', () => {
    expect(isTransientClickHouseError(chError('27'))).toBe(false);
    expect(isTransientClickHouseError(chError('53'))).toBe(false);
    expect(isTransientClickHouseError(chError('252', 'TOO_MANY_PARTS'))).toBe(true);
    expect(isTransientClickHouseError(chError('159', 'timeout'))).toBe(true);
    expect(isTransientClickHouseError(new Error('socket hang up'))).toBe(true);
  });

  it('fails the chunk (no commit) if the dead-letter publish itself fails', async () => {
    const h = harness({ deadLetter: () => Promise.reject(new Error('kafka down')) });
    await expect(processChunk([msg(1, Buffer.from('x'))], h.deps)).rejects.toThrow('kafka down');
  });

  it('truncates oversized payloads in the dead letter', async () => {
    const h = harness();
    await processChunk([msg(1, Buffer.from('x'.repeat(100_000)))], h.deps);
    expect(h.dead[0]?.payloadTruncated).toBe(true);
    expect(h.dead[0]?.payload.length).toBe(64 * 1024);
  });
});
