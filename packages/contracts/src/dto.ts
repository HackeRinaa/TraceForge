import type { AlertMetric } from './queries';

// Response shapes shared by the API and the web app. Durations are milliseconds, timestamps ISO-8601 UTC.

export interface ResolvedRange {
  from: string;
  to: string;
  bucketSeconds: number;
}

export interface LatencyTotals {
  requests: number;
  errors: number;
  /** Percentage 0-100, null when there were no requests. */
  errorRate: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface TimeseriesPoint extends LatencyTotals {
  t: string;
}

export interface EndpointStat extends LatencyTotals {
  method: string;
  route: string;
  service: string;
}

export interface ServiceStat extends LatencyTotals {
  service: string;
}

export interface TraceSummary {
  traceId: string;
  startTime: string;
  durationMs: number;
  rootService: string | null;
  rootName: string | null;
  method: string | null;
  route: string | null;
  httpStatus: number | null;
  status: 'ok' | 'error';
  spanCount: number;
  errorCount: number;
  services: string[];
}

export interface SpanEventDto {
  name: string;
  offsetMs: number;
  attributes: Record<string, string>;
}

export interface SpanDto {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: number;
  service: string;
  startTime: string;
  /** Offset from the first span in the trace. */
  offsetMs: number;
  durationMs: number;
  status: 'unset' | 'ok' | 'error';
  statusMessage: string;
  httpMethod: string | null;
  httpStatus: number | null;
  route: string | null;
  attributes: Record<string, string>;
  resource: Record<string, string>;
  events: SpanEventDto[];
}

export interface TraceDetail {
  traceId: string;
  startTime: string;
  durationMs: number;
  spans: SpanDto[];
}

export interface IngestionHealth {
  status: 'healthy' | 'delayed' | 'idle';
  lastSpanAt: string | null;
  spansLastMinute: number;
  /** Mean delay from API acceptance to being queryable, over the last 5 minutes. */
  visibilityDelayMs: number | null;
}

export interface OverviewResponse {
  range: ResolvedRange;
  totals: LatencyTotals;
  /** Same-length window immediately before `range`, for deltas. */
  previous: LatencyTotals;
  series: TimeseriesPoint[];
  slowestEndpoints: EndpointStat[];
  errorEndpoints: EndpointStat[];
  services: ServiceStat[];
  recentTraces: TraceSummary[];
  activeIncidents: IncidentDto[];
  ingestion: IngestionHealth;
}

export interface EndpointsResponse {
  range: ResolvedRange;
  total: number;
  endpoints: EndpointStat[];
}

export interface EndpointDetailResponse {
  range: ResolvedRange;
  stat: EndpointStat | null;
  series: TimeseriesPoint[];
  slowTraces: TraceSummary[];
  errorTraces: TraceSummary[];
}

export interface TracesResponse {
  range: ResolvedRange;
  traces: TraceSummary[];
  nextCursor: string | null;
}

export interface ErrorGroup {
  fingerprint: string;
  errorType: string;
  message: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  services: string[];
  endpoints: Array<{ method: string; route: string }>;
  sampleTraceId: string;
  sampleSpanId: string;
}

export interface ErrorsResponse {
  range: ResolvedRange;
  total: number;
  groups: ErrorGroup[];
}

export interface ErrorDetailResponse {
  range: ResolvedRange;
  group: ErrorGroup | null;
  stack: string;
  series: Array<{ t: string; count: number }>;
  occurrences: Array<{
    traceId: string;
    spanId: string;
    time: string;
    service: string;
    spanName: string;
    environment: string;
  }>;
}

// ---- Alerts ----

export interface AlertRuleDto {
  id: string;
  projectId: string;
  name: string;
  metric: AlertMetric;
  operator: 'gt' | 'lt';
  threshold: number;
  windowMinutes: number;
  minRequests: number;
  environment: string | null;
  service: string | null;
  method: string | null;
  route: string | null;
  severity: 'warning' | 'critical';
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IncidentEvidence {
  metric: AlertMetric;
  operator: 'gt' | 'lt';
  threshold: number;
  observed: number;
  windowMinutes: number;
  requests: number;
  windowStart: string;
  windowEnd: string;
  sampleTraceIds: string[];
}

export type IncidentStatus = 'firing' | 'acknowledged' | 'resolved';

export interface IncidentEventDto {
  id: string;
  type: 'opened' | 'acknowledged' | 'resolved' | 'auto_resolved';
  at: string;
  actor: string | null;
  data: Record<string, unknown>;
}

export interface IncidentDto {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: 'warning' | 'critical';
  status: IncidentStatus;
  openedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolution: 'auto' | 'manual' | null;
  peakValue: number;
  lastValue: number;
  lastEvaluatedAt: string | null;
  evidence: IncidentEvidence;
  events?: IncidentEventDto[];
}

// ---- Auth and workspace ----

export interface UserDto {
  id: string;
  email: string;
  name: string;
}

export interface WorkspaceDto {
  id: string;
  name: string;
  slug: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
}

export interface ProjectDto {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  isDemo: boolean;
  createdAt: string;
}

export interface ApiKeyDto {
  id: string;
  name: string;
  /** Only the non-secret prefix is ever returned after creation. */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface CreatedApiKeyDto extends ApiKeyDto {
  /** Full secret, shown exactly once at creation or rotation. */
  secret: string;
}

export interface MeResponse {
  user: UserDto;
  workspaces: WorkspaceDto[];
}

// ---- Live updates (SSE) ----

export interface LiveSnapshot {
  at: string;
  requestsLastMinute: number;
  errorRateLastMinute: number | null;
  p95LastMinute: number | null;
  activeIncidents: number;
  ingestion: IngestionHealth;
}
