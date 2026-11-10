import type { ApiErrorEnvelope } from '@traceforge/contracts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
    readonly details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type Params = Record<string, string | number | boolean | null | undefined>;

export function toQuery(params: Params = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  params?: Params;
  signal?: AbortSignal | undefined;
}

let redirecting = false;

/** Browser-side API client. Goes through the same-origin `/api` proxy so the session cookie is first-party. */
export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await fetch(`/api${path}${toQuery(opts.params)}`, {
    method: opts.method ?? 'GET',
    headers: opts.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: 'same-origin',
    signal: opts.signal,
  }).catch(() => {
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      'Could not reach the TraceForge API. Check your connection and retry.',
      null,
    );
  });

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (res.ok) return json as T;

  const envelope = json as Partial<ApiErrorEnvelope> | null;
  const err = envelope?.error;
  if (
    res.status === 401 &&
    typeof window !== 'undefined' &&
    !redirecting &&
    !path.startsWith('/v1/auth/')
  ) {
    redirecting = true;
    window.location.assign(
      `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`,
    );
  }
  throw new ApiError(
    res.status,
    err?.code ?? 'UNKNOWN',
    err?.message ?? `Request failed with status ${res.status}`,
    err?.requestId ?? res.headers.get('x-request-id'),
    err?.details,
  );
}
