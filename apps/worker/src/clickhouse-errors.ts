/**
 * ClickHouse server error codes meaning "these rows are malformed for this table". Retrying can never succeed, so the
 * pipeline isolates the offending message. Every other failure (connection refused, timeout, TOO_MANY_PARTS, memory
 * limits, unknown table during a rollout) is treated as transient infrastructure trouble.
 */
const DATA_ERROR_CODES = new Set([
  '6', // CANNOT_PARSE_TEXT
  '26', // CANNOT_PARSE_QUOTED_STRING
  '27', // CANNOT_PARSE_INPUT_ASSERTION_FAILED
  '38', // CANNOT_PARSE_DATE
  '41', // CANNOT_PARSE_DATETIME
  '53', // TYPE_MISMATCH
  '70', // CANNOT_CONVERT_TYPE
  '117', // INCORRECT_DATA
  '131', // TOO_LARGE_STRING_SIZE
  '321', // VALUE_IS_OUT_OF_RANGE_OF_DATA_TYPE
]);

export function isTransientClickHouseError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'code' in error && 'type' in error) {
    return !DATA_ERROR_CODES.has(String((error as { code: unknown }).code));
  }
  return true;
}
