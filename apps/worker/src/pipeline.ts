import { spanEventV1Schema, type DeadLetterV1, type SpanEventV1 } from '@traceforge/contracts';
import { deriveRows, withRetry, type DerivedRows } from '@traceforge/domain';

export interface RawMessage {
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  value: Buffer | null;
}

export interface PipelineHooks {
  onBatch(size: number): void;
  onRetry(error: unknown, attempt: number, delayMs: number): void;
  onInsert(seconds: number, rows: number): void;
  onPersisted(events: readonly SpanEventV1[], persistedAtMs: number): void;
  onDeadLetter(reason: DeadLetterV1['reason'], count: number): void;
}

export interface PipelineDeps {
  insert(rows: DerivedRows[]): Promise<unknown>;
  deadLetter(entries: DeadLetterV1[]): Promise<void>;
  /** True for infrastructure failures worth retrying; false for data errors that will never succeed. */
  isTransient(error: unknown): boolean;
  retry: { maxAttempts: number; baseMs: number; maxMs: number };
  consumerGroup: string;
  now(): number;
  sleep?: (ms: number) => Promise<void>;
  hooks: PipelineHooks;
}

export interface ChunkOutcome {
  persisted: number;
  deadLettered: number;
}

const MAX_DLQ_PAYLOAD = 64 * 1024;

interface Valid {
  message: RawMessage;
  event: SpanEventV1;
  derived: DerivedRows;
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function deadLetterOf(
  m: RawMessage,
  reason: DeadLetterV1['reason'],
  error: unknown,
  attempts: number,
  now: number,
  group: string,
): DeadLetterV1 {
  const text = m.value ? m.value.toString('utf8') : '';
  return {
    schemaVersion: 1,
    sourceTopic: m.topic,
    sourcePartition: m.partition,
    sourceOffset: m.offset,
    key: m.key,
    payload: text.slice(0, MAX_DLQ_PAYLOAD),
    payloadTruncated: text.length > MAX_DLQ_PAYLOAD,
    reason,
    error: describe(error),
    attempts,
    failedAt: new Date(now).toISOString(),
    consumerGroup: group,
  };
}

/**
 * Persists a group of rows. Transient failures (store down, timeouts) are retried with jittered backoff and, if they
 * persist, rethrown so the caller stops and retries later without committing offsets. A data error (the store rejects
 * the rows themselves) is isolated by bisection so one poison message cannot block the rest of the partition.
 */
async function persist(
  items: Valid[],
  deps: PipelineDeps,
): Promise<{ ok: Valid[]; poison: Array<{ item: Valid; error: unknown }> }> {
  try {
    await withRetry(
      async () => {
        const started = performance.now();
        await deps.insert(items.map((i) => i.derived));
        deps.hooks.onInsert((performance.now() - started) / 1000, items.length);
      },
      {
        maxAttempts: deps.retry.maxAttempts,
        baseMs: deps.retry.baseMs,
        maxMs: deps.retry.maxMs,
        isRetryable: (error) => deps.isTransient(error),
        onRetry: (error, attempt, delayMs) => deps.hooks.onRetry(error, attempt, delayMs),
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
      },
    );
    return { ok: items, poison: [] };
  } catch (error) {
    if (deps.isTransient(error)) throw error;
    const only = items[0];
    if (items.length === 1 && only) return { ok: [], poison: [{ item: only, error }] };
    const mid = items.length >> 1;
    const left = await persist(items.slice(0, mid), deps);
    const right = await persist(items.slice(mid), deps);
    return { ok: [...left.ok, ...right.ok], poison: [...left.poison, ...right.poison] };
  }
}

/**
 * Processes one chunk of consumed messages end to end: decode, validate, normalize, persist, dead-letter. It resolves
 * only when every message is either durably stored or durably dead-lettered, which is the condition for committing the
 * chunk's offsets. It throws on infrastructure failure, in which case nothing may be committed.
 */
export async function processChunk(
  messages: readonly RawMessage[],
  deps: PipelineDeps,
): Promise<ChunkOutcome> {
  const now = deps.now();
  const dead: DeadLetterV1[] = [];
  const valid: Valid[] = [];
  const reasons: DeadLetterV1['reason'][] = [];
  const toDlq = (m: RawMessage, reason: DeadLetterV1['reason'], error: unknown, attempts = 0) => {
    dead.push(deadLetterOf(m, reason, error, attempts, now, deps.consumerGroup));
    reasons.push(reason);
  };

  for (const message of messages) {
    if (!message.value || message.value.length === 0) {
      toDlq(message, 'invalid_json', 'empty message value');
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(message.value.toString('utf8'));
    } catch (error) {
      toDlq(message, 'invalid_json', error);
      continue;
    }
    const parsed = spanEventV1Schema.safeParse(json);
    if (!parsed.success) {
      toDlq(
        message,
        'invalid_schema',
        parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; '),
      );
      continue;
    }
    try {
      valid.push({ message, event: parsed.data, derived: deriveRows(parsed.data, now) });
    } catch (error) {
      toDlq(message, 'processing_failed', error);
    }
  }

  let persisted = 0;
  if (valid.length > 0) {
    const result = await persist(valid, deps);
    persisted = result.ok.length;
    for (const p of result.poison) toDlq(p.item.message, 'processing_failed', p.error, 1);
    deps.hooks.onPersisted(
      result.ok.map((i) => i.event),
      deps.now(),
    );
  }

  // Dead letters are published before the caller commits offsets, so a poison message is never silently dropped.
  if (dead.length > 0) {
    await deps.deadLetter(dead);
    for (const reason of new Set(reasons))
      deps.hooks.onDeadLetter(reason, reasons.filter((r) => r === reason).length);
  }
  deps.hooks.onBatch(messages.length);
  return { persisted, deadLettered: dead.length };
}
