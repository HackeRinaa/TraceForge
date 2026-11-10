# ADR 0002: ClickHouse for telemetry, PostgreSQL for metadata

**Status:** accepted

## Context

Two very different workloads: (a) high-volume, append-only telemetry queried with aggregations over time windows
(percentiles, rates, group-bys), and (b) small transactional metadata with relations and constraints (users, memberships,
keys, rules, incidents with a strict lifecycle).

## Decision

Store telemetry in **ClickHouse** and everything transactional in **PostgreSQL**. No other database; no Redis (nothing
requires it yet).

## Consequences

- Columnar storage, compression, partition pruning and `quantiles*` make the required analytics cheap; TTL implements
  retention with one clause. Measured dashboard queries on ~90k requests: 30–250 ms (README).
- Postgres gives the guarantees the control plane needs: foreign keys, unique constraints, and a **partial unique index that
  makes "one active incident per rule" a database invariant** rather than application convention.
- Cross-store consistency is by design loose: ClickHouse rows carry the project id; Postgres decides who may see which project.
  Deleting a project soft-deletes in Postgres and lets telemetry expire.
- ClickHouse is not transactional and has no unique constraints, which is why idempotency is handled by table design
  (ADR 0004) and why migrations are written to be re-runnable.
- **Alternative considered:** Postgres/TimescaleDB for everything — fewer systems, but poorer fit for percentile aggregation
  and high ingest volume, and no cheap retention at scale.
