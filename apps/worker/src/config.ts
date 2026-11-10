import {
  assertNoDevSecretsInProduction,
  baseSchema,
  clickhouseSchema,
  kafkaSchema,
  loadConfig,
  postgresSchema,
  schemas,
} from '@traceforge/config';
import { z } from 'zod';

const schema = z.object({
  ...baseSchema.shape,
  ...postgresSchema.shape,
  ...kafkaSchema.shape,
  ...clickhouseSchema.shape,
  KAFKA_CONSUMER_GROUP: z.string().default('traceforge-worker'),
  WORKER_BATCH_MAX_MESSAGES: schemas.int(500, 1, 10_000),
  /** Upper bound on how long the broker holds a fetch open waiting for more data. */
  WORKER_BATCH_MAX_WAIT_MS: schemas.int(1000, 10, 30_000),
  WORKER_MAX_RETRIES: schemas.int(5, 1, 50),
  WORKER_RETRY_BASE_MS: schemas.int(250, 10, 60_000),
  WORKER_RETRY_MAX_MS: schemas.int(10_000, 100, 300_000),
  /** Partitions processed in parallel by this worker instance. */
  WORKER_CONSUMER_CONCURRENCY: schemas.int(1, 1, 32),
  WORKER_METRICS_PORT: schemas.int(4001, 1, 65535),
  WORKER_HOST: z.string().default('0.0.0.0'),
  /** A pipeline failing continuously for this long is reported as stalled (readiness fails). */
  WORKER_STALL_AFTER_SECONDS: schemas.int(300, 10, 86_400),
  ALERT_EVALUATION_INTERVAL_MS: schemas.int(15_000, 1000, 3_600_000),
  ALERT_EVALUATION_ENABLED: z.stringbool().default(true),
  SELF_TELEMETRY_ENDPOINT: z.url().optional(),
  SELF_TELEMETRY_API_KEY: z.string().min(16).optional(),
});

export type WorkerConfig = z.infer<typeof schema>;

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const cfg = loadConfig(schema, env);
  assertNoDevSecretsInProduction(cfg.NODE_ENV, {
    DATABASE_URL: cfg.DATABASE_URL,
    CLICKHOUSE_PASSWORD: cfg.CLICKHOUSE_PASSWORD,
  });
  return cfg;
}
