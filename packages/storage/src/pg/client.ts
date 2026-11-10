import type { PgDatabase } from 'drizzle-orm/pg-core';
import { drizzle, type PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

/** Satisfied by both the pooled database and an open transaction, so repositories work in either. */
export type Db = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;

export interface PgHandle {
  db: Db;
  /** Cheap connectivity probe for readiness checks. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createPg(url: string, opts: { max?: number } = {}): PgHandle {
  const sql = postgres(url, {
    max: opts.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 10,
    // Surface server notices through our logger instead of stdout.
    onnotice: () => undefined,
  });
  const db = drizzle(sql, { schema });
  return {
    db,
    async ping() {
      await sql`select 1`;
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}
