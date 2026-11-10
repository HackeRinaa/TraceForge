import type { AlertRuleDto, AlertRuleInput } from '@traceforge/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { alertRules, projects } from '../schema';

type RuleRow = typeof alertRules.$inferSelect;

const toDto = (r: RuleRow): AlertRuleDto => ({
  id: r.id,
  projectId: r.projectId,
  name: r.name,
  metric: r.metric,
  operator: r.operator,
  threshold: r.threshold,
  windowMinutes: r.windowMinutes,
  minRequests: r.minRequests,
  environment: r.environment,
  service: r.service,
  method: r.method,
  route: r.route,
  severity: r.severity,
  enabled: r.enabled,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

export async function createAlertRule(
  db: Db,
  projectId: string,
  createdBy: string,
  input: AlertRuleInput,
): Promise<AlertRuleDto> {
  const [row] = await db
    .insert(alertRules)
    .values({
      projectId,
      createdBy,
      name: input.name,
      metric: input.metric,
      operator: input.operator,
      threshold: input.threshold,
      windowMinutes: input.windowMinutes,
      minRequests: input.minRequests,
      environment: input.environment ?? null,
      service: input.service ?? null,
      method: input.method?.toUpperCase() ?? null,
      route: input.route ?? null,
      severity: input.severity,
      enabled: input.enabled,
    })
    .returning();
  if (!row) throw new Error('alert rule insert returned no row');
  return toDto(row);
}

export async function listAlertRules(db: Db, projectId: string): Promise<AlertRuleDto[]> {
  const rows = await db
    .select()
    .from(alertRules)
    .where(eq(alertRules.projectId, projectId))
    .orderBy(asc(alertRules.createdAt));
  return rows.map(toDto);
}

export async function getAlertRule(
  db: Db,
  projectId: string,
  ruleId: string,
): Promise<AlertRuleDto | null> {
  const [row] = await db
    .select()
    .from(alertRules)
    .where(and(eq(alertRules.projectId, projectId), eq(alertRules.id, ruleId)));
  return row ? toDto(row) : null;
}

export async function updateAlertRule(
  db: Db,
  projectId: string,
  ruleId: string,
  patch: Partial<AlertRuleInput>,
): Promise<AlertRuleDto | null> {
  const values: Partial<typeof alertRules.$inferInsert> = {
    updatedAt: sql`now()` as unknown as Date,
  };
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.metric !== undefined) values.metric = patch.metric;
  if (patch.operator !== undefined) values.operator = patch.operator;
  if (patch.threshold !== undefined) values.threshold = patch.threshold;
  if (patch.windowMinutes !== undefined) values.windowMinutes = patch.windowMinutes;
  if (patch.minRequests !== undefined) values.minRequests = patch.minRequests;
  if (patch.environment !== undefined) values.environment = patch.environment;
  if (patch.service !== undefined) values.service = patch.service;
  if (patch.method !== undefined) values.method = patch.method?.toUpperCase() ?? null;
  if (patch.route !== undefined) values.route = patch.route;
  if (patch.severity !== undefined) values.severity = patch.severity;
  if (patch.enabled !== undefined) values.enabled = patch.enabled;
  const [row] = await db
    .update(alertRules)
    .set(values)
    .where(and(eq(alertRules.projectId, projectId), eq(alertRules.id, ruleId)))
    .returning();
  return row ? toDto(row) : null;
}

export async function deleteAlertRule(db: Db, projectId: string, ruleId: string): Promise<boolean> {
  const rows = await db
    .delete(alertRules)
    .where(and(eq(alertRules.projectId, projectId), eq(alertRules.id, ruleId)))
    .returning({ id: alertRules.id });
  return rows.length > 0;
}

/** Every enabled rule on a live project; the worker's evaluator iterates this each tick. */
export async function listEnabledRules(db: Db): Promise<AlertRuleDto[]> {
  const rows = await db
    .select({ rule: alertRules })
    .from(alertRules)
    .innerJoin(projects, eq(projects.id, alertRules.projectId))
    .where(and(eq(alertRules.enabled, true), sql`${projects.deletedAt} is null`));
  return rows.map((r) => toDto(r.rule));
}
