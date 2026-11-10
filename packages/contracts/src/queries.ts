import { z } from 'zod';

export const RANGE_PRESETS = ['15m', '1h', '6h', '24h', '7d'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

/** Telemetry is deleted after this long (ClickHouse TTL), so wider queries are rejected. */
export const MAX_RANGE_DAYS = 14;

const isoDate = z.iso.datetime({ offset: true });

const timeRangeShape = {
  range: z.enum(RANGE_PRESETS).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
};

const filterShape = {
  environment: z.string().trim().min(1).max(100).optional(),
  service: z.string().trim().min(1).max(200).optional(),
};

function validateRange(v: { range?: unknown; from?: string; to?: string }, ctx: z.RefinementCtx) {
  if ((v.from === undefined) !== (v.to === undefined)) {
    ctx.addIssue({ code: 'custom', message: '`from` and `to` must be provided together' });
    return;
  }
  if (v.from !== undefined && v.to !== undefined) {
    const from = Date.parse(v.from);
    const to = Date.parse(v.to);
    if (!(from < to)) ctx.addIssue({ code: 'custom', message: '`from` must be before `to`' });
    if (to - from > MAX_RANGE_DAYS * 86_400_000) {
      ctx.addIssue({ code: 'custom', message: `range may not exceed ${MAX_RANGE_DAYS} days` });
    }
  }
}

export const analyticsQuerySchema = z
  .object({ ...timeRangeShape, ...filterShape })
  .superRefine(validateRange);

export const ENDPOINT_SORT_FIELDS = [
  'requests',
  'errors',
  'errorRate',
  'p50',
  'p95',
  'p99',
] as const;

export const endpointsQuerySchema = z
  .object({
    ...timeRangeShape,
    ...filterShape,
    search: z.string().trim().max(200).optional(),
    sort: z.enum(ENDPOINT_SORT_FIELDS).default('p95'),
    order: z.enum(['asc', 'desc']).default('desc'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .superRefine(validateRange);

export const endpointDetailQuerySchema = z
  .object({
    ...timeRangeShape,
    ...filterShape,
    method: z.string().trim().min(1).max(16),
    route: z.string().trim().min(1).max(500),
  })
  .superRefine(validateRange);

export const tracesQuerySchema = z
  .object({
    ...timeRangeShape,
    ...filterShape,
    status: z.enum(['ok', 'error']).optional(),
    minDurationMs: z.coerce.number().min(0).max(3_600_000).optional(),
    maxDurationMs: z.coerce.number().min(0).max(3_600_000).optional(),
    method: z.string().trim().min(1).max(16).optional(),
    route: z.string().trim().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(300).optional(),
  })
  .superRefine(validateRange);

export const errorsQuerySchema = z
  .object({
    ...timeRangeShape,
    ...filterShape,
    sort: z.enum(['count', 'lastSeen']).default('lastSeen'),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .superRefine(validateRange);

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
export type EndpointsQuery = z.infer<typeof endpointsQuerySchema>;
export type EndpointDetailQuery = z.infer<typeof endpointDetailQuerySchema>;
export type TracesQuery = z.infer<typeof tracesQuerySchema>;
export type ErrorsQuery = z.infer<typeof errorsQuerySchema>;

// ---- Alerts ----

export const ALERT_METRICS = [
  'error_rate',
  'p95_latency_ms',
  'p99_latency_ms',
  'request_rate',
] as const;
export type AlertMetric = (typeof ALERT_METRICS)[number];

export const alertRuleInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  metric: z.enum(ALERT_METRICS),
  operator: z.enum(['gt', 'lt']),
  /** error_rate is a percentage (0-100), latencies are milliseconds, request_rate is requests/minute. */
  threshold: z.number().finite().min(0).max(10_000_000),
  windowMinutes: z.number().int().min(1).max(60),
  minRequests: z.number().int().min(0).max(1_000_000).default(20),
  environment: z.string().trim().min(1).max(100).nullish(),
  service: z.string().trim().min(1).max(200).nullish(),
  method: z.string().trim().min(1).max(16).nullish(),
  route: z.string().trim().min(1).max(500).nullish(),
  severity: z.enum(['warning', 'critical']).default('warning'),
  enabled: z.boolean().default(true),
});

export const alertRuleUpdateSchema = alertRuleInputSchema.partial();

export type AlertRuleInput = z.infer<typeof alertRuleInputSchema>;

// ---- Auth, workspaces, projects ----

export const registerSchema = z.object({
  email: z.email().max(254),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(10).max(200),
});

export const loginSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(200),
});

export const createWorkspaceSchema = z.object({ name: z.string().trim().min(1).max(100) });
export const addMemberSchema = z.object({
  email: z.email().max(254),
  role: z.enum(['admin', 'member', 'viewer']).default('member'),
});

export const createProjectSchema = z.object({ name: z.string().trim().min(1).max(100) });
export const updateProjectSchema = z.object({ name: z.string().trim().min(1).max(100) });
export const deleteProjectSchema = z.object({ confirmName: z.string().min(1).max(100) });
export const createApiKeySchema = z.object({ name: z.string().trim().min(1).max(100) });

export const uuidParam = z.uuid();
