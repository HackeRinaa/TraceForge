import { createHash } from 'node:crypto';

/**
 * Replaces values that vary between occurrences of the same logical error (ids, numbers, quoted strings) with
 * placeholders so they group together.
 */
export function normalizeErrorText(text: string): string {
  return text
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/"[^"]{0,200}"|'[^']{0,200}'/g, '<str>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** Function name of the first stack frame, without file or line numbers (which change on every deploy). */
export function topFrameFunction(stack: string): string {
  const match = /^\s*at\s+(?:async\s+)?([^\s(]+)\s*\(/m.exec(stack);
  return match?.[1] ?? '';
}

export interface FingerprintInput {
  service: string;
  errorType: string;
  message: string;
  spanName: string;
  stack?: string;
}

/** Stable 16-hex-character identifier for a class of error within a project. */
export function errorFingerprint(input: FingerprintInput): string {
  const parts = [
    input.service,
    input.errorType,
    normalizeErrorText(input.message),
    normalizeErrorText(input.spanName),
    input.stack ? topFrameFunction(input.stack) : '',
  ];
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}
