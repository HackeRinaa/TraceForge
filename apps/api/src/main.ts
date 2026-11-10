import { ConfigError, loadDotEnv } from '@traceforge/config';
import { withRetry } from '@traceforge/domain';
import { createLogger } from '@traceforge/logger';
import { SpanPublisher, createKafka } from '@traceforge/messaging';
import { createClickHouse, createPg } from '@traceforge/storage';
import { startTelemetry } from '@traceforge/telemetry';
import { loadApiConfig } from './config';
import { createMetrics } from './metrics';

async function main(): Promise<void> {
  loadDotEnv();
  const cfg = loadApiConfig();
  const logger = createLogger({
    name: 'traceforge-api',
    level: cfg.LOG_LEVEL,
    pretty: cfg.NODE_ENV === 'development',
  });

  // Telemetry must start before fastify is imported so its http instrumentation can patch Node's http module.
  const telemetry = startTelemetry({
    serviceName: 'traceforge-api',
    environment: cfg.NODE_ENV,
    endpoint: cfg.SELF_TELEMETRY_ENDPOINT,
    apiKey: cfg.SELF_TELEMETRY_API_KEY,
    ignoreIncomingPaths: ['/v1/traces', '/healthz', '/readyz', '/metrics'],
  });
  const { buildApp } = await import('./app');

  const pg = createPg(cfg.DATABASE_URL);
  const ch = createClickHouse(
    {
      url: cfg.CLICKHOUSE_URL,
      username: cfg.CLICKHOUSE_USER,
      password: cfg.CLICKHOUSE_PASSWORD,
      database: cfg.CLICKHOUSE_DATABASE,
    },
    { maxExecutionSeconds: cfg.QUERY_MAX_EXECUTION_SECONDS },
  );
  const kafka = createKafka({ brokers: cfg.KAFKA_BROKERS, clientId: 'traceforge-api', logger });
  const publisher = new SpanPublisher(kafka, logger);

  // Postgres is required to serve anything; wait for it briefly so `docker compose up` ordering is forgiving.
  await withRetry(() => pg.ping(), {
    maxAttempts: 10,
    baseMs: 500,
    maxMs: 5000,
    onRetry: (error, attempt) => logger.warn({ err: error, attempt }, 'waiting for postgres'),
  });
  await publisher.start();

  const app = await buildApp({ cfg, logger, pg, ch, kafka, publisher, metrics: createMetrics() });
  await app.listen({ host: cfg.API_HOST, port: cfg.API_PORT });
  logger.info({ port: cfg.API_PORT, telemetry: telemetry.enabled }, 'api listening');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 15_000);
    force.unref();
    try {
      await app.close(); // stop accepting, finish in-flight requests (including Kafka publishes)
      await publisher.stop();
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
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error('fatal startup error', error);
  }
  process.exit(1);
});
