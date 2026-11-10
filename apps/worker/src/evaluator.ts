import type { AlertRuleDto, IncidentEvidence } from '@traceforge/contracts';
import { decideIncidentAction, evaluateRule } from '@traceforge/domain';
import type { Logger } from '@traceforge/logger';
import {
  analytics,
  autoResolveIncident,
  findOpenIncident,
  listEnabledRules,
  openIncident,
  recordRecovering,
  refreshIncident,
  type ClickHouseClient,
  type Db,
  type PgHandle,
} from '@traceforge/storage';
import { sql } from 'drizzle-orm';
import type { WorkerMetrics } from './metrics';

/** Arbitrary constant identifying "the alert evaluator" for pg advisory locks. */
const ADVISORY_LOCK_KEY = 7_262_024;

export interface EvaluatorDeps {
  pg: PgHandle;
  ch: ClickHouseClient;
  logger: Logger;
  metrics: WorkerMetrics;
  now?: () => Date;
}

/**
 * Evaluates enabled alert rules against stored telemetry and drives incident state transitions. Safe to run on several
 * worker instances: each tick takes a transaction-scoped Postgres advisory lock, so only one instance evaluates at a
 * time, and a partial unique index guarantees at most one open incident per rule even if that lock were bypassed.
 */
export class AlertEvaluator {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly deps: EvaluatorDeps,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    const loop = (): void => {
      if (this.stopped) return;
      this.timer = setTimeout(() => {
        void this.tick().finally(loop);
      }, this.intervalMs);
      this.timer.unref();
    };
    loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 50));
  }

  /** One evaluation pass over every enabled rule. Exposed for tests. */
  async tick(): Promise<{ evaluated: number } | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.deps.pg.db.transaction(async (tx) => {
        const rows = await tx.execute(
          sql`select pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY}) as locked`,
        );
        if (!(rows[0] as { locked?: boolean } | undefined)?.locked) return null; // another instance is evaluating
        const rules = await listEnabledRules(tx);
        for (const rule of rules) {
          try {
            await this.evaluateOne(tx, rule);
          } catch (error) {
            // One rule failing (for example a ClickHouse timeout) must not prevent the others from being evaluated.
            this.deps.metrics.alertEvaluations.inc({ outcome: 'error' });
            this.deps.logger.error({ err: error, ruleId: rule.id }, 'alert evaluation failed');
          }
        }
        return { evaluated: rules.length };
      });
    } catch (error) {
      this.deps.logger.error({ err: error }, 'alert evaluation pass failed');
      return null;
    } finally {
      this.running = false;
    }
  }

  private async evaluateOne(db: Db, rule: AlertRuleDto): Promise<void> {
    const { ch, metrics, logger } = this.deps;
    const to = this.deps.now?.() ?? new Date();
    const from = new Date(to.getTime() - rule.windowMinutes * 60_000);
    const scope: analytics.Scope = {
      projectId: rule.projectId,
      from,
      to,
      environment: rule.environment ?? undefined,
      service: rule.service ?? undefined,
    };
    const endpoint = { method: rule.method ?? undefined, route: rule.route ?? undefined };
    const totals = await analytics.getTotals(ch, scope, endpoint);
    const result = evaluateRule(rule, {
      requests: totals.requests,
      errors: totals.errors,
      p95: totals.p95,
      p99: totals.p99,
    });

    const open = await findOpenIncident(db, rule.id);
    const decision = decideIncidentAction(
      open ? { recoveryStreak: open.recoveryStreak } : null,
      result,
    );
    metrics.alertEvaluations.inc({
      outcome: result.insufficientData ? 'insufficient_data' : result.breached ? 'breached' : 'ok',
    });

    const observed = result.observed ?? 0;
    const buildEvidence = async (): Promise<IncidentEvidence> => ({
      metric: rule.metric,
      operator: rule.operator,
      threshold: rule.threshold,
      observed,
      windowMinutes: rule.windowMinutes,
      requests: totals.requests,
      windowStart: from.toISOString(),
      windowEnd: to.toISOString(),
      sampleTraceIds: await analytics.sampleTraceIds(
        ch,
        scope,
        endpoint,
        rule.metric === 'error_rate' ? 'errors' : 'slowest',
      ),
    });

    switch (decision.action) {
      case 'none':
        return;
      case 'open': {
        const id = await openIncident(db, rule, await buildEvidence());
        if (id) {
          metrics.incidentTransitions.inc({ transition: 'opened' });
          logger.info({ ruleId: rule.id, incidentId: id, observed }, 'incident opened');
        }
        return;
      }
      case 'refresh':
        if (open) await refreshIncident(db, open.id, rule.operator, await buildEvidence());
        return;
      case 'recovering':
        if (open) await recordRecovering(db, open.id, decision.recoveryStreak, result.observed);
        return;
      case 'resolve':
        if (open && (await autoResolveIncident(db, open.id, result.observed))) {
          metrics.incidentTransitions.inc({ transition: 'auto_resolved' });
          logger.info({ ruleId: rule.id, incidentId: open.id }, 'incident auto-resolved');
        }
        return;
    }
  }
}
