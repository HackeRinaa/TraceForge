const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_RE = /^\d+$/;
const LONG_HEX_RE = /^[0-9a-f]{12,}$/i;
/** Opaque tokens: long, with at least one digit and one letter. */
const OPAQUE_RE = /^(?=.*\d)(?=.*[a-z])[a-z0-9_-]{20,}$/i;

export const MAX_ROUTE_LENGTH = 200;
export const MAX_ROUTE_SEGMENTS = 8;

/**
 * Collapses a request path into a bounded-cardinality route template. Route templates supplied by instrumentation
 * (`/api/orders/:id`) pass through unchanged; raw paths have identifiers replaced so each distinct entity does not
 * become its own endpoint in aggregates.
 */
export function normalizeRoute(input: string): string {
  const withoutQuery = input.split(/[?#]/, 1)[0] ?? '';
  const segments = withoutQuery
    .split('/')
    .filter((s) => s.length > 0)
    .map((segment) => {
      if (UUID_RE.test(segment) || NUMERIC_RE.test(segment) || LONG_HEX_RE.test(segment))
        return ':id';
      if (OPAQUE_RE.test(segment)) return ':token';
      return segment;
    });
  const kept = segments.slice(0, MAX_ROUTE_SEGMENTS);
  if (segments.length > MAX_ROUTE_SEGMENTS) kept.push('*');
  const route = '/' + kept.join('/');
  return route.length > MAX_ROUTE_LENGTH ? route.slice(0, MAX_ROUTE_LENGTH) : route;
}

function pathOfUrl(raw: string): string | null {
  try {
    return new URL(raw, 'http://placeholder.invalid').pathname;
  } catch {
    return null;
  }
}

/** Picks the best route source from span attributes and normalizes it. Returns '' when no HTTP path is known. */
export function routeFromAttributes(attrs: Readonly<Record<string, string>>): string {
  const templated = attrs['http.route'];
  if (templated) return normalizeRoute(templated);
  const raw = attrs['url.path'] ?? attrs['http.target'] ?? attrs['url.full'] ?? attrs['http.url'];
  if (!raw) return '';
  const path = pathOfUrl(raw);
  return path ? normalizeRoute(path) : '';
}
