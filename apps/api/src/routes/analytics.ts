import {
  analyticsQuerySchema,
  endpointDetailQuerySchema,
  endpointsQuerySchema,
  errorsQuerySchema,
  tracesQuerySchema,
  type EndpointDetailResponse,
  type EndpointsResponse,
  type ErrorDetailResponse,
  type ErrorsResponse,
  type OverviewResponse,
  type TraceDetail,
  type TracesResponse,
} from '@traceforge/contracts';
import { previousRange } from '@traceforge/domain';
import { analytics, listIncidents } from '@traceforge/storage';
import type { FastifyInstance } from 'fastify';
import { AppError, notFound, parse, queryOrFail } from '../errors';
import { projectContext } from '../services/access';
import { buildScope } from '../services/scope';
import type { Services } from '../services';

const FINGERPRINT_RE = /^[0-9a-f]{16}$/;
const TRACE_ID_PARAM_RE = /^[0-9a-f]{32}$/;

export function registerAnalyticsRoutes(app: FastifyInstance, s: Services): void {
  const { pg, ch } = s.deps;
  const base = '/v1/projects/:projectId';

  app.get(`${base}/overview`, async (req): Promise<OverviewResponse> => {
    const ctx = await projectContext(req, pg.db);
    const q = parse(analyticsQuerySchema, req.query);
    const { scope, range, rangeDto } = buildScope(ctx.project.id, q);
    const prev = previousRange(range);
    return queryOrFail(req, async () => {
      const [totals, previous, series, slow, failing, services, traces, incidents, ingestion] =
        await Promise.all([
          analytics.getTotals(ch, scope),
          analytics.getTotals(ch, { ...scope, ...prev }),
          analytics.getTimeseries(ch, scope, range.bucketSeconds),
          analytics.listEndpoints(ch, scope, { sort: 'p95', order: 'desc', limit: 5, offset: 0 }),
          analytics.listEndpoints(ch, scope, {
            sort: 'errorRate',
            order: 'desc',
            limit: 5,
            offset: 0,
          }),
          analytics.listServices(ch, scope),
          analytics.searchTraces(ch, scope, { limit: 8 }),
          listIncidents(pg.db, ctx.project.id, { statuses: ['firing', 'acknowledged'], limit: 5 }),
          analytics.getIngestionHealth(ch, ctx.project.id),
        ]);
      return {
        range: rangeDto,
        totals,
        previous,
        series,
        slowestEndpoints: slow.endpoints,
        errorEndpoints: failing.endpoints.filter((e) => e.errors > 0),
        services,
        recentTraces: traces.traces,
        activeIncidents: incidents,
        ingestion,
      };
    });
  });

  app.get(`${base}/dimensions`, async (req) => {
    const ctx = await projectContext(req, pg.db);
    const q = parse(analyticsQuerySchema, req.query);
    const { scope } = buildScope(ctx.project.id, q);
    return queryOrFail(req, () => analytics.listDimensions(ch, scope));
  });

  app.get(`${base}/ingestion-health`, async (req) => {
    const ctx = await projectContext(req, pg.db);
    return queryOrFail(req, () => analytics.getIngestionHealth(ch, ctx.project.id));
  });

  app.get(`${base}/endpoints`, async (req): Promise<EndpointsResponse> => {
    const ctx = await projectContext(req, pg.db);
    const q = parse(endpointsQuerySchema, req.query);
    const { scope, rangeDto } = buildScope(ctx.project.id, q);
    const result = await queryOrFail(req, () =>
      analytics.listEndpoints(ch, scope, {
        search: q.search,
        sort: q.sort,
        order: q.order,
        limit: q.limit,
        offset: q.offset,
      }),
    );
    return { range: rangeDto, ...result };
  });

  app.get(`${base}/endpoints/detail`, async (req): Promise<EndpointDetailResponse> => {
    const ctx = await projectContext(req, pg.db);
    const q = parse(endpointDetailQuerySchema, req.query);
    const { scope, range, rangeDto } = buildScope(ctx.project.id, q);
    const endpoint = { method: q.method.toUpperCase(), route: q.route };
    return queryOrFail(req, async () => {
      const traceFilter = { method: endpoint.method, route: endpoint.route };
      const [stat, series, slow, failed] = await Promise.all([
        analytics.getEndpointStat(ch, scope, { method: endpoint.method, route: endpoint.route }),
        analytics.getTimeseries(ch, scope, range.bucketSeconds, endpoint),
        analytics.searchTraces(ch, scope, { ...traceFilter, limit: 100 }),
        analytics.searchTraces(ch, scope, { ...traceFilter, status: 'error', limit: 10 }),
      ]);
      return {
        range: rangeDto,
        stat,
        series,
        slowTraces: [...slow.traces].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10),
        errorTraces: failed.traces,
      };
    });
  });

  app.get(`${base}/services`, async (req) => {
    const ctx = await projectContext(req, pg.db);
    const q = parse(analyticsQuerySchema, req.query);
    const { scope, rangeDto } = buildScope(ctx.project.id, q);
    const services = await queryOrFail(req, () => analytics.listServices(ch, scope));
    return { range: rangeDto, services };
  });

  // ---- Traces ----

  app.get(`${base}/traces`, async (req): Promise<TracesResponse> => {
    const ctx = await projectContext(req, pg.db);
    const q = parse(tracesQuerySchema, req.query);
    const { scope, rangeDto } = buildScope(ctx.project.id, q);
    const cursor = q.cursor ? analytics.decodeTraceCursor(q.cursor) : undefined;
    if (q.cursor && !cursor)
      throw new AppError(400, 'VALIDATION_ERROR', 'The pagination cursor is invalid');
    const result = await queryOrFail(req, () =>
      analytics.searchTraces(ch, scope, {
        status: q.status,
        minDurationMs: q.minDurationMs,
        maxDurationMs: q.maxDurationMs,
        method: q.method?.toUpperCase(),
        route: q.route,
        limit: q.limit,
        cursor: cursor ?? undefined,
      }),
    );
    return { range: rangeDto, ...result };
  });

  app.get(`${base}/traces/:traceId`, async (req): Promise<TraceDetail> => {
    const ctx = await projectContext(req, pg.db);
    const traceId = (req.params as { traceId: string }).traceId.toLowerCase();
    if (!TRACE_ID_PARAM_RE.test(traceId))
      throw new AppError(400, 'VALIDATION_ERROR', 'A trace id is 32 hex characters');
    const found = await queryOrFail(req, () =>
      analytics.getTraceSpans(ch, ctx.project.id, traceId),
    );
    if (!found) throw notFound('Trace');
    const end = Math.max(...found.spans.map((sp) => sp.offsetMs + sp.durationMs));
    return {
      traceId,
      startTime: new Date(found.startUs / 1000).toISOString(),
      durationMs: end,
      spans: found.spans,
    };
  });

  // ---- Errors ----

  app.get(`${base}/errors`, async (req): Promise<ErrorsResponse> => {
    const ctx = await projectContext(req, pg.db);
    const q = parse(errorsQuerySchema, req.query);
    const { scope, rangeDto } = buildScope(ctx.project.id, q);
    const result = await queryOrFail(req, () =>
      analytics.listErrorGroups(ch, scope, { sort: q.sort, limit: q.limit, offset: q.offset }),
    );
    return { range: rangeDto, ...result };
  });

  app.get(`${base}/errors/:fingerprint`, async (req): Promise<ErrorDetailResponse> => {
    const ctx = await projectContext(req, pg.db);
    const fingerprint = (req.params as { fingerprint: string }).fingerprint;
    if (!FINGERPRINT_RE.test(fingerprint))
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid error fingerprint');
    const q = parse(analyticsQuerySchema, req.query);
    const { scope, range, rangeDto } = buildScope(ctx.project.id, q);
    const detail = await queryOrFail(req, () =>
      analytics.getErrorDetail(ch, scope, fingerprint, range.bucketSeconds),
    );
    if (!detail.group) throw notFound('Error group');
    return { range: rangeDto, ...detail };
  });
}
