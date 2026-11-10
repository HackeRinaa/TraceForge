# Security and privacy

This document lists what is implemented, how it was verified, and what is **not** covered.

## Authentication and sessions

- Passwords are hashed with **scrypt** (Node's built-in; N=2¹⁵, r=8, p=1, 16-byte random salt, parameters stored per hash). A
  full verification runs even for unknown emails (against a dummy hash) so response time does not reveal which emails exist;
  the failure message is identical.
- Sessions are server-side. The cookie holds a 256-bit random token; **only its SHA-256 is stored**. Cookies are `HttpOnly`,
  `SameSite=Lax`, `Path=/`, and `Secure` when `NODE_ENV=production`. Logout deletes the row.
- Login/registration are throttled per client address (and per email for login).
- **CSRF:** `SameSite=Lax` plus an explicit `Origin` allow-list (`WEB_ORIGINS`) on every state-changing, cookie-authenticated
  request (missing or foreign origin → `403 CSRF_REJECTED`). Ingestion uses API keys, not cookies, and is exempt.
- This is a self-contained account system suitable for a self-hosted deployment. **For a public, multi-tenant deployment put
  an identity provider in front (OIDC/SSO) rather than relying on local passwords**; the session layer is isolated in
  `apps/api/src/services/access.ts` to make that swap contained. No email verification, password reset or MFA is implemented.

## Authorization and isolation

- Every project-scoped route calls one function, `projectContext`, which authenticates the caller and checks workspace
  membership through a join. Non-members receive `404`, so project existence is not disclosed across workspaces.
- Roles: `viewer` (read) · `member` (alert rules, incidents) · `admin`/`owner` (API keys, project settings/deletion, members).
- ClickHouse queries always carry the project id from the authorization step, never from the request.
- Verified in `apps/api/src/api.int.test.ts` (cross-workspace reads/writes, role enforcement) and the Playwright journey
  (a second user gets `404` for the first user's project and keys).

## API keys

- 256 bits from `crypto.randomBytes`, format `tf_live_<43 chars>`; shown **once** at creation or rotation; only the SHA-256 and
  a 12-character display prefix are stored. Revocation and rotation are supported.
- Authenticated keys are cached in memory for 30 s (unknown keys for 5 s). **A revoked key can keep working for up to 30 s on
  other API instances**; revoking through an instance clears that instance's cache immediately.
- Failed key attempts are rate limited per address.
- Keys and passwords are redacted from logs (`pino` redact paths) and are absent from metrics labels (tested).

## Input handling

- All request bodies, params and queries are validated with Zod; failures return a uniform envelope with field details.
- **No SQL is built from user input.** ClickHouse uses bound parameters; ORDER BY columns come from fixed maps; Postgres uses
  Drizzle's query builder. A test feeds `'; DROP TABLE requests; --` as a search term and confirms it is inert.
- Limits: request body (default 4 MiB for ingestion, 256 KiB elsewhere, also applied to the _decompressed_ gzip stream), spans
  per request, per-project span rate (token bucket), concurrent Kafka publishes, query range ≤ 14 days, pagination caps,
  per-query execution time.
- Errors never include stack traces, SQL or upstream messages; details are logged server-side under the request id.

## Telemetry privacy (applied before anything is stored)

TraceForge treats telemetry as sensitive. In `packages/domain/src/sanitize.ts`, applied to span, event and resource
attributes in the API (so redacted data never reaches Kafka or ClickHouse):

| Rule                                                                                                                                                            | Effect                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Keys with a token `authorization`, `cookie`, `set-cookie`, `password`, `secret`, `token`, `api-key`, `credentials`, `private-key`, `session.id`, `email`, `ssn` | attribute **dropped**                                                                 |
| `url.full`, `http.url`, `http.target`, `url.original`                                                                                                           | query string and fragment removed                                                     |
| `url.query`                                                                                                                                                     | dropped                                                                               |
| `db.statement`, `db.query.text`                                                                                                                                 | string and numeric literals replaced with `?`                                         |
| any value                                                                                                                                                       | truncated to 1,024 characters; max 64 attributes (32 resource)                        |
| request/response bodies, headers                                                                                                                                | never collected by TraceForge; header attributes matching the rules above are dropped |

Matching is token-based (`gen_ai.usage.input_tokens` is kept; `auth.token` is dropped). Redaction is **key-based, not
content-based**: a secret placed in a free-form attribute with an innocuous name (for example a message field) is not
detected. Exception messages and stack traces are stored (truncated to 1 KiB/4 KiB) because they are needed for grouping;
applications must not put secrets in exception messages. Span names are stored as sent.

## Transport, headers, CORS

- CORS is restricted to `WEB_ORIGINS` with credentials. Responses carry `X-Content-Type-Options: nosniff` and
  `Cache-Control: no-store`. The browser only talks to the same-origin `/api` proxy, so no cross-site cookies are needed.
- TLS termination is expected at a reverse proxy; set `TRUST_PROXY=true` only behind one so client addresses (used for rate
  limits) come from `X-Forwarded-For`. Without TLS in front, cookies must not be marked `Secure`; production mode forces them.

## Configuration and secrets

- Configuration is validated at startup (Zod); failures list the offending variable names and reasons but never values.
- `NODE_ENV=production` **refuses** the development credentials shipped in `docker-compose.yml`/`.env.example`.
- No secrets are committed: `.env*` is ignored except `.env.example`; the demo setup writes the demo key to `.env.demo` (ignored).
- The demo services refuse to start with `NODE_ENV=production` or without `DEMO_MODE=true`, bind to `127.0.0.1` by default, and
  the dashboard's demo-control proxy exists only when `DEMO_MODE=true` and requires a signed-in session and a same-origin request.

## Dependencies

`pnpm audit --prod --audit-level=low` reported **no known vulnerabilities** when this document was written (run in CI as
`pnpm audit --prod --audit-level=high`). KafkaJS is a stable but low-activity library; the alternative is
`@confluentinc/kafka-javascript` (librdkafka), which adds a native dependency.

## Known gaps

- In-memory rate limiting and key caching are **per process** (multiply limits by replica count; a shared store such as
  Redis would be the fix and was intentionally not added without a requirement).
- No audit log for sign-ins, no account lockout beyond rate limiting, no email verification/MFA, no API key scopes or expiry.
- No per-project retention, and deleting a project does not purge stored telemetry (it expires via the TTL).
- Self-instrumentation sends traces to a TraceForge project you configure; it is off unless `SELF_TELEMETRY_ENDPOINT` is set.
