import type { SpanEventV1 } from '@traceforge/contracts';
import { SPAN_KIND, STATUS_CODE } from '@traceforge/contracts';
import { errorFingerprint } from './fingerprint';
import { routeFromAttributes } from './route';

// Row shapes mirror infrastructure/clickhouse/migrations. Keep the two in sync.

export interface SpanRow {
  project_id: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string;
  name: string;
  kind: number;
  service: string;
  environment: string;
  start_time: string;
  duration_us: number;
  status_code: number;
  status_message: string;
  http_method: string;
  http_status_code: number;
  route: string;
  is_root: number;
  is_entry: number;
  error_fingerprint: string;
  attributes: Record<string, string>;
  resource: Record<string, string>;
  events: string;
  received_at: string;
  ingested_at: string;
}

export interface RequestRow {
  project_id: string;
  environment: string;
  service: string;
  method: string;
  route: string;
  start_time: string;
  trace_id: string;
  span_id: string;
  duration_ms: number;
  status_code: number;
  is_error: number;
  received_at: string;
  ingested_at: string;
}

export interface ErrorRow {
  project_id: string;
  fingerprint: string;
  start_time: string;
  trace_id: string;
  span_id: string;
  environment: string;
  service: string;
  span_name: string;
  method: string;
  route: string;
  http_status_code: number;
  error_type: string;
  error_message: string;
  stack: string;
  ingested_at: string;
}

export interface DerivedRows {
  span: SpanRow;
  request: RequestRow | null;
  error: ErrorRow | null;
}

/** Formats epoch microseconds as a ClickHouse DateTime64 literal with the given fractional digits (3 or 6). */
export function formatClickHouseTime(epochUs: number, fractionDigits: 3 | 6): string {
  const iso = new Date(Math.floor(epochUs / 1000)).toISOString();
  const micros = String(Math.floor(epochUs % 1_000_000)).padStart(6, '0');
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}.${micros.slice(0, fractionDigits)}`;
}

const MAX_MESSAGE = 1024;
const MAX_STACK = 4096;

function parseHttpStatus(attrs: Readonly<Record<string, string>>): number {
  const raw = attrs['http.response.status_code'] ?? attrs['http.status_code'];
  const n = raw === undefined ? 0 : Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 100 && n <= 599 ? n : 0;
}

/**
 * Derives the storage rows for one span: the span itself, a request row for HTTP entry spans, and an error row
 * for errored spans. Pure and deterministic apart from `ingestedAtMs`, so re-processing yields identical keys.
 */
export function deriveRows(event: SpanEventV1, ingestedAtMs: number): DerivedRows {
  const attrs = event.attributes;
  const method = (attrs['http.request.method'] ?? attrs['http.method'] ?? '')
    .toUpperCase()
    .slice(0, 16);
  const httpStatus = parseHttpStatus(attrs);
  const route = method === '' && !attrs['http.route'] ? '' : routeFromAttributes(attrs);
  const isEntry = event.kind === SPAN_KIND.server && method !== '';

  // OTel semantic conventions require server spans with 5xx to be errors; enforce it for SDKs that forget.
  const isError = event.status.code === STATUS_CODE.error || (isEntry && httpStatus >= 500);
  const statusCode = isError ? STATUS_CODE.error : event.status.code;

  const startTime = formatClickHouseTime(event.startTimeUs, 6);
  const receivedAt = formatClickHouseTime(event.receivedAt * 1000, 3);
  const ingestedAt = formatClickHouseTime(ingestedAtMs * 1000, 3);

  let errorRow: ErrorRow | null = null;
  let fingerprint = '';
  if (isError) {
    const exception = event.events.find((e) => e.name === 'exception');
    const errorType =
      exception?.attributes['exception.type'] ??
      attrs['error.type'] ??
      (httpStatus >= 500 ? `HTTP ${httpStatus}` : 'Error');
    const message = (
      exception?.attributes['exception.message'] ??
      event.status.message ??
      (httpStatus >= 500 ? `HTTP ${httpStatus} response` : event.name)
    ).slice(0, MAX_MESSAGE);
    const stack = (exception?.attributes['exception.stacktrace'] ?? '').slice(0, MAX_STACK);
    fingerprint = errorFingerprint({
      service: event.serviceName,
      errorType,
      message,
      spanName: event.name,
      stack,
    });
    errorRow = {
      project_id: event.projectId,
      fingerprint,
      start_time: startTime,
      trace_id: event.traceId,
      span_id: event.spanId,
      environment: event.environment,
      service: event.serviceName,
      span_name: event.name,
      method,
      route,
      http_status_code: httpStatus,
      error_type: errorType.slice(0, 200),
      error_message: message,
      stack,
      ingested_at: ingestedAt,
    };
  }

  const span: SpanRow = {
    project_id: event.projectId,
    trace_id: event.traceId,
    span_id: event.spanId,
    parent_span_id: event.parentSpanId ?? '',
    name: event.name,
    kind: event.kind,
    service: event.serviceName,
    environment: event.environment,
    start_time: startTime,
    duration_us: event.durationUs,
    status_code: statusCode,
    status_message: event.status.message ?? '',
    http_method: method,
    http_status_code: httpStatus,
    route,
    is_root: event.parentSpanId === null ? 1 : 0,
    is_entry: isEntry ? 1 : 0,
    error_fingerprint: fingerprint,
    attributes: attrs,
    resource: event.resource,
    events: JSON.stringify(
      event.events.map((e) => ({
        name: e.name,
        offsetUs: e.timeUs - event.startTimeUs,
        attributes: e.attributes,
      })),
    ),
    received_at: receivedAt,
    ingested_at: ingestedAt,
  };

  const request: RequestRow | null = isEntry
    ? {
        project_id: event.projectId,
        environment: event.environment,
        service: event.serviceName,
        method,
        route: route || '/',
        start_time: startTime,
        trace_id: event.traceId,
        span_id: event.spanId,
        duration_ms: event.durationUs / 1000,
        status_code: httpStatus,
        is_error: isError ? 1 : 0,
        received_at: receivedAt,
        ingested_at: ingestedAt,
      }
    : null;

  return { span, request, error: errorRow };
}
