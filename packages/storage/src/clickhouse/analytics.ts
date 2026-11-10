import type {
  EndpointStat,
  ErrorGroup,
  IngestionHealth,
  LatencyTotals,
  ServiceStat,
  SpanDto,
  TimeseriesPoint,
  TraceSummary,
} from '@traceforge/contracts';
import { fillBuckets, formatClickHouseTime } from '@traceforge/domain';
import type { ClickHouseClient } from './client';

/**
 * Read-side queries. Rules that apply to every query in this file:
 *  - User input only ever reaches ClickHouse as a bound `{name:Type}` parameter, never as SQL text.
 *    Sort columns come from fixed maps, never from the request.
 *  - `requests` and `errors` are read with FINAL so at-least-once redelivery never double counts.
 *    `spans` aggregates use uniqExact(span_id) instead, which is duplicate-safe without FINAL.
 *  - Every query is bounded by project, a time window and a LIMIT.
 */

export interface Scope {
  projectId: string;
  from: Date;
  to: Date;
  environment?: string | undefined;
  service?: string | undefined;
}

export interface EndpointRef {
  method?: string | undefined;
  route?: string | undefined;
}

type Params = Record<string, string | number | string[]>;

const chTime = (d: Date) => formatClickHouseTime(d.getTime() * 1000, 3);

function scopeClauses(scope: Scope, withService = true): { clauses: string[]; params: Params } {
  const clauses = [
    'project_id = {projectId:UUID}',
    "start_time >= {from:DateTime64(3, 'UTC')}",
    "start_time <= {to:DateTime64(3, 'UTC')}",
  ];
  const params: Params = {
    projectId: scope.projectId,
    from: chTime(scope.from),
    to: chTime(scope.to),
  };
  if (scope.environment) {
    clauses.push('environment = {environment:String}');
    params.environment = scope.environment;
  }
  if (withService && scope.service) {
    clauses.push('service = {service:String}');
    params.service = scope.service;
  }
  return { clauses, params };
}

function endpointClauses(ref: EndpointRef): { clauses: string[]; params: Params } {
  const clauses: string[] = [];
  const params: Params = {};
  if (ref.method) {
    clauses.push('method = {method:String}');
    params.method = ref.method;
  }
  if (ref.route) {
    clauses.push('route = {route:String}');
    params.route = ref.route;
  }
  return { clauses, params };
}

async function rows<T>(ch: ClickHouseClient, query: string, params: Params): Promise<T[]> {
  const rs = await ch.query({ query, query_params: params, format: 'JSONEachRow' });
  return rs.json<T>();
}

type Quantiles = Array<number | null>;

function totalsOf(requests: number, errors: number, q: Quantiles): LatencyTotals {
  return {
    requests,
    errors,
    errorRate: requests === 0 ? null : (errors / requests) * 100,
    p50: requests === 0 ? null : (q[0] ?? null),
    p95: requests === 0 ? null : (q[1] ?? null),
    p99: requests === 0 ? null : (q[2] ?? null),
  };
}

const Q = 'quantilesTDigest(0.5, 0.95, 0.99)(duration_ms)';

// ---------------------------------------------------------------------------------------------------------------
// Request-level analytics
// ---------------------------------------------------------------------------------------------------------------

export async function getTotals(
  ch: ClickHouseClient,
  scope: Scope,
  endpoint: EndpointRef = {},
): Promise<LatencyTotals> {
  const s = scopeClauses(scope);
  const e = endpointClauses(endpoint);
  const [row] = await rows<{ requests: number; errors: number; q: Quantiles }>(
    ch,
    `SELECT count() AS requests, sum(is_error) AS errors, ${Q} AS q
     FROM requests FINAL
     WHERE ${[...s.clauses, ...e.clauses].join(' AND ')}`,
    { ...s.params, ...e.params },
  );
  return totalsOf(row?.requests ?? 0, row?.errors ?? 0, row?.q ?? []);
}

