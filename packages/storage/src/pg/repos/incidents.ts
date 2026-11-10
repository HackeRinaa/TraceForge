import type {
  AlertRuleDto,
  IncidentDto,
  IncidentEventDto,
  IncidentEvidence,
  IncidentStatus,
} from '@traceforge/contracts';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { alertIncidents, incidentEvents, users } from '../schema';
import { isUniqueViolation } from './common';

type IncidentRow = typeof alertIncidents.$inferSelect;

function toDto(r: IncidentRow, events?: IncidentEventDto[]): IncidentDto {
  return {
    id: r.id,
    ruleId: r.ruleId,
    ruleName: r.ruleSnapshot.name,
    severity: r.ruleSnapshot.severity,
    status: r.status,
    openedAt: r.openedAt.toISOString(),
    acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    resolution: r.resolution,
    peakValue: r.peakValue,
    lastValue: r.lastValue,
    lastEvaluatedAt: r.lastEvaluatedAt?.toISOString() ?? null,
    evidence: r.evidence,
    ...(events ? { events } : {}),
  };
}

export interface OpenIncidentRef {
  id: string;
  status: IncidentStatus;
  recoveryStreak: number;
  peakValue: number;
}

export async function findOpenIncident(db: Db, ruleId: string): Promise<OpenIncidentRef | null> {
  const [row] = await db
    .select({
      id: alertIncidents.id,
      status: alertIncidents.status,
      recoveryStreak: alertIncidents.recoveryStreak,
      peakValue: alertIncidents.peakValue,
    })
    .from(alertIncidents)
    .where(and(eq(alertIncidents.ruleId, ruleId), ne(alertIncidents.status, 'resolved')));
  return row ?? null;
}

/**
 * Opens an incident and records the transition atomically. If a concurrent evaluator already opened one, the partial
 * unique index rejects the insert and this returns null instead of creating a duplicate.
 */
export async function openIncident(
  db: Db,
  rule: Pick<AlertRuleDto, 'id' | 'projectId' | 'name' | 'severity'>,
  evidence: IncidentEvidence,
): Promise<string | null> {
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(alertIncidents)
        .values({
          ruleId: rule.id,
          projectId: rule.projectId,
          peakValue: evidence.observed,
          lastValue: evidence.observed,
          lastEvaluatedAt: sql`now()`,
          evidence,
          ruleSnapshot: { name: rule.name, severity: rule.severity },
        })
        .returning({ id: alertIncidents.id });
      if (!row) throw new Error('incident insert returned no row');
      await tx.insert(incidentEvents).values({
        incidentId: row.id,
        type: 'opened',
        data: { observed: evidence.observed, threshold: evidence.threshold },
      });
      return row.id;
    });
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}

/** Records a still-breaching evaluation. The peak is the worst value seen: highest for `gt` rules, lowest for `lt`. */
export async function refreshIncident(
  db: Db,
  incidentId: string,
  operator: 'gt' | 'lt',
  evidence: IncidentEvidence,
): Promise<void> {
  const peak =
    operator === 'gt'
      ? sql`greatest(${alertIncidents.peakValue}, ${evidence.observed})`
      : sql`least(${alertIncidents.peakValue}, ${evidence.observed})`;
  await db
    .update(alertIncidents)
    .set({
      lastValue: evidence.observed,
      peakValue: peak,
      recoveryStreak: 0,
      lastEvaluatedAt: sql`now()`,
      evidence,
    })
    .where(and(eq(alertIncidents.id, incidentId), ne(alertIncidents.status, 'resolved')));
}

export async function recordRecovering(
  db: Db,
  incidentId: string,
  streak: number,
  observed: number | null,
): Promise<void> {
  await db
    .update(alertIncidents)
    .set({
      recoveryStreak: streak,
      lastEvaluatedAt: sql`now()`,
      ...(observed !== null ? { lastValue: observed } : {}),
    })
    .where(and(eq(alertIncidents.id, incidentId), ne(alertIncidents.status, 'resolved')));
}

