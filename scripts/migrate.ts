/**
 * Applies Postgres (Drizzle) and ClickHouse migrations. Safe to re-run.
 * Usage: pnpm db:migrate   (reads DATABASE_URL and CLICKHOUSE_* from the environment or .env)
 */
import {
  loadConfig,
  loadDotEnv,
  baseSchema,
  clickhouseSchema,
  postgresSchema,
} from '@traceforge/config';
import {
  createClickHouse,
  ensureDatabase,
  runClickHouseMigrations,
  runPgMigrations,
} from '@traceforge/storage';
import { z } from 'zod';

loadDotEnv();
const cfg = loadConfig(
  z.object({ ...baseSchema.shape, ...postgresSchema.shape, ...clickhouseSchema.shape }),
);
const chCfg = {
  url: cfg.CLICKHOUSE_URL,
  username: cfg.CLICKHOUSE_USER,
  password: cfg.CLICKHOUSE_PASSWORD,
  database: cfg.CLICKHOUSE_DATABASE,
};

console.log('PostgreSQL: applying migrations…');
await runPgMigrations(cfg.DATABASE_URL);
console.log('PostgreSQL: up to date');

console.log(`ClickHouse: ensuring database "${chCfg.database}" and applying migrations…`);
await ensureDatabase(chCfg);
const ch = createClickHouse(chCfg);
try {
  const ran = await runClickHouseMigrations(ch);
  console.log(ran.length ? `ClickHouse: applied ${ran.join(', ')}` : 'ClickHouse: up to date');
} finally {
  await ch.close();
}