export async function getTimeseries(
  ch: ClickHouseClient,
  scope: Scope,
  bucketSeconds: number,
  endpoint: EndpointRef = {},
): Promise<TimeseriesPoint[]> {
  const s = scopeClauses(scope);
  const e = endpointClauses(endpoint);
  const result = await rows<{ t: number; requests: number; errors: number; q: Quantiles }>(
    ch,
    `SELECT intDiv(toUnixTimestamp64Milli(start_time), {bucketMs:Int64}) * {bucketMs:Int64} AS t,
            count() AS requests, sum(is_error) AS errors, ${Q} AS q
     FROM requests FINAL
     WHERE ${[...s.clauses, ...e.clauses].join(' AND ')}
     GROUP BY t ORDER BY t`,
    { ...s.params, ...e.params, bucketMs: bucketSeconds * 1000 },
  );
  const byTime = new Map<number, TimeseriesPoint>(
    result.map((r) => [
      r.t,
      { t: new Date(r.t).toISOString(), ...totalsOf(r.requests, r.errors, r.q) },
    ]),
  );
  // Gaps are explicit: zero requests, and no latency (never an interpolated or zero latency).
  return fillBuckets(byTime, scope.from, scope.to, bucketSeconds, (t) => ({
    t: t.toISOString(),
    ...totalsOf(0, 0, []),
  }));
}

const ENDPOINT_SORT: Record<string, string> = {
  requests: 'requests',
  errors: 'errors',
  errorRate: 'errors / requests',
  p50: 'q[1]',
  p95: 'q[2]',
  p99: 'q[3]',
};

