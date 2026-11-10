# Operations

## Endpoints

| Service | Port | Liveness          | Readiness | Other                                                                       |
| ------- | ---- | ----------------- | --------- | --------------------------------------------------------------------------- |
| API     | 4000 | `/healthz`        | `/readyz` | `/metrics` (Prometheus), `/openapi.json`, `/v1/pipeline/status` (signed-in) |
| Worker  | 4001 | `/healthz`        | `/readyz` | `/metrics`, `/pipeline` (state, last error, counters)                       |
| Web     | 3000 | `/login` responds | –         | –                                                                           |

- **Alive** = process responding (`/healthz`, never depends on anything else, so an outage cannot cause restart loops).
- **Ready** (API) = Postgres reachable; `degraded` when Kafka or ClickHouse is down. (Worker) = consumer running, ClickHouse
  reachable, pipeline not stalled.
- **Pipeline healthy** = `/pipeline` status `ok`. `degraded` = failing recently; `stalled` = failing continuously for
  `WORKER_STALL_AFTER_SECONDS` (default 300) → worker readiness fails and an operator should intervene.

## Key metrics

API: `traceforge_ingest_requests_total{outcome}`, `…_spans_accepted_total`, `…_spans_rejected_total{reason}`,
`traceforge_ingest_kafka_publish_duration_seconds`, `…_kafka_publish_failures_total`, `traceforge_ingest_inflight_publishes`,
`traceforge_api_http_request_duration_seconds{method,route}`, `traceforge_auth_failures_total{kind}`, `traceforge_sse_connections`.

Worker: `traceforge_worker_messages_processed_total`, `…_messages_dead_lettered_total{reason}`, `…_retries_total`,
`…_batch_failures_total`, `…_consecutive_failures`, `…_clickhouse_insert_duration_seconds`, `…_batch_size_messages`,
`traceforge_worker_ingest_to_visible_seconds` (API acceptance → persisted), `traceforge_worker_consumer_lag_messages`
(sampled every 10 s), `traceforge_alert_evaluations_total{outcome}`, `traceforge_incident_transitions_total{transition}`.

Metrics are Prometheus-format (prom-client). Traces of the API and worker themselves are exported with OpenTelemetry when
`SELF_TELEMETRY_ENDPOINT` and `SELF_TELEMETRY_API_KEY` are set. Recursion is prevented three ways: the SDK exports with tracing
suppressed, incoming `/v1/traces`, health and metrics requests are never traced, and outgoing requests to the export endpoint
are ignored. OpenTelemetry _metrics_ are not exported.

Logs are structured JSON (pino) with request ids (`x-request-id`, echoed in every error envelope); credentials are redacted.

## Failure modes

Expected behaviour, how it shows up, how it recovers, and where it is tested.

