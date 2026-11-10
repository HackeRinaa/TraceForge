# ADR 0001: Kafka between ingestion and storage

**Status:** accepted

## Context

Telemetry arrives in bursts from many senders, while ClickHouse is most efficient with large, infrequent inserts and can be
briefly unavailable (restarts, merges, upgrades). Ingestion must be able to say "accepted" honestly without waiting for the
analytical store, and without a risk of losing what it accepted.

## Decision

Publish validated, redacted span events to Kafka (`telemetry.spans.v1`, keyed by trace ID) before responding to the client.
A separate worker consumes, batches and writes to ClickHouse.

## Consequences

- **Durability at the acknowledgement point:** idempotent producer + `acks=all`; a `2xx` means the data is in Kafka, and a
  Kafka outage becomes a fast `503` that SDKs retry, never silent loss.
- **Decoupling and backpressure:** ClickHouse trouble grows consumer lag instead of failing ingestion; lag is observable and
  drains by itself. Batching turns thousands of tiny requests into a few large inserts.
- **Replay and isolation:** dead-lettered or mis-processed data can be replayed from Kafka; the worker can be deployed,
  restarted and scaled (up to the partition count) independently of the API.
- **Cost:** one more stateful system to run, and eventual consistency (spans are queryable after ~0.5 s at the measured load,
  not instantly). Per-trace ordering is guaranteed only within a partition (see `event-contracts.md`).
- **Alternative considered:** write to ClickHouse directly with ClickHouse async inserts. Simpler, but acknowledgement would
  mean "buffered inside ClickHouse", gives no replay or DLQ, and couples ingestion availability to ClickHouse.
- **Client library:** KafkaJS is mature but sparsely maintained; the interface is confined to `packages/messaging` and the
  worker so replacing it (for example with a librdkafka binding) is local.
