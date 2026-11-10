import { createRequire } from 'node:module';
import { pino, type Logger } from 'pino';

export type { Logger };

/** Paths whose values are replaced with "[redacted]" wherever they appear in a log record. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'authorization',
  'cookie',
  '*.password',
  '*.passwordHash',
  '*.apiKey',
  '*.api_key',
  '*.secret',
  '*.token',
  '*.keyHash',
];

export interface LoggerOptions {
  name: string;
  level?: string;
  /** Human-readable output for local development. Requires pino-pretty (a dev dependency). */
  pretty?: boolean;
}

/** pino-pretty is a development dependency; production installs do not have it and must still start. */
function prettyAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

export function createLogger({ name, level = 'info', pretty = false }: LoggerOptions): Logger {
  const usePretty = pretty && prettyAvailable();
  return pino({
    name,
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { service: name },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(usePretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss.l',
              ignore: 'pid,hostname,service',
            },
          },
        }
      : {}),
  });
}
