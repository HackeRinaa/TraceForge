import type {
  OtlpAnyValue,
  OtlpKeyValue,
  OtlpSpan,
  OtlpTraceRequest,
  SpanEventV1,
} from '@traceforge/contracts';
import { SPAN_ID_RE, TRACE_ID_RE } from '@traceforge/contracts';
import { sanitizeAttributes } from './sanitize';

export interface ConvertContext {
  projectId: string;
  /** Epoch ms at which the API accepted the request. */
  receivedAt: number;
  /** Spans older than this are rejected: they would be deleted by the retention TTL immediately. */
  maxAgeMs: number;
  /** Tolerated clock skew for spans stamped in the future. */
  maxFutureMs: number;
}

export interface ConvertResult {
  events: SpanEventV1[];
  rejected: number;
  /** First few distinct rejection reasons, for the OTLP partialSuccess message. */
  rejectionReasons: string[];
  redactedAttributes: number;
}

const KIND_BY_NAME: Record<string, number> = {
  SPAN_KIND_UNSPECIFIED: 0,
  SPAN_KIND_INTERNAL: 1,
  SPAN_KIND_SERVER: 2,
  SPAN_KIND_CLIENT: 3,
  SPAN_KIND_PRODUCER: 4,
  SPAN_KIND_CONSUMER: 5,
};

const STATUS_BY_NAME: Record<string, 0 | 1 | 2> = {
  STATUS_CODE_UNSET: 0,
  STATUS_CODE_OK: 1,
  STATUS_CODE_ERROR: 2,
};

const MAX_DURATION_US = 24 * 60 * 60 * 1_000_000;
const MAX_SPAN_EVENTS = 64;
const MAX_RESOURCE_ATTRIBUTES = 32;

function anyValueToString(v: OtlpAnyValue | undefined): string | null {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return String(v.intValue);
  if (v.doubleValue !== undefined) return String(v.doubleValue);
  if (v.boolValue !== undefined) return String(v.boolValue);
  if (v.arrayValue || v.kvlistValue) return JSON.stringify(v);
  return null;
}

function flatten(kvs: readonly OtlpKeyValue[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of kvs ?? []) {
    const value = anyValueToString(kv.value);
    if (value !== null) out[kv.key] = value;
  }
  return out;
}

/** Nanosecond timestamps exceed 2^53, so strings are parsed as BigInt before dividing down to microseconds. */
function nanoToMicros(n: string | number): number {
  return typeof n === 'number' ? Math.floor(n / 1000) : Number(BigInt(n) / 1000n);
}

function normalizeKind(kind: OtlpSpan['kind']): number {
  if (kind === undefined) return 0;
  return typeof kind === 'number' ? kind : (KIND_BY_NAME[kind] ?? 0);
}

function normalizeStatus(status: OtlpSpan['status']): 0 | 1 | 2 {
  const code = status?.code;
  if (code === undefined) return 0;
  if (typeof code === 'number') return code as 0 | 1 | 2;
  return STATUS_BY_NAME[code] ?? 0;
}

/**
 * Translates an OTLP/HTTP JSON export into versioned span events, applying the privacy policy and size caps.
 * Invalid spans are counted and skipped rather than failing the whole request, matching OTLP partial-success semantics.
 */
export function convertOtlpTrace(req: OtlpTraceRequest, ctx: ConvertContext): ConvertResult {
  const events: SpanEventV1[] = [];
  const reasons = new Set<string>();
  let rejected = 0;
  let redactedAttributes = 0;
  const reject = (reason: string) => {
    rejected++;
    if (reasons.size < 5) reasons.add(reason);
  };

  for (const rs of req.resourceSpans ?? []) {
    const resourceRaw = flatten(rs.resource?.attributes);
    const serviceName = (resourceRaw['service.name'] ?? '').trim() || 'unknown_service';
    const environment =
      (
        resourceRaw['deployment.environment.name'] ??
        resourceRaw['deployment.environment'] ??
        ''
      ).trim() || 'default';
    const resource = sanitizeAttributes(resourceRaw, MAX_RESOURCE_ATTRIBUTES);
    redactedAttributes += resource.redacted;

    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const traceId = span.traceId.toLowerCase();
        const spanId = span.spanId.toLowerCase();
        if (!TRACE_ID_RE.test(traceId) || !SPAN_ID_RE.test(spanId)) {
          reject('invalid trace or span id (expected lowercase hex)');
          continue;
        }
        const parent = span.parentSpanId?.toLowerCase() ?? '';
        const parentSpanId = parent === '' || /^0+$/.test(parent) ? null : parent;
        if (parentSpanId !== null && !SPAN_ID_RE.test(parentSpanId)) {
          reject('invalid parent span id');
          continue;
        }

        const startTimeUs = nanoToMicros(span.startTimeUnixNano);
        const durationUs = nanoToMicros(span.endTimeUnixNano) - startTimeUs;
        if (durationUs < 0 || durationUs > MAX_DURATION_US) {
          reject('end time before start time or duration over 24h');
          continue;
        }
        const startMs = startTimeUs / 1000;
        if (startMs < ctx.receivedAt - ctx.maxAgeMs) {
          reject('span older than the retention window');
          continue;
        }
        if (startMs > ctx.receivedAt + ctx.maxFutureMs) {
          reject('span start time is in the future');
          continue;
        }

        const attrs = sanitizeAttributes(flatten(span.attributes));
        redactedAttributes += attrs.redacted;
        const spanEvents = (span.events ?? []).slice(0, MAX_SPAN_EVENTS).map((e) => {
          const ea = sanitizeAttributes(flatten(e.attributes), 16);
          redactedAttributes += ea.redacted;
          return {
            name: e.name.slice(0, 256),
            timeUs: e.timeUnixNano === undefined ? startTimeUs : nanoToMicros(e.timeUnixNano),
            attributes: ea.attributes,
          };
        });

        const statusMessage = span.status?.message?.slice(0, 1024);
        events.push({
          schemaVersion: 1,
          projectId: ctx.projectId,
          receivedAt: ctx.receivedAt,
          traceId,
          spanId,
          parentSpanId,
          name: span.name.trim().slice(0, 512) || '(unnamed)',
          kind: normalizeKind(span.kind),
          serviceName: serviceName.slice(0, 200),
          environment: environment.slice(0, 100),
          startTimeUs,
          durationUs,
          status: {
            code: normalizeStatus(span.status),
            ...(statusMessage ? { message: statusMessage } : {}),
          },
          attributes: attrs.attributes,
          resource: resource.attributes,
          events: spanEvents,
        });
      }
    }
  }
  return { events, rejected, rejectionReasons: [...reasons], redactedAttributes };
}

/** Counts spans without converting them; used to enforce per-request limits before doing any work. */
export function countSpans(req: OtlpTraceRequest): number {
  let n = 0;
  for (const rs of req.resourceSpans ?? [])
    for (const ss of rs.scopeSpans ?? []) n += ss.spans?.length ?? 0;
  return n;
}
