# Event contracts

## OTLP input (what clients send)

`POST /v1/traces` accepts **OTLP/HTTP with JSON encoding** (`Content-Type: application/json`, optional
`Content-Encoding: gzip`). Authentication is `Authorization: Bearer tf_live_…` or `x-traceforge-key`.

**Protobuf is not supported.** `application/x-protobuf` is rejected with `415` and a message telling the client to set
`OTEL_EXPORTER_OTLP_PROTOCOL=http/json`. The JSON schema lives in
[`packages/contracts/src/otlp.ts`](../packages/contracts/src/otlp.ts); unknown fields are ignored so SDK upgrades do not
break ingestion.

| Situation                          | Response                                                         |
| ---------------------------------- | ---------------------------------------------------------------- |
| Accepted                           | `200 {}`                                                         |
| Some spans invalid                 | `200 {"partialSuccess":{"rejectedSpans":N,"errorMessage":…}}`    |
| Missing/invalid/revoked key        | `401 INVALID_API_KEY` (failed attempts are rate limited → `429`) |
| Malformed JSON / schema            | `400 VALIDATION_ERROR` with `details[]`                          |
| Unsupported media type or encoding | `415 UNSUPPORTED_MEDIA_TYPE`                                     |
| Body or span-count over limit      | `413 PAYLOAD_TOO_LARGE`                                          |
| Project over its span budget       | `429 RATE_LIMITED` + `Retry-After`                               |
| Kafka cannot confirm / overloaded  | `503 INGESTION_UNAVAILABLE` + `Retry-After`                      |

Spans are rejected individually when: trace/span ID is not lowercase hex of the right length (or all zero), end is before
start or duration exceeds 24 h, the span is older than the retention window, or it starts more than 5 min in the future.

## Kafka topics

| Topic                | Key        | Partitions | Retention | Value                 |
| -------------------- | ---------- | ---------- | --------- | --------------------- |
| `telemetry.spans.v1` | `traceId`  | 6          | 24 h      | `SpanEventV1` (JSON)  |
| `telemetry.dlq.v1`   | source key | 1          | 7 d       | `DeadLetterV1` (JSON) |

Created by the `kafka-init` job in `docker-compose.yml` ([`infrastructure/kafka/create-topics.sh`](../infrastructure/kafka/create-topics.sh));
auto-creation is disabled. A metrics topic is not used: TraceForge ingests traces only.

**Partition key.** Spans are keyed by trace ID so all spans of a trace land on one partition and are consumed in order
relative to each other. Ordering is guaranteed _within a partition only_: spans of different traces are unordered, and a
retried request can reorder spans within a trace (the storage layer does not depend on order). Parallelism is bounded by
the partition count (6).

**Producer.** Idempotent, `acks=all`, gzip compression, batches ≤ 500 messages / ≈ 800 KB, individual messages ≤ 900 KB
(oversized events are dropped and reported as rejected). Retries are deliberately bounded (2) so a broker outage turns
into a fast `503` instead of a hung request; a send that actually succeeded but was reported as failed is retried by the
_client_ and de-duplicated downstream.

**Consumer.** One group (`traceforge-worker`), manual commits after persistence, `minBytes` 16 KB / `maxWaitTimeInMs`
`WORKER_BATCH_MAX_WAIT_MS` so batches grow under load and latency stays bounded when idle, chunks of
`WORKER_BATCH_MAX_MESSAGES`, `WORKER_CONSUMER_CONCURRENCY` partitions in parallel, `maxBytes` 10 MiB (bounded memory).

## `SpanEventV1`

Defined by [`spanEventV1Schema`](../packages/contracts/src/span-event.ts) (authoritative). Summary:

```jsonc
{
  "schemaVersion": 1,
  "projectId": "uuid", // taken from the API key, never from the payload
  "receivedAt": 1793100000000, // epoch ms, API acceptance time
  "traceId": "32 hex",
  "spanId": "16 hex",
  "parentSpanId": "16 hex | null",
  "name": "POST /api/orders",
  "kind": 2, // OTLP SpanKind 0-5
  "serviceName": "checkout-api",
  "environment": "production",
  "startTimeUs": 1793099999800000,
  "durationUs": 120000, // epoch µs / µs
  "status": { "code": 0, "message": "optional" }, // 0 unset, 1 ok, 2 error
  "attributes": { "http.route": "/api/orders" }, // flattened strings, already redacted and capped
  "resource": { "service.version": "1.4.2" },
  "events": [{ "name": "exception", "timeUs": 0, "attributes": {} }], // ≤ 64
}
```

Redaction happens **before** publishing, so credentials never enter Kafka, the DLQ or ClickHouse.

## `DeadLetterV1`

`{ schemaVersion, sourceTopic, sourcePartition, sourceOffset, key, payload (≤ 64 KiB, payloadTruncated), reason, error,
attempts, failedAt, consumerGroup }` with `reason ∈ invalid_json | invalid_schema | processing_failed`.

## Delivery, retries and de-duplication

- At-least-once end to end. Duplicates arise from client retries, producer retries and consumer restarts.
- Duplicates are harmless because every ClickHouse table is a `ReplacingMergeTree` keyed on span identity and every read
  path is duplicate-safe (`FINAL` or `uniqExact`). See [ADR 0004](decisions/0004-idempotent-persistence.md). Verified by
  `worker.int.test.ts` (redelivery, restart) and `analytics.int.test.ts`.
- Transient store errors: exponential backoff with full jitter, `WORKER_MAX_RETRIES` attempts, then the chunk fails
  _uncommitted_ and is retried after the consumer restarts. Data errors: bisect → DLQ. DLQ messages are replayable: the
  payload is the original message value.

## Compatibility strategy

- The version is in both the topic name and the payload. **Additive** changes (new optional fields) keep v1; the worker's
  schema ignores unknown fields.
- A **breaking** change introduces `telemetry.spans.v2` and a `SpanEventV2` schema. The worker consumes both topics during
  migration; the API switches producers; v1 drains and is retired after retention.
- The ClickHouse tables are versioned by migrations in `infrastructure/clickhouse/migrations` (additive columns only; the
  worker's row mapper and the migration ship together).
