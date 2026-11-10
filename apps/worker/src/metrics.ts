import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export function createWorkerMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  return {
    registry,
    messagesProcessed: new Counter({
      name: 'traceforge_worker_messages_processed_total',
      help: 'Messages persisted to ClickHouse',
      registers: [registry],
    }),
    messagesDeadLettered: new Counter({
      name: 'traceforge_worker_messages_dead_lettered_total',
      help: 'Messages routed to the dead-letter topic',
      labelNames: ['reason'] as const,
      registers: [registry],
    }),
    retries: new Counter({
      name: 'traceforge_worker_retries_total',
      help: 'Retries of transient persistence failures',
      registers: [registry],
    }),
    batchFailures: new Counter({
      name: 'traceforge_worker_batch_failures_total',
      help: 'Batches that failed after exhausting in-process retries',
      registers: [registry],
    }),
    batchSize: new Histogram({
      name: 'traceforge_worker_batch_size_messages',
      help: 'Messages per processed chunk',
      buckets: [1, 5, 10, 50, 100, 250, 500, 1000, 5000],
      registers: [registry],
    }),
    insertDuration: new Histogram({
      name: 'traceforge_worker_clickhouse_insert_duration_seconds',
      help: 'ClickHouse batch insert latency',
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
    visibilityDelay: new Histogram({
      name: 'traceforge_worker_ingest_to_visible_seconds',
      help: 'Delay from API acceptance to the span being persisted and queryable',
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 300],
      registers: [registry],
    }),
    consumerLag: new Gauge({
      name: 'traceforge_worker_consumer_lag_messages',
      help: 'Committed-offset lag of the consumer group on the spans topic',
      registers: [registry],
    }),
    consecutiveFailures: new Gauge({
      name: 'traceforge_worker_consecutive_failures',
      help: 'Consecutive failed processing attempts (0 when healthy)',
      registers: [registry],
    }),
    alertEvaluations: new Counter({
      name: 'traceforge_alert_evaluations_total',
      help: 'Alert rule evaluations',
      labelNames: ['outcome'] as const,
      registers: [registry],
    }),
    incidentTransitions: new Counter({
      name: 'traceforge_incident_transitions_total',
      help: 'Incident lifecycle transitions made by the evaluator',
      labelNames: ['transition'] as const,
      registers: [registry],
    }),
  };
}

export type WorkerMetrics = ReturnType<typeof createWorkerMetrics>;
