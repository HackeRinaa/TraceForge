import { createClient, type ClickHouseClient } from '@clickhouse/client';

export type { ClickHouseClient };

export interface ClickHouseConfig {
  url: string;
  username: string;
  password: string;
  database: string;
}

export interface ClickHouseClientOptions {
  /** Hard server-side limit for read queries, so a runaway dashboard query cannot starve ingestion. */
  maxExecutionSeconds?: number;
  requestTimeoutMs?: number;
}

export function createClickHouse(
  cfg: ClickHouseConfig,
  { maxExecutionSeconds = 10, requestTimeoutMs = 30_000 }: ClickHouseClientOptions = {},
): ClickHouseClient {
  return createClient({
    url: cfg.url,
    username: cfg.username,
    password: cfg.password,
    database: cfg.database,
    request_timeout: requestTimeoutMs,
    application: 'traceforge',
    clickhouse_settings: {
      // Return 64-bit integers as JSON numbers and NaN as null; values here stay far below 2^53.
      output_format_json_quote_64bit_integers: 0,
      output_format_json_quote_denormals: 0,
      max_execution_time: maxExecutionSeconds,
      session_timezone: 'UTC',
    },
  });
}

/** True when ClickHouse aborted a query for exceeding max_execution_time (error code 159). */
export function isClickHouseTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { code?: unknown; message?: unknown };
  return (
    String(e.code) === '159' ||
    (typeof e.message === 'string' && /timeout|timed out|TIMEOUT_EXCEEDED/i.test(e.message))
  );
}