export interface EndpointListOptions {
  search?: string | undefined;
  sort: keyof typeof ENDPOINT_SORT;
  order: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export async function listEndpoints(
  ch: ClickHouseClient,
  scope: Scope,
  opts: EndpointListOptions,
): Promise<{ total: number; endpoints: EndpointStat[] }> {
  const s = scopeClauses(scope);
  if (opts.search)
    s.clauses.push("positionCaseInsensitive(concat(method, ' ', route), {search:String}) > 0");
  const params: Params = { ...s.params, ...(opts.search ? { search: opts.search } : {}) };
  const where = s.clauses.join(' AND ');
  const sortExpr = ENDPOINT_SORT[opts.sort] ?? 'q[2]';
  const direction = opts.order === 'asc' ? 'ASC' : 'DESC';

  const [list, totalRow] = await Promise.all([
    rows<{
      service: string;
      method: string;
      route: string;
      requests: number;
      errors: number;
      q: Quantiles;
    }>(
      ch,
      `SELECT service, method, route, count() AS requests, sum(is_error) AS errors, ${Q} AS q
       FROM requests FINAL WHERE ${where}
       GROUP BY service, method, route
       ORDER BY ${sortExpr} ${direction}, route ASC, method ASC
       LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
      { ...params, limit: opts.limit, offset: opts.offset },
    ),
    rows<{ n: number }>(
      ch,
      `SELECT count() AS n FROM (SELECT 1 FROM requests FINAL WHERE ${where} GROUP BY service, method, route)`,
      params,
    ),
  ]);
  return {
    total: totalRow[0]?.n ?? 0,
    endpoints: list.map((r) => ({
      service: r.service,
      method: r.method,
      route: r.route,
      ...totalsOf(r.requests, r.errors, r.q),
    })),
  };
}

export async function getEndpointStat(
  ch: ClickHouseClient,
  scope: Scope,
  endpoint: { method: string; route: string },
): Promise<EndpointStat | null> {
  const s = scopeClauses(scope);
  const e = endpointClauses(endpoint);
  const [row] = await rows<{ service: string; requests: number; errors: number; q: Quantiles }>(
    ch,
    `SELECT any(service) AS service, count() AS requests, sum(is_error) AS errors, ${Q} AS q
     FROM requests FINAL WHERE ${[...s.clauses, ...e.clauses].join(' AND ')}`,
    { ...s.params, ...e.params },
  );
  if (!row || row.requests === 0) return null;
  return { service: row.service, ...endpoint, ...totalsOf(row.requests, row.errors, row.q) };
}

export async function listServices(ch: ClickHouseClient, scope: Scope): Promise<ServiceStat[]> {
  const s = scopeClauses(scope);
  const result = await rows<{ service: string; requests: number; errors: number; q: Quantiles }>(
    ch,
    `SELECT service, count() AS requests, sum(is_error) AS errors, ${Q} AS q
     FROM requests FINAL WHERE ${s.clauses.join(' AND ')}
     GROUP BY service ORDER BY requests DESC LIMIT 100`,
    s.params,
  );
  return result.map((r) => ({ service: r.service, ...totalsOf(r.requests, r.errors, r.q) }));
}

export async function listDimensions(
  ch: ClickHouseClient,
  scope: Scope,
): Promise<{ environments: string[]; services: string[] }> {
  const s = scopeClauses({ ...scope, environment: undefined, service: undefined });
  const [row] = await rows<{ environments: string[]; services: string[] }>(
    ch,
    `SELECT groupUniqArray(100)(environment) AS environments, groupUniqArray(100)(service) AS services
     FROM requests WHERE ${s.clauses.join(' AND ')}`,
    s.params,
  );
  return { environments: (row?.environments ?? []).sort(), services: (row?.services ?? []).sort() };
}

/** Slowest or failing request trace ids in a window, used as alert evidence. */
export async function sampleTraceIds(
  ch: ClickHouseClient,
  scope: Scope,
  endpoint: EndpointRef,
  kind: 'slowest' | 'errors',
  limit = 3,
): Promise<string[]> {
  const s = scopeClauses(scope);
  const e = endpointClauses(endpoint);
  const clauses = [...s.clauses, ...e.clauses, ...(kind === 'errors' ? ['is_error = 1'] : [])];
  const result = await rows<{ trace_id: string }>(
    ch,
    `SELECT trace_id FROM requests FINAL WHERE ${clauses.join(' AND ')}
     ORDER BY duration_ms DESC LIMIT {limit:UInt32}`,
    { ...s.params, ...e.params, limit },
  );
  return result.map((r) => r.trace_id);
}

// ---------------------------------------------------------------------------------------------------------------
// Traces
// ---------------------------------------------------------------------------------------------------------------

export interface TraceSearchOptions {
  status?: 'ok' | 'error' | undefined;
  minDurationMs?: number | undefined;
  maxDurationMs?: number | undefined;
  method?: string | undefined;
  route?: string | undefined;
  limit: number;
  cursor?: { startUs: number; traceId: string } | undefined;
  /** Restrict to specific trace ids (used to hydrate known ids such as alert evidence). */
  traceIds?: string[] | undefined;
}

/** The "headline" of a trace is its root span, or the earliest span when the root was never received. */
const headline = (col: string) =>
  `if(countIf(is_root = 1) > 0, argMinIf(${col}, start_time, is_root = 1), argMin(${col}, start_time))`;

interface TraceRow {
  trace_id: string;
  start_us: number;
  end_us: number;
  span_count: number;
  error_count: number;
  services: string[];
  root_service: string;
  root_name: string;
  head_method: string;
  head_route: string;
  head_status: number;
}

export function encodeTraceCursor(c: { startUs: number; traceId: string }): string {
  return Buffer.from(JSON.stringify({ s: c.startUs, t: c.traceId })).toString('base64url');
}

export function decodeTraceCursor(raw: string): { startUs: number; traceId: string } | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof v !== 'object' || v === null) return null;
    const { s, t } = v as { s?: unknown; t?: unknown };
    if (
      typeof s !== 'number' ||
      !Number.isSafeInteger(s) ||
      typeof t !== 'string' ||
      !/^[0-9a-f]{32}$/.test(t)
    ) {
      return null;
    }
    return { startUs: s, traceId: t };
  } catch {
    return null;
  }
}

export async function searchTraces(
  ch: ClickHouseClient,
  scope: Scope,
  opts: TraceSearchOptions,
): Promise<{ traces: TraceSummary[]; nextCursor: string | null }> {
  // `service` is applied to the trace's service set (HAVING), not to individual spans.
  const s = scopeClauses(scope, false);
  const params: Params = { ...s.params, limit: opts.limit + 1 };
  const having: string[] = [];
  if (scope.service) {
    having.push('has(services, {service:String})');
    params.service = scope.service;
  }
  if (opts.status === 'error') having.push('error_count > 0');
  if (opts.status === 'ok') having.push('error_count = 0');
  if (opts.minDurationMs !== undefined) {
    having.push('(end_us - start_us) / 1000 >= {minDur:Float64}');
    params.minDur = opts.minDurationMs;
  }
  if (opts.maxDurationMs !== undefined) {
    having.push('(end_us - start_us) / 1000 <= {maxDur:Float64}');
    params.maxDur = opts.maxDurationMs;
  }
  if (opts.method) {
    having.push('head_method = {method:String}');
    params.method = opts.method;
  }
  if (opts.route) {
    having.push('head_route = {route:String}');
    params.route = opts.route;
  }
  if (opts.cursor) {
    having.push(
      '(start_us < {cursorStart:Int64} OR (start_us = {cursorStart:Int64} AND trace_id < {cursorTrace:String}))',
    );
    params.cursorStart = opts.cursor.startUs;
    params.cursorTrace = opts.cursor.traceId;
  }
  if (opts.traceIds) {
    s.clauses.push('trace_id IN {traceIds:Array(String)}');
    params.traceIds = opts.traceIds;
  }

  const result = await rows<TraceRow>(
    ch,
    `SELECT trace_id,
            min(toUnixTimestamp64Micro(start_time)) AS start_us,
            max(toUnixTimestamp64Micro(start_time) + toInt64(duration_us)) AS end_us,
            uniqExact(span_id) AS span_count,
            uniqExactIf(span_id, status_code = 2) AS error_count,
            groupUniqArray(20)(service) AS services,
            ${headline('service')} AS root_service,
            ${headline('name')} AS root_name,
            ${headline('http_method')} AS head_method,
            ${headline('route')} AS head_route,
            ${headline('http_status_code')} AS head_status
     FROM spans
     WHERE ${s.clauses.join(' AND ')}
     GROUP BY trace_id
     ${having.length ? `HAVING ${having.join(' AND ')}` : ''}
     ORDER BY start_us DESC, trace_id DESC
     LIMIT {limit:UInt32}`,
    params,
  );

  const page = result.slice(0, opts.limit);
  const last = page[page.length - 1];
  const nextCursor =
    result.length > opts.limit && last
      ? encodeTraceCursor({ startUs: last.start_us, traceId: last.trace_id })
      : null;
  return {
    traces: page.map((r) => ({
      traceId: r.trace_id,
      startTime: new Date(r.start_us / 1000).toISOString(),
      durationMs: (r.end_us - r.start_us) / 1000,
      rootService: r.root_service || null,
      rootName: r.root_name || null,
      method: r.head_method || null,
      route: r.head_route || null,
      httpStatus: r.head_status || null,
      status: r.error_count > 0 ? 'error' : 'ok',
      spanCount: r.span_count,
      errorCount: r.error_count,
      services: r.services,
    })),
    nextCursor,
  };
}

interface SpanRowOut {
  span_id: string;
  parent_span_id: string;
  name: string;
  kind: number;
  service: string;
  start_us: number;
  duration_us: number;
  status_code: number;
  status_message: string;
  http_method: string;
  http_status_code: number;
  route: string;
  attributes: Record<string, string>;
  resource: Record<string, string>;
  events: string;
}

const MAX_SPANS_PER_TRACE = 5000;

export async function getTraceSpans(
  ch: ClickHouseClient,
  projectId: string,
  traceId: string,
): Promise<{ startUs: number; spans: SpanDto[] } | null> {
  const result = await rows<SpanRowOut>(
    ch,
    `SELECT span_id, parent_span_id, name, kind, service,
            toUnixTimestamp64Micro(start_time) AS start_us, duration_us, status_code, status_message,
            http_method, http_status_code, route, attributes, resource, events
     FROM spans FINAL
     WHERE project_id = {projectId:UUID} AND trace_id = {traceId:String}
     ORDER BY start_time, span_id
     LIMIT {limit:UInt32}`,
    { projectId, traceId, limit: MAX_SPANS_PER_TRACE },
  );
  const first = result[0];
  if (!first) return null;
  const originUs = Math.min(...result.map((r) => r.start_us));
  const spans = result.map((r): SpanDto => {
    let events: SpanDto['events'] = [];
    try {
      const parsed = JSON.parse(r.events) as Array<{
        name: string;
        offsetUs: number;
        attributes: Record<string, string>;
      }>;
      events = parsed.map((e) => ({
        name: e.name,
        offsetMs: (r.start_us - originUs + e.offsetUs) / 1000,
        attributes: e.attributes,
      }));
    } catch {
      events = [];
    }
    return {
      spanId: r.span_id,
      parentSpanId: r.parent_span_id || null,
      name: r.name,
      kind: r.kind,
      service: r.service,
      startTime: new Date(r.start_us / 1000).toISOString(),
      offsetMs: (r.start_us - originUs) / 1000,
      durationMs: r.duration_us / 1000,
      status: r.status_code === 2 ? 'error' : r.status_code === 1 ? 'ok' : 'unset',
      statusMessage: r.status_message,
      httpMethod: r.http_method || null,
      httpStatus: r.http_status_code || null,
      route: r.route || null,
      attributes: r.attributes,
      resource: r.resource,
      events,
    };
  });
  return { startUs: originUs, spans };
}

// ---------------------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------------------

interface ErrorGroupRow {
  fingerprint: string;
  error_type: string;
  message: string;
  count: number;
  first_us: number;
  last_us: number;
  services: string[];
  sample_trace: string;
  sample_span: string;
}

const ERROR_GROUP_SELECT = `
  fingerprint,
  argMax(error_type, start_time) AS error_type,
  argMax(error_message, start_time) AS message,
  uniqExact(trace_id, span_id) AS count,
  min(toUnixTimestamp64Micro(start_time)) AS first_us,
  max(toUnixTimestamp64Micro(start_time)) AS last_us,
  groupUniqArray(10)(service) AS services,
  argMax(trace_id, start_time) AS sample_trace,
  argMax(span_id, start_time) AS sample_span`;

function toErrorGroup(r: ErrorGroupRow, endpoints: ErrorGroup['endpoints']): ErrorGroup {
  return {
    fingerprint: r.fingerprint,
    errorType: r.error_type,
    message: r.message,
    count: r.count,
    firstSeen: new Date(r.first_us / 1000).toISOString(),
    lastSeen: new Date(r.last_us / 1000).toISOString(),
    services: r.services,
    endpoints,
    sampleTraceId: r.sample_trace,
    sampleSpanId: r.sample_span,
  };
}

/** HTTP endpoints (from request rows) that shared a trace with each error group's occurrences. */
async function endpointsFor(
  ch: ClickHouseClient,
  scope: Scope,
  fingerprints: string[],
): Promise<Map<string, ErrorGroup['endpoints']>> {
  const out = new Map<string, ErrorGroup['endpoints']>();
  if (fingerprints.length === 0) return out;
  const s = scopeClauses({ ...scope, service: undefined });
  const result = await rows<{ fingerprint: string; endpoints: Array<[string, string]> }>(
    ch,
    `SELECT e.fingerprint AS fingerprint, groupUniqArray(10)((r.method, r.route)) AS endpoints
     FROM (SELECT fingerprint, trace_id FROM errors FINAL
           WHERE ${s.clauses.join(' AND ')} AND fingerprint IN {fingerprints:Array(String)}) AS e
     INNER JOIN (SELECT trace_id, method, route FROM requests
                 WHERE ${s.clauses.join(' AND ')}) AS r ON e.trace_id = r.trace_id
     GROUP BY fingerprint`,
    { ...s.params, fingerprints },
  );
  for (const r of result)
    out.set(
      r.fingerprint,
      r.endpoints.map(([method, route]) => ({ method, route })),
    );
  return out;
}

export async function listErrorGroups(
  ch: ClickHouseClient,
  scope: Scope,
  opts: { sort: 'count' | 'lastSeen'; limit: number; offset: number },
): Promise<{ total: number; groups: ErrorGroup[] }> {
  const s = scopeClauses(scope);
  const where = s.clauses.join(' AND ');
  const order = opts.sort === 'count' ? 'count DESC, last_us DESC' : 'last_us DESC, count DESC';
  const [list, totalRow] = await Promise.all([
    rows<ErrorGroupRow>(
      ch,
      `SELECT ${ERROR_GROUP_SELECT} FROM errors FINAL WHERE ${where}
       GROUP BY fingerprint ORDER BY ${order} LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
      { ...s.params, limit: opts.limit, offset: opts.offset },
    ),
    rows<{ n: number }>(
      ch,
      `SELECT uniqExact(fingerprint) AS n FROM errors WHERE ${where}`,
      s.params,
    ),
  ]);
  const endpoints = await endpointsFor(
    ch,
    scope,
    list.map((g) => g.fingerprint),
  );
  return {
    total: totalRow[0]?.n ?? 0,
    groups: list.map((g) => toErrorGroup(g, endpoints.get(g.fingerprint) ?? [])),
  };
}

export interface ErrorDetail {
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

export async function getErrorDetail(
  ch: ClickHouseClient,
  scope: Scope,
  fingerprint: string,
  bucketSeconds: number,
): Promise<ErrorDetail> {
  const s = scopeClauses(scope);
  const where = [...s.clauses, 'fingerprint = {fingerprint:String}'].join(' AND ');
  const params: Params = { ...s.params, fingerprint };
  const [groupRows, seriesRows, occurrenceRows, stackRows] = await Promise.all([
    rows<ErrorGroupRow>(
      ch,
      `SELECT ${ERROR_GROUP_SELECT} FROM errors FINAL WHERE ${where} GROUP BY fingerprint`,
      params,
    ),
    rows<{ t: number; count: number }>(
      ch,
      `SELECT intDiv(toUnixTimestamp64Milli(start_time), {bucketMs:Int64}) * {bucketMs:Int64} AS t,
              uniqExact(trace_id, span_id) AS count
       FROM errors WHERE ${where} GROUP BY t ORDER BY t`,
      { ...params, bucketMs: bucketSeconds * 1000 },
    ),
    rows<{
      trace_id: string;
      span_id: string;
      time_us: number;
      service: string;
      span_name: string;
      environment: string;
    }>(
      ch,
      `SELECT trace_id, span_id, toUnixTimestamp64Micro(start_time) AS time_us, service, span_name, environment
       FROM errors FINAL WHERE ${where} ORDER BY start_time DESC LIMIT 25`,
      params,
    ),
    rows<{ stack: string }>(
      ch,
      `SELECT stack FROM errors FINAL WHERE ${where} AND stack != '' ORDER BY start_time DESC LIMIT 1`,
      params,
    ),
  ]);
  const g = groupRows[0];
  const endpoints = await endpointsFor(ch, scope, g ? [g.fingerprint] : []);
  const seriesMap = new Map(
    seriesRows.map((r) => [r.t, { t: new Date(r.t).toISOString(), count: r.count }]),
  );
  return {
    group: g ? toErrorGroup(g, endpoints.get(g.fingerprint) ?? []) : null,
    stack: stackRows[0]?.stack ?? '',
    series: fillBuckets(seriesMap, scope.from, scope.to, bucketSeconds, (t) => ({
      t: t.toISOString(),
      count: 0,
    })),
    occurrences: occurrenceRows.map((o) => ({
      traceId: o.trace_id,
      spanId: o.span_id,
      time: new Date(o.time_us / 1000).toISOString(),
      service: o.service,
      spanName: o.span_name,
      environment: o.environment,
    })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Pipeline health
// ---------------------------------------------------------------------------------------------------------------

const STALE_AFTER_MS = 5 * 60_000;
const DELAYED_AFTER_MS = 15_000;

export async function getIngestionHealth(
  ch: ClickHouseClient,
  projectId: string,
): Promise<IngestionHealth> {
  const [row] = await rows<{
    last_ms: number | null;
    recent: number;
    delay_ms: number | null;
    has_any: number;
  }>(
    ch,
    `SELECT toUnixTimestamp64Milli(max(ingested_at)) AS last_ms,
            countIf(ingested_at >= now64(3) - toIntervalSecond(60)) AS recent,
            avgIf(toUnixTimestamp64Milli(ingested_at) - toUnixTimestamp64Milli(received_at),
                  ingested_at >= now64(3) - toIntervalSecond(300)) AS delay_ms,
            count() AS has_any
     FROM spans
     WHERE project_id = {projectId:UUID} AND start_time >= now64(3) - toIntervalHour(24)`,
    { projectId },
  );
  const lastMs = row && row.has_any > 0 ? row.last_ms : null;
  const delay = row?.delay_ms ?? null;
  let status: IngestionHealth['status'] = 'healthy';
  if (lastMs === null || Date.now() - lastMs > STALE_AFTER_MS) status = 'idle';
  else if (delay !== null && delay > DELAYED_AFTER_MS) status = 'delayed';
  return {
    status,
    lastSpanAt: lastMs === null ? null : new Date(lastMs).toISOString(),
    spansLastMinute: row?.recent ?? 0,
    visibilityDelayMs: delay === null ? null : Math.max(0, delay),
  };
}
