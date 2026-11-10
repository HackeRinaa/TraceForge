# ADR 0006: Redact sensitive telemetry at the edge, before Kafka

**Status:** accepted

## Context

Telemetry routinely contains credentials and personal data by accident (auth headers, cookies, URL query tokens, SQL
literals). Anything that reaches Kafka, the DLQ, ClickHouse, logs or backups is hard to remove later.

## Decision

Apply the privacy policy in the **ingestion API**, as part of OTLP→event conversion, so unredacted values never leave that
process. TraceForge does not collect request/response bodies or headers; if an SDK attaches header attributes, keys matching
the sensitive-name rules are dropped. URL query strings are stripped, SQL statement literals are masked, and values and
attribute counts are capped. The rules live in `packages/domain/src/sanitize.ts` with unit tests and are listed in
`security.md`.

## Consequences

- Strong guarantee for what the rules cover; no later component needs to remember to redact.
- **Limits are explicit:** matching is by attribute _name_, not value. A secret in a free-form attribute with an innocuous
  name is not detected, and exception messages/stack traces are stored. Documented rather than hidden.
- Redacted attributes are counted (not logged) so operators can see the policy working; the original values are
  unrecoverable by design, which also means a too-aggressive rule cannot be undone retroactively.
- Rules are code, not per-project configuration. Per-project allow/deny lists are a natural extension.
