import { z } from 'zod';

/**
 * OTLP/HTTP JSON trace export request (opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest).
 * Deliberately tolerant: unknown fields are ignored so SDK upgrades do not break ingestion, but every field
 * TraceForge reads is typed. Protobuf encoding is NOT supported (see docs/event-contracts.md).
 */
export interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  bytesValue?: string;
  arrayValue?: { values?: OtlpAnyValue[] };
  kvlistValue?: { values?: OtlpKeyValue[] };
}

export interface OtlpKeyValue {
  key: string;
  value?: OtlpAnyValue;
}

const anyValue: z.ZodType<OtlpAnyValue> = z.lazy(() =>
  z.object({
    stringValue: z.string().optional(),
    intValue: z.union([z.string(), z.number()]).optional(),
    doubleValue: z.number().optional(),
    boolValue: z.boolean().optional(),
    bytesValue: z.string().optional(),
    arrayValue: z.object({ values: z.array(anyValue).optional() }).optional(),
    kvlistValue: z.object({ values: z.array(keyValue).optional() }).optional(),
  }),
);

const keyValue: z.ZodType<OtlpKeyValue> = z.lazy(() =>
  z.object({ key: z.string(), value: anyValue.optional() }),
);

const unixNano = z.union([z.string().regex(/^\d+$/), z.number().nonnegative()]);

const kindSchema = z.union([
  z.number().int().min(0).max(5),
  z.enum([
    'SPAN_KIND_UNSPECIFIED',
    'SPAN_KIND_INTERNAL',
    'SPAN_KIND_SERVER',
    'SPAN_KIND_CLIENT',
    'SPAN_KIND_PRODUCER',
    'SPAN_KIND_CONSUMER',
  ]),
]);

const statusSchema = z.object({
  code: z
    .union([
      z.number().int().min(0).max(2),
      z.enum(['STATUS_CODE_UNSET', 'STATUS_CODE_OK', 'STATUS_CODE_ERROR']),
    ])
    .optional(),
  message: z.string().optional(),
});

const otlpSpanSchema = z.object({
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  name: z.string(),
  kind: kindSchema.optional(),
  startTimeUnixNano: unixNano,
  endTimeUnixNano: unixNano,
  attributes: z.array(keyValue).optional(),
  events: z
    .array(
      z.object({
        timeUnixNano: unixNano.optional(),
        name: z.string(),
        attributes: z.array(keyValue).optional(),
      }),
    )
    .optional(),
  status: statusSchema.optional(),
});

export const otlpTraceRequestSchema = z.object({
  resourceSpans: z
    .array(
      z.object({
        resource: z.object({ attributes: z.array(keyValue).optional() }).optional(),
        scopeSpans: z.array(z.object({ spans: z.array(otlpSpanSchema).optional() })).optional(),
      }),
    )
    .optional(),
});

export type OtlpTraceRequest = z.infer<typeof otlpTraceRequestSchema>;
export type OtlpSpan = z.infer<typeof otlpSpanSchema>;
