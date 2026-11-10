# Implementation status

Truthful record of what was built, how it was verified, and what remains. Updated at the end of the build; dates are 2026-10-27 to
2026-10-29 on a Windows 11 laptop (i7-11800H, 32 GiB) with the infrastructure containers running in Docker inside WSL2.

## Environment notes

- Docker Desktop 4.37.1 could not start its engine on this Windows build (its internal HTTP proxy never initialised, repeatedly).
  A Docker engine (29.1.3) and Compose were installed in the existing, empty Ubuntu WSL distro instead; ports are reachable from
  Windows as `localhost`. `docker-compose.yml` is unchanged by this and works with any Docker.
- A native PostgreSQL on this machine owns port 5432, so the compose Postgres is published on **5433**.
- Playwright ran against the installed Microsoft Edge (`PW_CHANNEL=msedge`); the CI workflow installs Chromium instead
  (**the CI workflow itself has not been run**; there is no remote repository here).
- Library versions were chosen after checking the registry, deliberately below some brand-new majors: TypeScript 5.9
  (typescript-eslint supports `<6.1`), ESLint 9, Vitest 4.

## Phases

### Phase 0 – inspect and plan ✔

Environment inspected; stack versions verified; design canvas created (`docs/design`, 5 boards: overview, endpoints, trace
waterfall, alerts, foundations). The design canvas was written and published but **not visually reviewed** after publishing.

### Phase 1 – design system and shell ✔

Tokens (dark + light) in `apps/web/src/app/globals.css`; shared components; shell with workspace/project/environment selectors,
time range, ⌘K, live badge, incident bell, theme toggle, responsive drawer. Built against live data (no fixtures were needed).

### Phase 2 – foundation ✔

pnpm monorepo; strict TS; validated config; redacting logger; Drizzle migrations; ClickHouse migration runner; Compose
infrastructure with Kafka topic creation; health endpoints; CI workflow.

### Phase 3 – telemetry pipeline ✔

Instrumented demo services → OTLP ingestion → Kafka → worker → ClickHouse, with DLQ, retries, idempotent writes. Verified by
integration tests and live smoke test.

### Phase 4 – analytics APIs ✔

Overview, endpoints (+detail), services, traces (search/detail), errors (groups/detail), ingestion health, dimensions, SSE.

### Phase 5 – frontend ✔

All routes in the brief (`overview`, `endpoints` + investigation view, `traces`, `traces/[traceId]`, `errors` (+ detail),
`alerts`, `settings`) with URL state, loading/empty/error states, live updates with backoff and polling fallback.

### Phase 6 – alerts and incidents ✔

Rule CRUD, evaluator with advisory lock, one-active-incident-per-rule index, acknowledge/resolve, auto-recovery, evidence, history.

### Phase 7 – hardening and delivery ◐

Done: tests below, production builds exercised, load test, docs. Not done / limited: see "Remaining work".

## Verification record (commands actually run)

