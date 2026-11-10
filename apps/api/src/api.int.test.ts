import { gzipSync } from 'node:zlib';
import { SpanPublisher, createKafka } from '@traceforge/messaging';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestInfra, type TestInfra } from '../../../tests/helpers/infra';
import { otlpPayload, waitFor } from '../../../tests/helpers/spans';
import { buildApp } from './app';
import { loadApiConfig } from './config';
import { createMetrics } from './metrics';

const ORIGIN = 'http://localhost:3000';

describe('API (real Postgres, ClickHouse and Kafka)', () => {
  let infra: TestInfra;
  let app: FastifyInstance;
  let publisher: SpanPublisher;
  const closers: Array<() => Promise<unknown>> = [];

  async function startApp(overrides: Record<string, string> = {}, brokers = infra.brokers) {
    const c = loadApiConfig({
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: infra.databaseUrl,
      CLICKHOUSE_DATABASE: infra.clickhouse.database,
      KAFKA_BROKERS: brokers.join(','),
      LOG_LEVEL: 'silent',
      ...overrides,
    });
    const kafka = createKafka({
      brokers,
      clientId: 'api-it',
      logger: infra.logger,
      retry: { retries: 1, initialRetryTime: 50 },
    });
    const pub = new SpanPublisher(kafka, infra.logger, infra.spansTopic);
    const a = await buildApp({
      cfg: c,
      logger: infra.logger,
      pg: infra.pg,
      ch: infra.ch,
      kafka,
      publisher: pub,
      metrics: createMetrics(),
    });
    closers.push(
      () => a.close(),
      () => pub.stop(),
    );
    return { app: a, publisher: pub, cfg: c };
  }

  beforeAll(async () => {
    infra = await createTestInfra({ topics: true });
    ({ app, publisher } = await startApp());
    await publisher.start();
  });
  afterAll(async () => {
    for (const close of closers.reverse()) await close().catch(() => undefined);
    await infra.cleanup();
  });

  const cookieOf = (res: LightMyRequestResponse): string =>
    res.headers['set-cookie']?.toString().split(';')[0] ?? '';
  const json = <T = Record<string, unknown>>(res: LightMyRequestResponse): T => res.json<T>();
  const as = (cookie: string, extra: Record<string, string> = {}) => ({
    cookie,
    origin: ORIGIN,
    ...extra,
  });

  async function register(name: string) {
    const email = `${name}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    // Each simulated user connects from its own address so the per-IP signup throttle does not apply across tests.
    const remoteAddress = `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { origin: ORIGIN },
      remoteAddress,
      payload: { email, name, password: 'a-long-password-1' },
    });
    expect(res.statusCode).toBe(201);
    const me = json<{ workspaces: Array<{ id: string }> }>(res);
    return { email, cookie: cookieOf(res), workspaceId: me.workspaces[0]?.id ?? '' };
  }

  async function createProjectWithKey(cookie: string, workspaceId: string) {
    const project = json<{ id: string }>(
      await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/projects`,
        headers: as(cookie),
        payload: { name: 'Checkout' },
      }),
    );
    const key = json<{ id: string; secret: string; prefix: string }>(
      await app.inject({
        method: 'POST',
        url: `/v1/projects/${project.id}/api-keys`,
        headers: as(cookie),
        payload: { name: 'ci' },
      }),
    );
    return { projectId: project.id, key };
  }

  const ingest = (
    secret: string | null,
    payload: unknown,
    headers: Record<string, string> = {},
    instance = app,
  ) =>
    instance.inject({
      method: 'POST',
      url: '/v1/traces',
      headers: {
        'content-type': 'application/json',
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        ...headers,
      },
      payload:
        typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload),
    });

  describe('authentication and errors', () => {
    it('rejects anonymous access with the standard error envelope and a request id', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/me' });
      expect(res.statusCode).toBe(401);
      const body = json<{ error: { code: string; requestId: string } }>(res);
      expect(body.error.code).toBe('UNAUTHENTICATED');
      expect(body.error.requestId).toBe(res.headers['x-request-id']);
    });

    it('registers, issues an httpOnly SameSite cookie, and returns the user', async () => {
      const u = await register('alice');
      const res = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: u.cookie } });
      expect(res.statusCode).toBe(200);
      expect(json<{ user: { email: string } }>(res).user.email).toBe(u.email);
      const raw = String(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/auth/login',
            headers: { origin: ORIGIN },
            payload: { email: u.email, password: 'a-long-password-1' },
          })
        ).headers['set-cookie'],
      );
      expect(raw).toMatch(/HttpOnly/i);
      expect(raw).toMatch(/SameSite=Lax/i);
    });

    it('does not reveal whether an email exists on failed login', async () => {
      const u = await register('bob');
      const wrongPw = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { origin: ORIGIN },
        payload: { email: u.email, password: 'wrong-password-123' },
      });
      const noUser = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { origin: ORIGIN },
        payload: { email: 'nobody@example.com', password: 'wrong-password-123' },
      });
      expect(wrongPw.statusCode).toBe(401);
      expect(noUser.statusCode).toBe(401);
      expect(json<{ error: { message: string } }>(wrongPw).error.message).toBe(
        json<{ error: { message: string } }>(noUser).error.message,
      );
    });

    it('validates input with field-level details', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        headers: { origin: ORIGIN },
        payload: { email: 'not-an-email', name: '', password: 'short' },
      });
      expect(res.statusCode).toBe(400);
      const err = json<{ error: { code: string; details: Array<{ path: string }> } }>(res).error;
      expect(err.code).toBe('VALIDATION_ERROR');
      expect(err.details.map((d) => d.path).sort()).toEqual(['email', 'name', 'password']);
    });

    it('rejects cookie-authenticated mutations from a foreign origin (CSRF)', async () => {
      const u = await register('carol');
      const evil = await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        headers: { cookie: u.cookie, origin: 'https://evil.example' },
        payload: { name: 'x' },
      });
      expect(evil.statusCode).toBe(403);
      expect(json<{ error: { code: string } }>(evil).error.code).toBe('CSRF_REJECTED');
      const noOrigin = await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        headers: { cookie: u.cookie },
        payload: { name: 'x' },
      });
      expect(noOrigin.statusCode).toBe(403);
      const ok = await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        headers: as(u.cookie),
        payload: { name: 'ok' },
      });
      expect(ok.statusCode).toBe(201);
    });

    it('throttles repeated login attempts', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 14; i++) {
        statuses.push(
          (
            await app.inject({
              method: 'POST',
              url: '/v1/auth/login',
              headers: { origin: ORIGIN },
              remoteAddress: '10.9.9.9',
              payload: { email: 'x@example.com', password: 'wrong-password-123' },
            })
          ).statusCode,
        );
      }
      expect(statuses).toContain(429);
    });
  });

  describe('workspace and project isolation', () => {
    it("hides one workspace's projects and resources from another user", async () => {
      const a = await register('owner-a');
      const b = await register('owner-b');
      const { projectId } = await createProjectWithKey(a.cookie, a.workspaceId);

      for (const [method, url] of [
        ['GET', `/v1/projects/${projectId}`],
        ['GET', `/v1/projects/${projectId}/overview`],
        ['GET', `/v1/projects/${projectId}/alert-rules`],
        ['GET', `/v1/projects/${projectId}/api-keys`],
        ['GET', `/v1/workspaces/${a.workspaceId}/projects`],
      ] as const) {
        const res = await app.inject({ method, url, headers: as(b.cookie) });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
      }
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/v1/projects/${projectId}/api-keys`,
            headers: as(b.cookie),
            payload: { name: 'steal' },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/v1/projects/${projectId}`,
            headers: as(b.cookie),
            payload: { confirmName: 'Checkout' },
          })
        ).statusCode,
      ).toBe(404);
    });

    it('enforces roles: viewers can read but not change anything', async () => {
      const owner = await register('owner-r');
      const viewer = await register('viewer-r');
      const { projectId } = await createProjectWithKey(owner.cookie, owner.workspaceId);
      const add = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${owner.workspaceId}/members`,
        headers: as(owner.cookie),
        payload: { email: viewer.email, role: 'viewer' },
      });
      expect(add.statusCode).toBe(201);

      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/v1/projects/${projectId}/overview?range=15m`,
            headers: as(viewer.cookie),
          })
        ).statusCode,
      ).toBe(200);
      const rule = {
        name: 'r',
        metric: 'error_rate',
        operator: 'gt',
        threshold: 5,
        windowMinutes: 5,
      };
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/v1/projects/${projectId}/alert-rules`,
            headers: as(viewer.cookie),
            payload: rule,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/v1/projects/${projectId}/api-keys`,
            headers: as(viewer.cookie),
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/v1/workspaces/${owner.workspaceId}/projects`,
            headers: as(viewer.cookie),
            payload: { name: 'nope' },
          })
        ).statusCode,
      ).toBe(403);
    });
  });

  describe('API keys', () => {
    it('shows the secret once, stores only a hash, and supports rotation and revocation', async () => {
      const u = await register('keys');
      const { projectId, key } = await createProjectWithKey(u.cookie, u.workspaceId);
      expect(key.secret).toMatch(/^tf_live_/);

      const list = await app.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/api-keys`,
        headers: as(u.cookie),
      });
      expect(list.body).not.toContain(key.secret);
      expect(list.body).toContain(key.prefix);

      expect((await ingest(key.secret, otlpPayload(1))).statusCode).toBe(200);

      const rotated = json<{ secret: string }>(
        await app.inject({
          method: 'POST',
          url: `/v1/projects/${projectId}/api-keys/${key.id}/rotate`,
          headers: as(u.cookie),
        }),
      );
      expect(rotated.secret).not.toBe(key.secret);
      expect((await ingest(key.secret, otlpPayload(1))).statusCode).toBe(401); // old key dead immediately on this instance
      expect((await ingest(rotated.secret, otlpPayload(1))).statusCode).toBe(200);

      const keys = json<{ keys: Array<{ id: string; revokedAt: string | null }> }>(
        await app.inject({
          method: 'GET',
          url: `/v1/projects/${projectId}/api-keys`,
          headers: as(u.cookie),
        }),
      ).keys;
      const active = keys.find((k) => k.revokedAt === null);
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/v1/projects/${projectId}/api-keys/${active?.id}`,
            headers: as(u.cookie),
          })
        ).statusCode,
      ).toBe(204);
      expect((await ingest(rotated.secret, otlpPayload(1))).statusCode).toBe(401);
    });

    it('a key only writes to its own project', async () => {
      const a = await register('proj-a');
      const b = await register('proj-b');
      const pa = await createProjectWithKey(a.cookie, a.workspaceId);
      const pb = await createProjectWithKey(b.cookie, b.workspaceId);
      expect(
        (await ingest(pa.key.secret, otlpPayload(3, { environment: 'iso-a' }))).statusCode,
      ).toBe(200);
      expect(
        (await ingest(pb.key.secret, otlpPayload(2, { environment: 'iso-b' }))).statusCode,
      ).toBe(200);

      // The project a span is attributed to comes from the key, never from the payload: read it back off the topic.
      const seen: Array<{ environment: string; projectId: string }> = [];
      const reader = infra.kafka.consumer({
        groupId: `iso-${Math.random().toString(36).slice(2)}`,
      });
      await reader.connect();
      await reader.subscribe({ topic: infra.spansTopic, fromBeginning: true });
      await reader.run({
        eachMessage: ({ message }) => {
          const e = JSON.parse(message.value?.toString() ?? '{}') as {
            environment: string;
            projectId: string;
          };
          if (e.environment.startsWith('iso-')) seen.push(e);
          return Promise.resolve();
        },
      });
      await waitFor(() => Promise.resolve(seen.length >= 5), 20_000);
      await reader.disconnect();
      expect(
        seen.filter((s) => s.environment === 'iso-a').every((s) => s.projectId === pa.projectId),
      ).toBe(true);
      expect(
        seen.filter((s) => s.environment === 'iso-b').every((s) => s.projectId === pb.projectId),
      ).toBe(true);
    });
  });

  describe('ingestion', () => {
    let secret: string;
    beforeAll(async () => {
      const u = await register('ingest');
      secret = (await createProjectWithKey(u.cookie, u.workspaceId)).key.secret;
    });

    it('rejects missing and invalid keys with 401', async () => {
      expect((await ingest(null, otlpPayload(1))).statusCode).toBe(401);
      expect((await ingest('tf_live_' + 'x'.repeat(43), otlpPayload(1))).statusCode).toBe(401);
      expect((await ingest('not-a-key', otlpPayload(1))).statusCode).toBe(401);
    });

    it('accepts x-traceforge-key as an alternative to the bearer header', async () => {
      const res = await ingest(null, otlpPayload(1), { 'x-traceforge-key': secret });
      expect(res.statusCode).toBe(200);
    });

    it('rejects malformed JSON, wrong shapes and protobuf with specific statuses', async () => {
      expect((await ingest(secret, '{oops')).statusCode).toBe(400);
      const wrong = await ingest(secret, { resourceSpans: [{ scopeSpans: 'x' }] });
      expect(wrong.statusCode).toBe(400);
      expect(json<{ error: { details: unknown[] } }>(wrong).error.details.length).toBeGreaterThan(
        0,
      );
      const proto = await ingest(secret, Buffer.from([0x0a, 0x00]), {
        'content-type': 'application/x-protobuf',
      });
      expect(proto.statusCode).toBe(415);
      expect(json<{ error: { message: string } }>(proto).error.message).toMatch(/http\/json/);
    });

    it('enforces request-size and span-count limits', async () => {
      const tiny = await startApp({
        INGEST_MAX_BODY_BYTES: '2048',
        INGEST_MAX_SPANS_PER_REQUEST: '5',
      });
      const u = await register('limits');
      // Keys are validated against the shared database, so a key created through `app` works on `tiny` too.
      const k = (await createProjectWithKey(u.cookie, u.workspaceId)).key.secret;
      expect((await ingest(k, otlpPayload(6), {}, tiny.app)).statusCode).toBe(413);
      const big = otlpPayload(1);
      (big.resourceSpans[0] as { resource: { attributes: unknown[] } }).resource.attributes.push({
        key: 'pad',
        value: { stringValue: 'x'.repeat(5000) },
      });
      expect((await ingest(k, big, {}, tiny.app)).statusCode).toBe(413);
    });

    it('accepts gzip bodies and bounds the decompressed size', async () => {
      const gz = gzipSync(JSON.stringify(otlpPayload(3)));
      expect((await ingest(secret, gz, { 'content-encoding': 'gzip' })).statusCode).toBe(200);
      expect(
        (await ingest(secret, Buffer.from('not gzip at all'), { 'content-encoding': 'gzip' }))
          .statusCode,
      ).toBe(400);
      const small = await startApp({ INGEST_MAX_BODY_BYTES: '4096' });
      const bomb = gzipSync(Buffer.alloc(2_000_000, 'a')); // tiny on the wire, huge when inflated
      expect(bomb.length).toBeLessThan(4096);
      const u = await register('bomb');
      const k = (await createProjectWithKey(u.cookie, u.workspaceId)).key.secret;
      expect((await ingest(k, bomb, { 'content-encoding': 'gzip' }, small.app)).statusCode).toBe(
        413,
      );
    });

    it('reports partial success for invalid spans instead of failing the batch', async () => {
      const payload = otlpPayload(2);
      const spans =
        (
          payload.resourceSpans[0] as {
            scopeSpans: Array<{ spans: Array<Record<string, unknown>> }>;
          }
        ).scopeSpans[0]?.spans ?? [];
      if (spans[1]) spans[1].traceId = 'bad';
      const res = await ingest(secret, payload);
      expect(res.statusCode).toBe(200);
      expect(
        json<{ partialSuccess: { rejectedSpans: number } }>(res).partialSuccess.rejectedSpans,
      ).toBe(1);
    });

    it('rate limits per project with Retry-After once the burst budget is spent', async () => {
      const limited = await startApp({
        INGEST_RATE_LIMIT_SPANS_PER_SECOND: '1',
        INGEST_RATE_LIMIT_BURST_SPANS: '10',
      });
      const u = await register('rl');
      const k = (await createProjectWithKey(u.cookie, u.workspaceId)).key.secret;
      expect((await ingest(k, otlpPayload(8), {}, limited.app)).statusCode).toBe(200);
      const res = await ingest(k, otlpPayload(8), {}, limited.app);
      expect(res.statusCode).toBe(429);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(json<{ error: { code: string } }>(res).error.code).toBe('RATE_LIMITED');
    });

    it('returns 503 with Retry-After, and acknowledges nothing, when Kafka is unavailable', async () => {
      const broken = await startApp({}, ['127.0.0.1:19']); // nothing listens here
      const u = await register('kafkadown');
      const k = (await createProjectWithKey(u.cookie, u.workspaceId)).key.secret;
      const res = await ingest(k, otlpPayload(2), {}, broken.app);
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBeDefined();
      expect(json<{ error: { code: string } }>(res).error.code).toBe('INGESTION_UNAVAILABLE');
      // The instance is alive and reports the degraded dependency rather than failing liveness.
      expect((await broken.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      const ready = await broken.app.inject({ method: 'GET', url: '/readyz' });
      expect(ready.statusCode).toBe(200);
      expect(json<{ status: string; checks: { kafka: string } }>(ready)).toMatchObject({
        status: 'degraded',
        checks: { kafka: 'down' },
      });
    });
  });

  describe('alerts API', () => {
    it('validates rules, then supports the incident lifecycle with conflict handling', async () => {
      const u = await register('alerts');
      const { projectId } = await createProjectWithKey(u.cookie, u.workspaceId);
      const bad = await app.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/alert-rules`,
        headers: as(u.cookie),
        payload: {
          name: 'bad',
          metric: 'error_rate',
          operator: 'gt',
          threshold: 150,
          windowMinutes: 5,
        },
      });
      expect(bad.statusCode).toBe(400);
      const rule = json<{ id: string }>(
        await app.inject({
          method: 'POST',
          url: `/v1/projects/${projectId}/alert-rules`,
          headers: as(u.cookie),
          payload: {
            name: 'Errors',
            metric: 'error_rate',
            operator: 'gt',
            threshold: 5,
            windowMinutes: 5,
          },
        }),
      );
      const toggled = json<{ enabled: boolean }>(
        await app.inject({
          method: 'PATCH',
          url: `/v1/projects/${projectId}/alert-rules/${rule.id}`,
          headers: as(u.cookie),
          payload: { enabled: false },
        }),
      );
      expect(toggled.enabled).toBe(false);

      // Open an incident directly (the evaluator is covered separately) and walk the lifecycle.
      const { openIncident } = await import('@traceforge/storage');
      const evidence = {
        metric: 'error_rate' as const,
        operator: 'gt' as const,
        threshold: 5,
        observed: 9,
        windowMinutes: 5,
        requests: 100,
        windowStart: new Date().toISOString(),
        windowEnd: new Date().toISOString(),
        sampleTraceIds: [],
      };
      const id = await openIncident(
        infra.pg.db,
        { id: rule.id, projectId, name: 'Errors', severity: 'warning' },
        evidence,
      );
      expect(id).not.toBeNull();
      expect(
        await openIncident(
          infra.pg.db,
          { id: rule.id, projectId, name: 'Errors', severity: 'warning' },
          evidence,
        ),
      ).toBeNull(); // no duplicate while active

      const ack = await app.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/incidents/${id}/acknowledge`,
        headers: as(u.cookie),
      });
      expect(json<{ status: string }>(ack).status).toBe('acknowledged');
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/v1/projects/${projectId}/incidents/${id}/acknowledge`,
            headers: as(u.cookie),
          })
        ).statusCode,
      ).toBe(409);
      const resolved = json<{
        status: string;
        resolution: string;
        events: Array<{ type: string }>;
      }>(
        await app.inject({
          method: 'POST',
          url: `/v1/projects/${projectId}/incidents/${id}/resolve`,
          headers: as(u.cookie),
        }),
      );
      expect(resolved).toMatchObject({ status: 'resolved', resolution: 'manual' });
      expect(resolved.events.map((e) => e.type)).toEqual(['opened', 'acknowledged', 'resolved']);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/v1/projects/${projectId}/incidents/${id}/resolve`,
            headers: as(u.cookie),
          })
        ).statusCode,
      ).toBe(409);
    });
  });

  describe('operations', () => {
    it('serves liveness, readiness and an OpenAPI document', async () => {
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      const ready = await app.inject({ method: 'GET', url: '/readyz' });
      expect(ready.statusCode).toBe(200);
      expect(json<{ checks: Record<string, string> }>(ready).checks).toMatchObject({
        postgres: 'ok',
        clickhouse: 'ok',
        kafka: 'ok',
      });
      const doc = json<{ openapi: string; paths: Record<string, unknown> }>(
        await app.inject({ method: 'GET', url: '/openapi.json' }),
      );
      expect(doc.openapi).toBe('3.1.0');
      expect(Object.keys(doc.paths)).toContain('/v1/traces');
    });

    it('exposes Prometheus metrics without credentials in labels', async () => {
      const res = await app.inject({ method: 'GET', url: '/metrics' });
      expect(res.body).toContain('traceforge_ingest_requests_total');
      expect(res.body).not.toContain('tf_live_');
    });
  });
});