| Failure                                  | Behaviour                                                                                                                                                                                                          | Symptoms                                                        | Recovery                                                  | Test                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Kafka unavailable at ingestion           | `503 INGESTION_UNAVAILABLE` + `Retry-After`; nothing acknowledged; API stays alive, `/readyz` = `degraded`                                                                                                         | `…publish_failures_total` ↑, client retries                     | Automatic: producer reconnects lazily on the next request | `api.int.test.ts` ("returns 503 …")                                                                                                   |
| Kafka slow / overloaded                  | Concurrency cap → fast `503` instead of unbounded memory                                                                                                                                                           | `…inflight_publishes` at cap                                    | Self-clears                                               | cap implemented; not load-tested at the cap                                                                                           |
| ClickHouse unavailable during processing | Chunk retried with backoff, then fails **uncommitted**; consumer rebuilt with capped backoff. No data loss, nothing dead-lettered because of the outage                                                            | pipeline `degraded` → `stalled` after 5 min, consumer lag grows | Automatic when the store returns; lag drains              | `worker.int.test.ts` ("survives a ClickHouse outage")                                                                                 |
| Worker crash or restart                  | Resumes from the last committed offset; uncommitted chunk is re-processed                                                                                                                                          | brief lag                                                       | Automatic; duplicates collapse                            | `worker.int.test.ts` ("restart")                                                                                                      |
| Duplicate events                         | Idempotent storage; reads are duplicate-safe                                                                                                                                                                       | none                                                            | –                                                         | `analytics.int.test.ts`, `worker.int.test.ts`, `pnpm smoke`                                                                           |
| Malformed telemetry                      | Per-span rejection with OTLP `partialSuccess`; whole-body errors → `400`/`415`                                                                                                                                     | `…spans_rejected_total`                                         | Client fixes payload                                      | `api.int.test.ts`, `domain/otlp.test.ts`                                                                                              |
| Poison message in Kafka                  | Isolated by bisection → DLQ; partition keeps moving                                                                                                                                                                | `…dead_lettered_total`                                          | Inspect/replay from `telemetry.dlq.v1`                    | `pipeline.test.ts`, `worker.int.test.ts`                                                                                              |
| Oversized body / too many spans          | `413`                                                                                                                                                                                                              | –                                                               | –                                                         | `api.int.test.ts`                                                                                                                     |
| Invalid / revoked key                    | `401`; repeated failures → `429`                                                                                                                                                                                   | `auth_failures_total{kind="api_key"}`                           | –                                                         | `api.int.test.ts`                                                                                                                     |
| Rate-limit exhaustion                    | `429 RATE_LIMITED` + `Retry-After`                                                                                                                                                                                 | `ingest_requests_total{outcome="rate_limited"}`                 | Client backs off                                          | `api.int.test.ts`                                                                                                                     |
| Partial batch failure                    | Valid spans of a batch are accepted; rejects reported in the response                                                                                                                                              | –                                                               | –                                                         | `api.int.test.ts`                                                                                                                     |
| Dashboard query too slow                 | ClickHouse aborts at `QUERY_MAX_EXECUTION_SECONDS` (10) → `504 QUERY_TIMEOUT`; UI shows a retryable error, never stale or invented numbers                                                                         | error state with request id                                     | Shorter range / filters                                   | mapping implemented; the UI error state is covered by e2e with a stubbed failure, the real timeout path is **not** integration-tested |
| Postgres unavailable                     | API `/readyz` = `unavailable` (503); auth fails; ingestion with a cached key keeps working for ≤ 30 s                                                                                                              | readiness fails                                                 | Automatic reconnect                                       | not tested                                                                                                                            |
| Migration failure                        | `pnpm db:migrate` exits non-zero and services should not be started; Drizzle runs each migration transactionally; ClickHouse migrations are `IF NOT EXISTS` and recorded only after success, so re-running is safe | non-zero exit                                                   | Fix and re-run                                            | clean-database migration verified manually and in CI; failure path not tested                                                         |
| Live stream blocked/unavailable          | Dashboard reconnects with backoff, then polls every 20 s                                                                                                                                                           | header shows "Polling"                                          | –                                                         | implemented; not separately tested                                                                                                    |

## Diagnosing a stalled pipeline

1. `curl localhost:4001/pipeline` – `status`, `lastError`, `consecutiveFailures`, `lastSuccessAt`.
2. Is ClickHouse up? `curl localhost:8123/ping`. Is Kafka up? the same call shows `phase`.
3. Lag: `traceforge_worker_consumer_lag_messages`, or `GET /v1/pipeline/status` (signed in).
4. Dead letters: consume `telemetry.dlq.v1`; each record has `reason`, `error`, and the original payload.
5. Restart the worker only if the cause is fixed; it resumes where it left off.

## Retention

ClickHouse TTL deletes telemetry 14 days after the span's start time (all three tables). Postgres data is kept until deleted;
expired sessions can be pruned with `deleteExpiredSessions` (not scheduled). Kafka keeps spans 24 h and dead letters 7 days.

## Scaling notes (not implemented, for context)

Add API replicas freely (state is in Postgres/Kafka; limits become per instance). Add worker replicas up to the partition
count (6); the alert evaluator takes a Postgres advisory lock so only one instance evaluates at a time. A single ClickHouse
node and a single Kafka broker are used locally; production would use replication (`ReplicatedReplacingMergeTree`,
replication factor ≥ 3).
