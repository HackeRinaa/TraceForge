import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Applies version-controlled SQL migrations. Safe to run repeatedly; drizzle tracks applied ones. */
export async function runPgMigrations(url: string): Promise<void> {
  // A dedicated single connection: migrations must not interleave with application traffic.
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
