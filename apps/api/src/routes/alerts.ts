import { alertRuleInputSchema, alertRuleUpdateSchema, uuidParam } from '@traceforge/contracts';
import {
  acknowledgeIncident,
  createAlertRule,
  deleteAlertRule,
  getAlertRule,
  getIncident,
  listAlertRules,
  listIncidents,
  resolveIncidentManually,
  updateAlertRule,
} from '@traceforge/storage';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, notFound, parse } from '../errors';
import { projectContext } from '../services/access';
import type { Services } from '../services';

const incidentsQuery = z.object({
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',') : undefined))
    .pipe(z.array(z.enum(['firing', 'acknowledged', 'resolved'])).optional()),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function registerAlertRoutes(app: FastifyInstance, s: Services): void {
  const db = s.deps.pg.db;
  const base = '/v1/projects/:projectId';
  const idParam = (req: { params: unknown }, name: string): string =>
    parse(uuidParam, (req.params as Record<string, string>)[name], 'Id');

  app.get(`${base}/alert-rules`, async (req) => {
    const ctx = await projectContext(req, db);
    return { rules: await listAlertRules(db, ctx.project.id) };
  });

  app.post(`${base}/alert-rules`, async (req, reply) => {
    const ctx = await projectContext(req, db, 'member');
    const input = parse(alertRuleInputSchema, req.body);
    if (input.metric === 'error_rate' && input.threshold > 100) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'An error-rate threshold is a percentage between 0 and 100',
      );
    }
    return reply.status(201).send(await createAlertRule(db, ctx.project.id, ctx.user.id, input));
  });

  app.patch(`${base}/alert-rules/:ruleId`, async (req) => {
    const ctx = await projectContext(req, db, 'member');
    const patch = parse(alertRuleUpdateSchema, req.body);
    const updated = await updateAlertRule(db, ctx.project.id, idParam(req, 'ruleId'), patch);
    if (!updated) throw notFound('Alert rule');
    if (updated.metric === 'error_rate' && updated.threshold > 100) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'An error-rate threshold is a percentage between 0 and 100',
      );
    }
    return updated;
  });

  app.delete(`${base}/alert-rules/:ruleId`, async (req, reply) => {
    const ctx = await projectContext(req, db, 'member');
    if (!(await deleteAlertRule(db, ctx.project.id, idParam(req, 'ruleId'))))
      throw notFound('Alert rule');
    return reply.status(204).send();
  });

  app.get(`${base}/alert-rules/:ruleId`, async (req) => {
    const ctx = await projectContext(req, db);
    const rule = await getAlertRule(db, ctx.project.id, idParam(req, 'ruleId'));
    if (!rule) throw notFound('Alert rule');
    return rule;
  });

  app.get(`${base}/incidents`, async (req) => {
    const ctx = await projectContext(req, db);
    const q = parse(incidentsQuery, req.query);
    const statuses = q.status;
    return {
      incidents: await listIncidents(db, ctx.project.id, {
        ...(statuses ? { statuses } : {}),
        limit: q.limit,
      }),
    };
  });

  app.get(`${base}/incidents/:incidentId`, async (req) => {
    const ctx = await projectContext(req, db);
    const incident = await getIncident(db, ctx.project.id, idParam(req, 'incidentId'));
    if (!incident) throw notFound('Incident');
    return incident;
  });

  app.post(`${base}/incidents/:incidentId/acknowledge`, async (req) => {
    const ctx = await projectContext(req, db, 'member');
    const id = idParam(req, 'incidentId');
    if (!(await acknowledgeIncident(db, ctx.project.id, id, ctx.user.id))) {
      throw new AppError(409, 'CONFLICT', 'Only a firing incident can be acknowledged');
    }
    return getIncident(db, ctx.project.id, id);
  });

  app.post(`${base}/incidents/:incidentId/resolve`, async (req) => {
    const ctx = await projectContext(req, db, 'member');
    const id = idParam(req, 'incidentId');
    if (!(await resolveIncidentManually(db, ctx.project.id, id, ctx.user.id))) {
      throw new AppError(409, 'CONFLICT', 'The incident is already resolved or does not exist');
    }
    return getIncident(db, ctx.project.id, id);
  });
}
