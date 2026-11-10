# Local development

## Requirements

| Tool                | Version                                       | Notes                                                                    |
| ------------------- | --------------------------------------------- | ------------------------------------------------------------------------ |
| Node.js             | ≥ 22.12 (LTS)                                 | developed on 22.13                                                       |
| pnpm                | 10.x (`packageManager` field)                 | `corepack enable` provides it                                            |
| Docker + Compose v2 | any recent                                    | runs Postgres 17, Kafka 3.9.1 (KRaft), ClickHouse 25.3                   |
| Free ports          | 3000, 4000, 4001, 4100-4102, 5433, 8123, 9092 | Postgres is on **5433** so a local PostgreSQL on 5432 does not shadow it |

## First run

```bash
pnpm install
cp .env.example .env            # development defaults, matching docker-compose.yml
pnpm infra:up                   # postgres, kafka (+ topic init job), clickhouse; waits until healthy
pnpm db:migrate                 # Postgres (Drizzle) + ClickHouse migrations, safe to re-run
pnpm dev                        # api :4000, worker :4001, web :3000
```

Order matters only for the first run: infrastructure → migrations → services. `pnpm infra:down` stops containers,
`pnpm infra:reset` also deletes their volumes.

### Demo

```bash
pnpm demo:setup                 # demo user, demo project, API key → .env.demo
pnpm dev:demo                   # checkout-api :4100, inventory-svc :4101, payments-svc :4102
pnpm demo:traffic start 8       # 8 req/s of seeded synthetic traffic
pnpm demo:traffic scenario slow-downstream on
```

Sign in at <http://localhost:3000/login> as `demo@traceforge.local` (password: the development default printed in
`scripts/demo-setup.ts`, or `DEMO_USER_PASSWORD`). The same controls are in the dashboard under **Settings → Demo controls**
for demo projects. Scenarios: `slow-db`, `slow-downstream`, `intermittent-errors`, `downstream-timeout`, `high-volume`.

## Commands

| Command                                              | What it does                                                                                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev` / `pnpm dev:demo`                         | run services with reload / run the demo services                                                                                                         |
| `pnpm build`                                         | production builds (tsup for api/worker, `next build` for web)                                                                                            |
| `pnpm lint` · `pnpm format:check` · `pnpm typecheck` | static checks (typecheck covers every workspace and the root scripts/tests)                                                                              |
| `pnpm test`                                          | unit tests (no infrastructure needed)                                                                                                                    |
| `pnpm test:integration`                              | real Postgres, Kafka, ClickHouse (needs `pnpm infra:up`, uses isolated databases/topics and cleans up)                                                   |
| `pnpm test:e2e`                                      | Playwright journey against the running stack (`PW_CHANNEL=msedge` or `chrome` to use an installed browser, else `pnpm exec playwright install chromium`) |
| `pnpm smoke`                                         | 18-check end-to-end probe of a running stack                                                                                                             |
| `pnpm loadtest --rate 1000 --duration 30`            | ingestion load test (see README)                                                                                                                         |
| `pnpm screenshots`                                   | regenerate `docs/screenshots` from the running demo                                                                                                      |
| `pnpm db:generate`                                   | generate a Drizzle migration after editing `packages/storage/src/pg/schema.ts`                                                                           |

## Running with Docker Desktop on Windows

If Docker Desktop's engine will not start (seen with Docker Desktop 4.37 on a very recent Windows build: its internal proxy
never initialises), install the Docker engine inside a WSL2 distro and run compose there; published ports are reachable from
Windows as `localhost`:

```bash
wsl -d Ubuntu -u root -- bash -lc 'cd /mnt/c/path/to/traceforge && docker compose up -d --wait'
```

Keep the distro alive while you work (`wsl -d Ubuntu -- sleep infinity`).

## Troubleshooting

| Symptom                                                | Cause / fix                                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `password authentication failed for user "traceforge"` | Another PostgreSQL owns the port in `DATABASE_URL`. Compose publishes Postgres on **5433**; check `DATABASE_URL` in `.env`.           |
| API `/readyz` shows `kafka: down`                      | Broker not up yet or `KAFKA_BROKERS` wrong. The producer reconnects on the next request; ingestion returns 503 meanwhile.             |
| Spans accepted (200) but not visible                   | Worker not running or stalled: `curl localhost:4001/pipeline`. Visibility normally takes < 1 s.                                       |
| `kafka-init` exited non-zero                           | `docker compose logs kafka-init`; re-run with `docker compose up kafka-init`.                                                         |
| `Invalid configuration: …` on start                    | Env validation names the variables; compare with `.env.example`. Production mode rejects the dev passwords.                           |
| Dashboard redirects to login repeatedly                | Session cookie missing: use `http://localhost:3000` (not 127.0.0.1) consistently, and keep `WEB_ORIGINS` equal to the URL you browse. |
| 415 from your exporter                                 | TraceForge supports OTLP **JSON** only: `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`.                                                      |
| Playwright cannot launch a browser                     | `PW_CHANNEL=msedge` (or `chrome`) or `pnpm exec playwright install chromium`.                                                         |
