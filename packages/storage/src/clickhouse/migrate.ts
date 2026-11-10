import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createClient } from '@clickhouse/client';
import type { ClickHouseClient, ClickHouseConfig } from './client';

export const DEFAULT_MIGRATIONS_DIR = resolve(
  process.cwd(),
  'infrastructure/clickhouse/migrations',
);

/** Creates the database if it does not exist, using a connection that does not require it. */
export async function ensureDatabase(cfg: ClickHouseConfig): Promise<void> {
  const admin = createClient({ url: cfg.url, username: cfg.username, password: cfg.password });
  try {
    // The identifier is validated by config (letters, digits, underscore) and cannot be bound as a parameter.
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(cfg.database))
      throw new Error('invalid ClickHouse database name');
    await admin.command({ query: `CREATE DATABASE IF NOT EXISTS ${cfg.database}` });
  } finally {
    await admin.close();
  }
}

/**
 * Applies `*.sql` files in lexical order, one statement per file, recording each in `schema_migrations`.
 * ClickHouse DDL is not transactional, so every migration must be written with IF NOT EXISTS to be re-runnable.
 */
export async function runClickHouseMigrations(
  ch: ClickHouseClient,
  dir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<string[]> {
  await ch.command({
    query: `CREATE TABLE IF NOT EXISTS schema_migrations
            (version String, applied_at DateTime DEFAULT now()) ENGINE = MergeTree ORDER BY version`,
  });
  const appliedRs = await ch.query({
    query: 'SELECT version FROM schema_migrations',
    format: 'JSONEachRow',
  });
  const applied = new Set((await appliedRs.json<{ version: string }>()).map((r) => r.version));

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const statement = (await readFile(join(dir, file), 'utf8')).trim();
    await ch.command({ query: statement });
    await ch.insert({
      table: 'schema_migrations',
      values: [{ version: file }],
      format: 'JSONEachRow',
    });
    ran.push(file);
  }
  return ran;
}
