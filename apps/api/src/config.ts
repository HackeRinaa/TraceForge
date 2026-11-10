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

const origins = z
  .string()
  .default('http://localhost:3000')
  .transform((s) =>
    s
      .split(',')
      .map((o) => o.trim().replace(/\/$/, ''))
      .filter(Boolean),
  )
  .pipe(z.array(z.url()).min(1));

const schema = z.object({
  ...baseSchema.shape,
  ...postgresSchema.shape,
  ...kafkaSchema.shape,
  ...clickhouseSchema.shape,
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: schemas.int(4000, 1, 65535),
  WEB_ORIGINS: origins,
  SESSION_TTL_HOURS: schemas.int(168, 1, 24 * 90),
  ALLOW_REGISTRATION: z.stringbool().default(true),
  /** Trust X-Forwarded-For for client addresses (rate limiting). Enable only behind a trusted reverse proxy. */
  TRUST_PROXY: z.stringbool().default(false),
  INGEST_MAX_BODY_BYTES: schemas.int(4_194_304, 1024, 64 * 1024 * 1024),
  INGEST_MAX_SPANS_PER_REQUEST: schemas.int(5000, 1, 100_000),
  INGEST_RATE_LIMIT_SPANS_PER_SECOND: schemas.int(2000, 1, 10_000_000),
  INGEST_RATE_LIMIT_BURST_SPANS: schemas.int(10_000, 1, 100_000_000),
  INGEST_MAX_CONCURRENT_PUBLISHES: schemas.int(64, 1, 10_000),
  QUERY_MAX_EXECUTION_SECONDS: schemas.int(10, 1, 120),
  RETENTION_DAYS: schemas.int(14, 1, 365),
  KAFKA_CONSUMER_GROUP: z.string().default('traceforge-worker'),
  // Optional self-instrumentation: send this service's own traces to a TraceForge project.
  SELF_TELEMETRY_ENDPOINT: z.url().optional(),
  SELF_TELEMETRY_API_KEY: z.string().min(16).optional(),
});

export type ApiConfig = z.infer<typeof schema>;

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const cfg = loadConfig(schema, env);
  assertNoDevSecretsInProduction(cfg.NODE_ENV, {
    DATABASE_URL: cfg.DATABASE_URL,
    CLICKHOUSE_PASSWORD: cfg.CLICKHOUSE_PASSWORD,
  });
  return cfg;
}
