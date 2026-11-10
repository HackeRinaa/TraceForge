import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** Prometheus-format metrics for the API. One registry per app instance keeps tests isolated. */
export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  return {
    registry,
    httpRequests: new Counter({
      name: 'traceforge_api_http_requests_total',
      help: 'HTTP requests handled',
      labelNames: ['method', 'route', 'status'] as const,
      registers: [registry],
    }),
    httpDuration: new Histogram({
      name: 'traceforge_api_http_request_duration_seconds',
      help: 'HTTP request latency',
      labelNames: ['method', 'route'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
    spansAccepted: new Counter({
      name: 'traceforge_ingest_spans_accepted_total',
      help: 'Spans durably accepted (published to Kafka)',
      registers: [registry],
    }),
    spansRejected: new Counter({
      name: 'traceforge_ingest_spans_rejected_total',
      help: 'Spans rejected as invalid',
      labelNames: ['reason'] as const,
      registers: [registry],
    }),
    ingestRequests: new Counter({
      name: 'traceforge_ingest_requests_total',
      help: 'Ingestion requests by outcome',
      labelNames: ['outcome'] as const,
      registers: [registry],
    }),
    publishDuration: new Histogram({
      name: 'traceforge_ingest_kafka_publish_duration_seconds',
      help: 'Time to publish an ingestion batch to Kafka (acks=all)',
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    }),
    publishFailures: new Counter({
      name: 'traceforge_ingest_kafka_publish_failures_total',
      help: 'Failed Kafka publishes',
      registers: [registry],
    }),
    inflightPublishes: new Gauge({
      name: 'traceforge_ingest_inflight_publishes',
      help: 'Ingestion requests currently publishing to Kafka',
      registers: [registry],
    }),
    sseConnections: new Gauge({
      name: 'traceforge_sse_connections',
      help: 'Open live-update connections',
      registers: [registry],
    }),
    authFailures: new Counter({
      name: 'traceforge_auth_failures_total',
      help: 'Failed authentication attempts',
      labelNames: ['kind'] as const,
      registers: [registry],
    }),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
