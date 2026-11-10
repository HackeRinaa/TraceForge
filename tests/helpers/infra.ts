import { randomBytes } from 'node:crypto';
import { loadDotEnv } from '@traceforge/config';
import { createLogger } from '@traceforge/logger';
import { createKafka, deleteTopics, ensureTopics } from '@traceforge/messaging';
import {
  createClickHouse,
  createPg,
  ensureDatabase,
  runClickHouseMigrations,
  runPgMigrations,
  type ClickHouseClient,
  type PgHandle,
} from '@traceforge/storage';
import postgres from 'postgres';

loadDotEnv();

const rand = () => randomBytes(4).toString('hex');

export interface TestInfra {
  databaseUrl: string;
  clickhouse: { url: string; username: string; password: string; database: string };
  pg: PgHandle;
  ch: ClickHouseClient;
  brokers: string[];
  logger: ReturnType<typeof createLogger>;
  spansTopic: string;
  dlqTopic: string;
  kafka: ReturnType<typeof createKafka>;
  cleanup(): Promise<void>;
}

/**
 * Creates an isolated Postgres database, ClickHouse database and pair of Kafka topics on the docker-compose
 * infrastructure, so integration tests never touch development data and can run repeatedly.
 */
export async function createTestInfra(opts: { topics?: boolean } = {}): Promise<TestInfra> {
  const id = rand();
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl)
    throw new Error(
      'DATABASE_URL is not set (copy .env.example to .env and start `pnpm infra:up`)',
    );
  const dbName = `tf_it_${id}`;

  const admin = postgres(baseUrl, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const databaseUrl = baseUrl.replace(/\/[^/]+$/, `/${dbName}`);
  await runPgMigrations(databaseUrl);
  const pg = createPg(databaseUrl, { max: 5 });

  const clickhouse = {
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER ?? 'traceforge',
    password: process.env.CLICKHOUSE_PASSWORD ?? 'traceforge-dev',
    database: `tf_it_${id}`,
  };
  await ensureDatabase(clickhouse);
  const ch = createClickHouse(clickhouse);
  await runClickHouseMigrations(ch);

  const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');
  const logger = createLogger({ name: 'it', level: 'silent' });
  const kafka = createKafka({ brokers, clientId: `it-${id}`, logger });
  const spansTopic = `it.spans.${id}`;
  const dlqTopic = `it.dlq.${id}`;
  if (opts.topics) {
    await ensureTopics(kafka, [
      { topic: spansTopic, partitions: 3 },
      { topic: dlqTopic, partitions: 1 },
    ]);
  }

  return {
    databaseUrl,
    clickhouse,
    pg,
    ch,
    brokers,
    logger,
    spansTopic,
    dlqTopic,
    kafka,
    async cleanup() {
      await pg.close();
      await ch
        .command({ query: `DROP DATABASE IF EXISTS ${clickhouse.database}` })
        .catch(() => undefined);
      await ch.close();
      const a = postgres(baseUrl, { max: 1, onnotice: () => undefined });
      await a.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
      await a.end();
      if (opts.topics) await deleteTopics(kafka, [spansTopic, dlqTopic]).catch(() => undefined);
    },
  };
}
