import { ConfigError, loadDotEnv } from '@traceforge/config';
import { createLogger } from '@traceforge/logger';
import { createKafka, getConsumerLag } from '@traceforge/messaging';
import { TOPICS } from '@traceforge/contracts';
import { createClickHouse, createPg, insertDerivedRows } from '@traceforge/storage';
import { startTelemetry } from '@traceforge/telemetry';
import { isTransientClickHouseError } from './clickhouse-errors';
import { loadWorkerConfig } from './config';
import { SpanConsumer } from './consumer';
import { DeadLetterPublisher } from './dlq';
import { AlertEvaluator } from './evaluator';
import { startOpsServer } from './http';
import { createWorkerMetrics } from './metrics';
import type { PipelineDeps } from './pipeline';
import { PipelineState } from './state';

async function main(): Promise<void> {
  loadDotEnv();
  const cfg = loadWorkerConfig();
  const logger = createLogger({
    name: 'traceforge-worker',
    level: cfg.LOG_LEVEL,
    pretty: cfg.NODE_ENV === 'development',
  });
  const telemetry = startTelemetry({
    serviceName: 'traceforge-worker',
    environment: cfg.NODE_ENV,
    endpoint: cfg.SELF_TELEMETRY_ENDPOINT,
    apiKey: cfg.SELF_TELEMETRY_API_KEY,
  });

  const metrics = createWorkerMetrics();
  const state = new PipelineState();
  const pg = createPg(cfg.DATABASE_URL, { max: 5 });
  const ch = createClickHouse({
    url: cfg.CLICKHOUSE_URL,
    username: cfg.CLICKHOUSE_USER,
    password: cfg.CLICKHOUSE_PASSWORD,
    database: cfg.CLICKHOUSE_DATABASE,
  });
  const kafka = createKafka({ brokers: cfg.KAFKA_BROKERS, clientId: 'traceforge-worker', logger });
  const dlq = new DeadLetterPublisher(kafka, logger);

  const pipeline: PipelineDeps = {
    insert: (rows) => insertDerivedRows(ch, rows),
    deadLetter: (entries) => dlq.publish(entries),
    isTransient: isTransientClickHouseError,
    retry: {
      maxAttempts: cfg.WORKER_MAX_RETRIES,
      baseMs: cfg.WORKER_RETRY_BASE_MS,
      maxMs: cfg.WORKER_RETRY_MAX_MS,
    },
    consumerGroup: cfg.KAFKA_CONSUMER_GROUP,
    now: Date.now,
    hooks: {
      onBatch: (size) => metrics.batchSize.observe(size),
      onRetry: (error, attempt, delayMs) => {
        metrics.retries.inc();
        logger.warn({ err: error, attempt, delayMs }, 'transient persistence failure; retrying');
      },
      onInsert: (seconds) => metrics.insertDuration.observe(seconds),
      onPersisted: (events, persistedAt) => {
        metrics.messagesProcessed.inc(events.length);
        for (const e of events)
          metrics.visibilityDelay.observe(Math.max(0, persistedAt - e.receivedAt) / 1000);
      },
      onDeadLetter: (reason, count) => metrics.messagesDeadLettered.inc({ reason }, count),
    },
  };

  const consumer = new SpanConsumer(kafka, cfg, pipeline, state, metrics, logger);
  const evaluator = new AlertEvaluator(
    { pg, ch, logger, metrics },
    cfg.ALERT_EVALUATION_INTERVAL_MS,
  );
  const ops = startOpsServer(
    {
      state,
      registry: metrics.registry,
      ch,
      stallAfterMs: cfg.WORKER_STALL_AFTER_SECONDS * 1000,
      logger,
    },
    cfg.WORKER_HOST,
    cfg.WORKER_METRICS_PORT,
  );

  consumer.start();
  if (cfg.ALERT_EVALUATION_ENABLED) evaluator.start();

  // Consumer lag is sampled on a timer; a failure to read it is logged but never affects processing.
  const lagTimer = setInterval(() => {
    getConsumerLag(kafka, cfg.KAFKA_CONSUMER_GROUP, TOPICS.spans).then(
      (lag) => metrics.consumerLag.set(lag.totalLag),
      (error: unknown) => logger.debug({ err: error }, 'could not read consumer lag'),
    );
  }, 10_000);
  lagTimer.unref();

  logger.info(
    {
      port: cfg.WORKER_METRICS_PORT,
      group: cfg.KAFKA_CONSUMER_GROUP,
      telemetry: telemetry.enabled,
    },
    'worker started',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 20_000);
    force.unref();
    clearInterval(lagTimer);
    try {
      await consumer.stop(); // finishes and commits the in-flight chunk
      await evaluator.stop();
      await dlq.stop();
      ops.close();
      await ch.close();
      await pg.close();
      await telemetry.shutdown();
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
});