async function transition(
  db: Db,
  where: ReturnType<typeof and>,
  set: Partial<typeof alertIncidents.$inferInsert>,
  event: {
    type: 'acknowledged' | 'resolved' | 'auto_resolved';
    actorUserId: string | null;
    data?: Record<string, unknown>;
  },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(alertIncidents)
      .set(set)
      .where(where)
      .returning({ id: alertIncidents.id });
    if (!row) return false;
    await tx.insert(incidentEvents).values({
      incidentId: row.id,
      type: event.type,
      actorUserId: event.actorUserId,
      data: event.data ?? {},
    });
    return true;
  });
}

export function autoResolveIncident(
  db: Db,
  incidentId: string,
  observed: number | null,
): Promise<boolean> {
  return transition(
    db,
    and(eq(alertIncidents.id, incidentId), ne(alertIncidents.status, 'resolved')),
    {
      status: 'resolved',
      resolution: 'auto',
      resolvedAt: sql`now()` as unknown as Date,
      lastEvaluatedAt: sql`now()` as unknown as Date,
      ...(observed !== null ? { lastValue: observed } : {}),
    },
    { type: 'auto_resolved', actorUserId: null, data: observed !== null ? { observed } : {} },
  );
}

/** Firing -> acknowledged. Returns false if the incident is not in this project or not currently firing. */
export function acknowledgeIncident(
  db: Db,
  projectId: string,
  incidentId: string,
  userId: string,
): Promise<boolean> {
  return transition(
    db,
    and(
      eq(alertIncidents.id, incidentId),
      eq(alertIncidents.projectId, projectId),
      eq(alertIncidents.status, 'firing'),
    ),
    {
      status: 'acknowledged',
      acknowledgedAt: sql`now()` as unknown as Date,
      acknowledgedBy: userId,
    },
    { type: 'acknowledged', actorUserId: userId },
  );
}

/** Firing or acknowledged -> resolved by a person. If the condition still holds, the next evaluation opens a new one. */
export function resolveIncidentManually(
  db: Db,
  projectId: string,
  incidentId: string,
  userId: string,
): Promise<boolean> {
  return transition(
    db,
    and(
      eq(alertIncidents.id, incidentId),
      eq(alertIncidents.projectId, projectId),
      ne(alertIncidents.status, 'resolved'),
    ),
    {
      status: 'resolved',
      resolution: 'manual',
      resolvedAt: sql`now()` as unknown as Date,
      resolvedBy: userId,
    },
    { type: 'resolved', actorUserId: userId },
  );
}

export async function listIncidents(
  db: Db,
  projectId: string,
  opts: { statuses?: IncidentStatus[]; limit: number },
): Promise<IncidentDto[]> {
  const where = opts.statuses?.length
    ? and(eq(alertIncidents.projectId, projectId), inArray(alertIncidents.status, opts.statuses))
    : eq(alertIncidents.projectId, projectId);
  const rows = await db
    .select()
    .from(alertIncidents)
    .where(where)
    .orderBy(desc(alertIncidents.openedAt))
    .limit(opts.limit);
  return rows.map((r) => toDto(r));
}

export async function getIncident(
  db: Db,
  projectId: string,
  incidentId: string,
): Promise<IncidentDto | null> {
  const [row] = await db
    .select()
    .from(alertIncidents)
    .where(and(eq(alertIncidents.projectId, projectId), eq(alertIncidents.id, incidentId)));
  if (!row) return null;
  const events = await db
    .select({
      id: incidentEvents.id,
      type: incidentEvents.type,
      at: incidentEvents.at,
      data: incidentEvents.data,
      actor: users.name,
    })
    .from(incidentEvents)
    .leftJoin(users, eq(users.id, incidentEvents.actorUserId))
    .where(eq(incidentEvents.incidentId, incidentId))
    .orderBy(asc(incidentEvents.at));
  return toDto(
    row,
    events.map((e) => ({
      id: e.id,
      type: e.type,
      at: e.at.toISOString(),
      actor: e.actor,
      data: e.data,
    })),
  );
}

export async function countActiveIncidents(db: Db, projectId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(alertIncidents)
    .where(and(eq(alertIncidents.projectId, projectId), ne(alertIncidents.status, 'resolved')));
  return row?.n ?? 0;
}
