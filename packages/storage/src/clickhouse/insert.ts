import type { DerivedRows } from '@traceforge/domain';
import type { ClickHouseClient } from './client';

export interface InsertStats {
  spans: number;
  requests: number;
  errors: number;
}

const INSERT_SETTINGS = {
  // Parse our `YYYY-MM-DD HH:MM:SS.ffffff` strings and tolerate ISO variants.
  date_time_input_format: 'best_effort',
  // Writes are batched by the worker, so no server-side async buffering (which would acknowledge before durability).
  async_insert: 0,
  max_execution_time: 60,
} as const;

/**
 * Writes a batch of derived rows to the three tables. All inserts are idempotent (ReplacingMergeTree keyed on the
 * span identity), so the caller may retry the whole batch after any partial failure.
 */
export async function insertDerivedRows(
  ch: ClickHouseClient,
  batch: readonly DerivedRows[],
): Promise<InsertStats> {
  const spans = batch.map((r) => r.span);
  const requests = batch.flatMap((r) => (r.request ? [r.request] : []));
  const errors = batch.flatMap((r) => (r.error ? [r.error] : []));

  const write = async (table: string, values: readonly object[]) => {
    if (values.length === 0) return;
    await ch.insert({
      table,
      values: values as object[],
      format: 'JSONEachRow',
      clickhouse_settings: INSERT_SETTINGS,
    });
  };
  await Promise.all([write('spans', spans), write('requests', requests), write('errors', errors)]);
  return { spans: spans.length, requests: requests.length, errors: errors.length };
}
