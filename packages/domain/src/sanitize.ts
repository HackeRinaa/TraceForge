export const MAX_ATTRIBUTES = 64;
export const MAX_ATTRIBUTE_VALUE_LENGTH = 1024;
export const MAX_ATTRIBUTE_KEY_LENGTH = 200;

/**
 * Attribute keys whose values are credentials or personal data. Matching is on dot/underscore/dash separated tokens,
 * so `http.request.header.authorization` and `db.password` are dropped while `gen_ai.usage.input_tokens` is kept.
 */
const SENSITIVE_KEY_RE =
  /(^|[._-])(authorization|cookie|set-cookie|password|passwd|secret|token|api[-_]?key|apikey|credentials?|private[-_]?key|session[-_.]?id|email|ssn)([._-]|$)/i;

const URL_KEYS = new Set(['url.full', 'http.url', 'http.target', 'url.original']);
const QUERY_TEXT_KEYS = new Set(['db.statement', 'db.query.text']);
const DROPPED_KEYS = new Set(['url.query']);

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

/** Query strings routinely carry tokens and identifiers, so only the path is retained. */
export function stripUrlQuery(value: string): string {
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

/** Replaces string and numeric literals in a SQL-ish statement so parameters never reach storage. */
export function maskQueryLiterals(statement: string): string {
  return statement
    .replace(/'(?:[^'\\]|\\.|'')*'/g, '?')
    .replace(/"(?:[^"\\]|\\.)*"/g, '?')
    .replace(/\b\d+(?:\.\d+)?\b/g, '?');
}

export interface SanitizedAttributes {
  attributes: Record<string, string>;
  /** Number of attributes removed or rewritten for privacy or size reasons. */
  redacted: number;
}

/** Applies the default privacy policy (docs/security.md) and size caps to flattened span attributes. */
export function sanitizeAttributes(
  input: Readonly<Record<string, string>>,
  maxAttributes: number = MAX_ATTRIBUTES,
): SanitizedAttributes {
  const attributes: Record<string, string> = {};
  let redacted = 0;
  let kept = 0;
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.slice(0, MAX_ATTRIBUTE_KEY_LENGTH);
    if (isSensitiveKey(key) || DROPPED_KEYS.has(key)) {
      redacted++;
      continue;
    }
    if (kept >= maxAttributes) {
      redacted++;
      continue;
    }
    let value = rawValue;
    if (URL_KEYS.has(key)) {
      const stripped = stripUrlQuery(value);
      if (stripped !== value) redacted++;
      value = stripped;
    } else if (QUERY_TEXT_KEYS.has(key)) {
      value = maskQueryLiterals(value);
      redacted++;
    }
    if (value.length > MAX_ATTRIBUTE_VALUE_LENGTH) {
      value = value.slice(0, MAX_ATTRIBUTE_VALUE_LENGTH);
      redacted++;
    }
    attributes[key] = value;
    kept++;
  }
  return { attributes, redacted };
}
