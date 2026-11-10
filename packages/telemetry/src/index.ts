import { context, trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace';

export {
  trace,
  SpanStatusCode,
  context,
  propagation,
  SpanKind,
  type Span,
} from '@opentelemetry/api';

export interface TelemetryOptions {
  serviceName: string;
  serviceVersion?: string;
  environment: string;
  /** Full OTLP/HTTP traces URL, e.g. http://localhost:4000/v1/traces. When absent, telemetry is disabled. */
  endpoint?: string | undefined;
  apiKey?: string | undefined;
  /** Incoming request paths that must never be traced (health checks, the ingest endpoint itself). */
  ignoreIncomingPaths?: string[];
  /** Record every span at 1.0 by default; lower in high-volume services. */
  sampleRatio?: number;
  /** Extra resource attributes, e.g. a flag marking simulated demo telemetry. */
  resourceAttributes?: Record<string, string | boolean>;
}

export interface TelemetryHandle {
  enabled: boolean;
  shutdown(): Promise<void>;
}

/**
 * Starts OpenTelemetry tracing with an OTLP/HTTP JSON exporter pointed at a TraceForge ingestion endpoint.
 *
 * Telemetry recursion is prevented in three layers: the SDK exports inside a suppressed-tracing context, incoming
 * requests to ignored paths (notably `/v1/traces`) are never traced, and outgoing requests to the export endpoint
 * itself are ignored.
 *
 * Must run before the instrumented modules (fastify) are first imported.
 */
export function startTelemetry(opts: TelemetryOptions): TelemetryHandle {
  if (!opts.endpoint) return { enabled: false, shutdown: () => Promise.resolve() };

  const exportUrl = new URL(opts.endpoint);
  const ignored = new Set(opts.ignoreIncomingPaths ?? []);

  const exporter = new OTLPTraceExporter({
    url: opts.endpoint,
    headers: opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {},
    timeoutMillis: 10_000,
  });

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': opts.serviceName,
      'service.version': opts.serviceVersion ?? '0.1.0',
      'deployment.environment': opts.environment,
      ...opts.resourceAttributes,
    }),
    spanProcessors: [
      new BatchSpanProcessor({
        exporter,
        maxQueueSize: 4096,
        maxExportBatchSize: 512,
        scheduledDelayMillis: 2000,
        exportTimeoutMillis: 10_000,
      }),
    ],
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(opts.sampleRatio ?? 1) }),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => ignored.has((req.url ?? '').split('?')[0] ?? ''),
        ignoreOutgoingRequestHook: (req) =>
          req.hostname === exportUrl.hostname &&
          Number(req.port ?? 80) === Number(exportUrl.port || 80) &&
          (req.path ?? '').startsWith(exportUrl.pathname),
      }),
      new UndiciInstrumentation(),
    ],
  });
  sdk.start();

  return {
    enabled: true,
    shutdown: () => sdk.shutdown().catch(() => undefined),
  };
}

/** Runs `fn` without creating or propagating spans, e.g. for a traffic generator that should not root traces. */
export function untraced<T>(fn: () => T): T {
  return context.with(suppressTracing(context.active()), fn);
}

/** Runs `fn` inside a new active span, recording exceptions and setting error status on failure. */
export async function withSpan<T>(
  tracerName: string,
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return trace.getTracer(tracerName).startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : 'error',
      });
      throw error;
    } finally {
      span.end();
    }
  });
}
