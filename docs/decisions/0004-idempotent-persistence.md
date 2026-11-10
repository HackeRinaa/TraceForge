# ADR 0004: At-least-once delivery with idempotent persistence

**Status:** accepted

## Context

Duplicates are unavoidable: exporters retry on timeouts, the producer retries, consumers restart between "insert succeeded"
and "offset committed". The pipeline does not claim exactly-once delivery.

## Decision

1. Delivery is **at-least-once**; the worker commits offsets only after rows are stored (or dead-lettered).
2. Every ClickHouse table is a `ReplacingMergeTree(ingested_at)` whose `ORDER BY` contains the span identity
   (`trace_id`, `span_id`, plus deterministic derived columns), so a redelivered span has the same key and collapses during
   background merges.
3. Because merges are asynchronous, **reads must not assume they have happened**:
   - `requests`, `errors` and single-trace reads use `FINAL`;
   - trace search aggregates with `uniqExact(span_id)` / `uniqExactIf(...)`, which are duplicate-safe without `FINAL`.
4. Derived rows are deterministic functions of the event (`deriveRows`), so the same message always produces the same key.

## Consequences

- Verified by tests: identical and later re-delivery do not change counts (`analytics.int.test.ts`); a worker restart neither
  loses nor duplicates data (`worker.int.test.ts`); `pnpm smoke` re-sends an identical payload and checks the overview.
- `FINAL` has a read-time cost that grows with unmerged parts; at the measured volume it is small. If it matters, add a
  rollup keyed by span identity (deduplicating), not an insert-time aggregating view (which would double count).
- Insert-time materialized views are intentionally **not** used for exactly this reason.
- **Alternatives considered:** Kafka transactions + ClickHouse insert deduplication tokens (only protects identical batches,
  not client-level resends); a Postgres/Redis "seen" set (extra hot-path state and a second source of truth).
