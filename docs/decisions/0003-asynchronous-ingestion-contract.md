# ADR 0003: Asynchronous ingestion and what an acknowledgement means

**Status:** accepted

## Context

The requirement is that ingestion not depend on a synchronous analytical write per request, yet never acknowledge data that
can silently disappear.

## Decision

`POST /v1/traces` returns success **only after the spans have been acknowledged by Kafka (`acks=all`, idempotent producer)**.
Persistence to ClickHouse happens afterwards, asynchronously. There is no in-process buffer between acceptance and Kafka.

| Event                        | Response                                    |
| ---------------------------- | ------------------------------------------- |
| Spans durably in Kafka       | `200` (visible in queries shortly after)    |
| Kafka cannot confirm         | `503` + `Retry-After`, nothing acknowledged |
| Too many in-flight publishes | `503` + `Retry-After` (backpressure)        |
| Project over its span budget | `429` + `Retry-After`                       |

## Consequences

- A `200` is a durability statement, not a visibility statement. The UI shows an ingestion-health indicator including measured
  visibility delay, so the gap is visible rather than hidden.
- Latency of the ingest call is dominated by the Kafka round trip (measured p50 ≈ 6–8 ms, p99 ≈ 13–40 ms locally).
- The producer's retries are bounded so a broker outage fails fast. A send that reached the broker but was reported as failed
  is retried by the client and de-duplicated downstream (ADR 0004). This is why KafkaJS logs a warning about "limiting retries
  for the idempotent producer": the trade-off is deliberate.
- Per-project rate limits and the publish-concurrency cap are **per API process**; behind N replicas the effective limit is N×.
