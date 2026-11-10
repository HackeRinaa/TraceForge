import { z } from 'zod';

/** Kafka topic names. Versioned in the name so incompatible changes get a new topic. */
export const TOPICS = {
  spans: 'telemetry.spans.v1',
  dlq: 'telemetry.dlq.v1',
} as const;

export const TRACE_ID_RE = /^(?!0{32})[0-9a-f]{32}$/;
export const SPAN_ID_RE = /^(?!0{16})[0-9a-f]{16}$/;

export const SPAN_KIND = {
  unspecified: 0,
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
} as const;

export const STATUS_CODE = { unset: 0, ok: 1, error: 2 } as const;

const stringMap = z.record(z.string().max(200), z.string().max(2048));

export const spanEventV1Schema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.uuid(),
  /** Epoch milliseconds at which the ingestion API accepted the span. */
  receivedAt: z.number().int().nonnegative(),
  traceId: z.string().regex(TRACE_ID_RE),
  spanId: z.string().regex(SPAN_ID_RE),
  parentSpanId: z.string().regex(SPAN_ID_RE).nullable(),
  name: z.string().min(1).max(512),
  kind: z.number().int().min(0).max(5),
  serviceName: z.string().min(1).max(200),
  environment: z.string().min(1).max(100),
  /** Epoch microseconds; fits in a double until the year ~2255. */
  startTimeUs: z.number().int().nonnegative(),
  durationUs: z.number().int().nonnegative(),
  status: z.object({
    code: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    message: z.string().max(1024).optional(),
  }),
  /** Already redacted and size-capped by the ingestion API. */
  attributes: stringMap,
  resource: stringMap,
  events: z
    .array(
      z.object({
        name: z.string().max(256),
        timeUs: z.number().int().nonnegative(),
        attributes: stringMap,
      }),
    )
    .max(64),
});

export type SpanEventV1 = z.infer<typeof spanEventV1Schema>;

/** Envelope written to the dead-letter topic when a message cannot be processed. */
export interface DeadLetterV1 {
  schemaVersion: 1;
  sourceTopic: string;
  sourcePartition: number;
  sourceOffset: string;
  key: string | null;
  /** Original payload, truncated to keep the DLQ message bounded. */
  payload: string;
  payloadTruncated: boolean;
  reason: 'invalid_schema' | 'invalid_json' | 'processing_failed';
  error: string;
  attempts: number;
  failedAt: string;
  consumerGroup: string;
}
