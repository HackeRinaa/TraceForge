import { deriveRows } from '@traceforge/domain';
import {
  acknowledgeIncident,
  createAlertRule,
  createProject,
  createUser,
  createWorkspace,
  getIncident,
  insertDerivedRows,
  listIncidents,
  resolveIncidentManually,
} from '@traceforge/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestInfra, type TestInfra } from '../../../tests/helpers/infra';
import { spanEvent } from '../../../tests/helpers/spans';
import { AlertEvaluator } from './evaluator';
import { createWorkerMetrics } from './metrics';

describe('alert evaluator (real Postgres and ClickHouse)', () => {
  let infra: TestInfra;
  let projectId: string;
  let userId: string;
  let ruleId: string;
  let clock = Date.parse('2026-10-27T12:00:00Z');

  const evaluator = () =>
    new AlertEvaluator(
      {
        pg: infra.pg,
        ch: infra.ch,
        logger: infra.logger,
        metrics: createWorkerMetrics(),
        now: () => new Date(clock),
      },
      60_000,
    );

  /** Inserts `total` request rows ending at the fake clock, `errors` of which are 5xx responses. */
  async function traffic(total: number, errors: number, durationUs = 80_000) {
    const events = Array.from({ length: total }, (_, i) =>
      spanEvent(projectId, {
        receivedAt: clock,
        startTimeUs: (clock - 30_000 - i * 100) * 1000,
        durationUs,
        attributes: {
          'http.method': 'GET',
          'http.route': '/api/items',
          'http.status_code': i < errors ? '500' : '200',
        },
      }),
    );
    await insertDerivedRows(
      infra.ch,
      events.map((e) => deriveRows(e, clock)),
    );
  }

  const incidents = () => listIncidents(infra.pg.db, projectId, { limit: 50 });

  beforeAll(async () => {
    infra = await createTestInfra();
    const user = await createUser(infra.pg.db, {
      email: 'eval@example.com',
      name: 'Eval',
      passwordHash: 'x',
    });
    userId = user.id;
    const ws = await createWorkspace(infra.pg.db, { name: 'W', ownerId: user.id });
    projectId = (await createProject(infra.pg.db, { workspaceId: ws.id, name: 'P' })).id;
    ruleId = (
      await createAlertRule(infra.pg.db, projectId, userId, {
        name: 'Error rate',
        metric: 'error_rate',
        operator: 'gt',
        threshold: 10,
        windowMinutes: 5,
        minRequests: 10,
        severity: 'critical',
        enabled: true,
      })
    ).id;
  });
  afterAll(async () => {
    await infra.cleanup();
  });

  it('does nothing without enough traffic', async () => {
    await traffic(3, 3); // 100% errors but only 3 requests: below minRequests
    await evaluator().tick();
    expect(await incidents()).toHaveLength(0);
  });

  it('opens exactly one incident with evidence, and never duplicates it on later evaluations', async () => {
    await traffic(40, 20); // ~47% error rate over 43 requests
    const ev = evaluator();
    await ev.tick();
    const [first] = await incidents();
    expect(first).toMatchObject({ status: 'firing', ruleName: 'Error rate', severity: 'critical' });
    expect(first?.evidence.observed).toBeGreaterThan(40);
    expect(first?.evidence.requests).toBe(43);
    expect(first?.evidence.sampleTraceIds.length).toBeGreaterThan(0);

    clock += 15_000;
    await ev.tick();
    await ev.tick();
    expect(await incidents()).toHaveLength(1);
  });

  it('keeps an acknowledged incident active and still does not duplicate it', async () => {
    const [inc] = await incidents();
    expect(await acknowledgeIncident(infra.pg.db, projectId, inc?.id ?? '', userId)).toBe(true);
    expect(await acknowledgeIncident(infra.pg.db, projectId, inc?.id ?? '', userId)).toBe(false); // only from firing
    clock += 15_000;
    await evaluator().tick();
    const all = await incidents();
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe('acknowledged');
  });

  it('auto-resolves only after consecutive healthy evaluations, recording the transition history', async () => {
    clock += 10 * 60_000; // the failing traffic is now outside the 5-minute window
    await traffic(40, 0);
    const ev = evaluator();
    await ev.tick();
    expect((await incidents())[0]?.status).toBe('acknowledged'); // one healthy evaluation is not enough
    await ev.tick();
    const [resolved] = await incidents();
    expect(resolved).toMatchObject({ status: 'resolved', resolution: 'auto' });
    const detail = await getIncident(infra.pg.db, projectId, resolved?.id ?? '');
    expect(detail?.events?.map((e) => e.type)).toEqual(['opened', 'acknowledged', 'auto_resolved']);
  });

  it('opens a fresh incident when the condition returns after resolution', async () => {
    clock += 10 * 60_000;
    await traffic(30, 20);
    await evaluator().tick();
    const all = await incidents();
    expect(all).toHaveLength(2);
    expect(all.filter((i) => i.status !== 'resolved')).toHaveLength(1);
  });

  it('a manual resolve while the problem persists reopens on the next evaluation', async () => {
    const open = (await incidents()).find((i) => i.status !== 'resolved');
    expect(await resolveIncidentManually(infra.pg.db, projectId, open?.id ?? '', userId)).toBe(
      true,
    );
    await evaluator().tick();
    const all = await incidents();
    expect(all).toHaveLength(3);
    expect(all.filter((i) => i.status !== 'resolved')).toHaveLength(1);
  });

  it('concurrent evaluators never create duplicate incidents', async () => {
    const rule2 = await createAlertRule(infra.pg.db, projectId, userId, {
      name: 'Latency',
      metric: 'p95_latency_ms',
      operator: 'gt',
      threshold: 1,
      windowMinutes: 5,
      minRequests: 5,
      severity: 'warning',
      enabled: true,
    });
    await Promise.all([
      evaluator().tick(),
      evaluator().tick(),
      evaluator().tick(),
      evaluator().tick(),
    ]);
    const latency = (await incidents()).filter((i) => i.ruleId === rule2.id);
    expect(latency).toHaveLength(1);
    expect(latency[0]?.evidence.observed).toBeGreaterThan(1);
    expect(ruleId).toBeTruthy();
  });

  it('ignores disabled rules', async () => {
    await createAlertRule(infra.pg.db, projectId, userId, {
      name: 'Disabled',
      metric: 'request_rate',
      operator: 'gt',
      threshold: 0,
      windowMinutes: 5,
      minRequests: 0,
      severity: 'warning',
      enabled: false,
    });
    const before = (await incidents()).length;
    await evaluator().tick();
    expect((await incidents()).length).toBe(before);
  });
});
