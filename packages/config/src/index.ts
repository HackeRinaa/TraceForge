import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/**
 * Development convenience: loads the nearest `.env` (searching upward from the working directory) without
 * overriding variables already set. Disabled in production, where configuration must come from the environment.
 */
export function loadDotEnv(...names: string[]): void {
  if (process.env.NODE_ENV === 'production') return;
  for (const name of names.length > 0 ? names : ['.env']) {
    let dir = process.cwd();
    for (let depth = 0; depth < 5; depth++) {
      const file = join(dir, name);
      if (existsSync(file)) {
        process.loadEnvFile(file);
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Parses and validates environment variables. Failure lists every problem (names and reasons only, never values,
 * so secrets cannot leak into logs) and the caller is expected to exit.
 */
export function loadConfig<S extends z.ZodType>(
  schema: S,
  env: NodeJS.ProcessEnv = process.env,
): z.infer<S> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}

const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);

export const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export const postgresSchema = z.object({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\/.+/, 'must be a postgres:// URL'),
});

export const kafkaSchema = z.object({
  KAFKA_BROKERS: z
    .string()
    .min(1, 'must list at least one host:port')
    .transform((s) =>
      s
        .split(',')
        .map((b) => b.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().regex(/^[^:\s]+:\d{2,5}$/, 'each broker must be host:port')).min(1)),
});

export const clickhouseSchema = z.object({
  CLICKHOUSE_URL: z.url(),
  CLICKHOUSE_USER: z.string().min(1),
  CLICKHOUSE_PASSWORD: z.string().min(1),
  CLICKHOUSE_DATABASE: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'must be a valid identifier'),
});

export const schemas = { int };

/** Passwords shipped in docker-compose.yml and .env.example. They must never be used in production. */
const DEV_SECRETS = ['traceforge-dev'];

/** Throws when a production deployment is still using development credentials. */
export function assertNoDevSecretsInProduction(
  nodeEnv: string,
  secrets: Record<string, string | undefined>,
): void {
  if (nodeEnv !== 'production') return;
  const offenders = Object.entries(secrets)
    .filter(([, value]) => value !== undefined && DEV_SECRETS.some((d) => value.includes(d)))
    .map(([name]) => name);
  if (offenders.length > 0) {
    throw new ConfigError(
      `Invalid configuration:\n  - ${offenders.join(', ')}: development credentials are not allowed when NODE_ENV=production`,
    );
  }
}

export type BaseConfig = z.infer<typeof baseSchema>;