| Check                                                                                | Result                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check` · `pnpm lint` (type-aware, no rules disabled) · `pnpm typecheck` | pass                                                                                                                                                                                                                                                                                                                       |
| `pnpm test`                                                                          | 108 passed                                                                                                                                                                                                                                                                                                                 |
| `pnpm test:integration`                                                              | 41 passed (analytics 9, worker pipeline 3, alert evaluator 8, API 21)                                                                                                                                                                                                                                                      |
| `pnpm test:e2e` (Edge)                                                               | 3 passed against the dev servers **and** against the production builds                                                                                                                                                                                                                                                     |
| `pnpm smoke`                                                                         | 18/18 against dev and production builds                                                                                                                                                                                                                                                                                    |
| `pnpm build`                                                                         | api, worker (tsup) and web (`next build`, Turbopack) succeed                                                                                                                                                                                                                                                               |
| `pnpm audit --prod`                                                                  | no known vulnerabilities                                                                                                                                                                                                                                                                                                   |
| Fresh checkout (files from `git ls-files`, no `node_modules`)                        | `pnpm install --frozen-lockfile`, typecheck, lint, 108 unit tests and build all pass. **Observation:** an earlier export placed under a Windows 8.3 short path (`...\MARINA~1\...`) failed the unit tests with `ERR_PACKAGE_IMPORT_NOT_DEFINED`; the identical checkout passes at a normal path. Not investigated further. |
| `pnpm db:migrate` from an empty database                                             | succeeds (integration tests create fresh databases each run)                                                                                                                                                                                                                                                               |
| `pnpm loadtest`                                                                      | two runs recorded in `bench/results` and the README                                                                                                                                                                                                                                                                        |

Defects found by running things (and fixed), worth knowing about: ClickHouse bucketing used a function returning `DateTime`
instead of `DateTime64` (caught by running the overview); production bundles crashed because `tsup` inlined third-party CommonJS
code (declared the runtime dependencies on the apps); the logger demanded the dev-only `pino-pretty` in built services (now
falls back to JSON); the alert form blocked saving on blank optional fields without showing why (normalized before validation);
the waterfall overflowed its panel on phones; the load test's first visibility numbers were an artifact of its own polling
order (rewritten, old results deleted).

## Acceptance criteria

| Criterion                                            | Status                                                                                                                                                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend builds                                      | ✔                                                                                                                                                                                                    |
| Backend typechecks and builds                        | ✔                                                                                                                                                                                                    |
| Infrastructure starts with documented commands       | ✔ (`pnpm infra:up`; run via Docker-in-WSL here)                                                                                                                                                      |
| Migrations run from a clean database                 | ✔                                                                                                                                                                                                    |
| Demo app produces genuine OpenTelemetry telemetry    | ✔ (OTel SDK + http/undici instrumentation, 3 processes, W3C context propagation)                                                                                                                     |
| Ingestion validates and accepts supported telemetry  | ✔                                                                                                                                                                                                    |
| Telemetry passes through Kafka                       | ✔                                                                                                                                                                                                    |
| Worker persists to ClickHouse                        | ✔                                                                                                                                                                                                    |
| Analytics derived from stored telemetry              | ✔                                                                                                                                                                                                    |
| Dashboard displays real analytics                    | ✔                                                                                                                                                                                                    |
| Trace search and detail work end to end              | ✔                                                                                                                                                                                                    |
| Waterfall represents span relationships              | ✔ (unit-tested layout; viewed on real cross-service traces)                                                                                                                                          |
| Endpoint and time-range filtering                    | ✔ (URL-persisted; e2e covers environment + endpoint search)                                                                                                                                          |
| Alert rules created and evaluated                    | ✔                                                                                                                                                                                                    |
| Incidents acknowledged and resolved                  | ✔ (UI e2e, API tests, evaluator tests)                                                                                                                                                               |
| Authentication and project isolation tested          | ✔                                                                                                                                                                                                    |
| Duplicate processing handled per documented strategy | ✔                                                                                                                                                                                                    |
| Important failures defined and tested                | ◐ all listed in `operations.md`; **real query-timeout and Postgres-outage paths are not automated**                                                                                                  |
| Automated tests executed                             | ✔ results above                                                                                                                                                                                      |
| No dead buttons or misleading charts                 | ◐ every control was implemented to act; not exhaustively exercised by hand (the e2e covers the main ones)                                                                                            |
| Loading, empty and error states                      | ✔ (implemented everywhere; e2e covers empty and error states)                                                                                                                                        |
| Responsive and accessible UI                         | ◐ responsive layout checked at 1440 px and, for the trace page, 390 px; **no automated accessibility audit was run**                                                                                 |
| Secrets not committed or exposed                     | ✔ `.env*` ignored; demo key in ignored `.env.demo`                                                                                                                                                   |
| README allows reproduction                           | ◐ install/typecheck/test/build were verified from a fresh checkout on this machine; the infrastructure and demo steps were not repeated from that checkout, and nothing was tried on another machine |
| Benchmarks based on actual runs                      | ✔                                                                                                                                                                                                    |
| Known limitations documented                         | ✔ (README)                                                                                                                                                                                           |

## Remaining work and known gaps

- **Not done:** OTLP protobuf/gRPC; per-project retention; notification channels (Slack/email/webhook); SSO/MFA/email
  verification; metrics and logs signals; OpenTelemetry _metrics_ export of the platform itself (Prometheus endpoints exist);
  member-management UI (API exists); rollups for very large volumes.
- **Not verified:** the GitHub Actions workflow has not executed; Firefox/Safari; real-world accessibility tooling; screen
  readers; mobile layout beyond the trace page; behaviour beyond ~1,900 spans/s or against multi-node Kafka/ClickHouse;
  Postgres outage; real ClickHouse query timeout; the per-user SSE connection cap; switching themes/time ranges by hand in every
  page.
- **Known rough edges:** Fastify's deprecated `requestIdLogLabel`/`disableRequestLogging` options still work but print a
  deprecation notice (replacement is a controller class API); KafkaJS prints a warning that bounded retries on an idempotent
  producer weaken exactly-once semantics (intended, see ADR 0003); the Next.js dev overlay badge overlaps the sidebar footer
  in development only.

## Important decisions

See [`docs/decisions`](decisions). In short: Kafka between ingestion and storage; ClickHouse + PostgreSQL; acknowledgement means
"in Kafka"; at-least-once with idempotent storage (no insert-time rollups); three purpose-built ClickHouse tables; redaction
at the edge.
