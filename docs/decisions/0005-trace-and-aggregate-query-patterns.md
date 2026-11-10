# ADR 0005: Separate tables for traces, requests and errors

**Status:** accepted

## Context

Three read patterns want different physical layouts: fetch every span of one trace (by trace id), aggregate request
statistics over a time range (by time, then environment/service/route), and group failures (by fingerprint).

## Decision

Write each span once to `spans` (ordered by `(project, trace, span)`), and additionally derive a `requests` row for HTTP
entry spans (time-first ordering) and an `errors` row for failed spans (fingerprint-first ordering). Aggregates are computed
at query time from de-duplicated rows; there are no pre-aggregated rollups yet (ADR 0004).

## Consequences

- Trace detail is a prefix scan on the sort key; endpoint/overview queries prune by time and read only entry spans; error
  grouping reads only failures. Storage cost is modest because `requests`/`errors` are narrow and partial.
- The three inserts are independent and idempotent, so a partial failure is repaired by retrying the whole chunk.
- A trace is attributed to its **root span** (or its earliest span when the root was never received) for list display and
  route/method filters; the service filter matches any service in the trace; "error" means any failed span in the trace.
  A trace straddling the selected time window is shown with the spans that fall inside it.
- Trace search scans a project's `spans` within the time window (daily partitions + `minmax` index prune it). That is fine at
  this scale but is the first thing to revisit at much higher volume (a time-ordered projection or per-trace summary table).
- Route cardinality is bounded by normalization (ids/tokens collapsed, ≤ 8 segments); per-project distinct-route caps are not
  enforced.
