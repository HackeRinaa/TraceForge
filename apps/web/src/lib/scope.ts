'use client';

import { RANGE_PRESETS, type RangePreset } from '@traceforge/contracts';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';
import type { Params } from './api';

/** Query parameters that make up the shared view scope. They persist across navigation and appear in shared URLs. */
export const SCOPE_KEYS = ['range', 'from', 'to', 'env', 'service'] as const;

export interface Scope {
  range: RangePreset | undefined;
  from: string | undefined;
  to: string | undefined;
  environment: string | undefined;
  service: string | undefined;
  /** Relative ranges follow the clock and refresh automatically; absolute ranges are fixed. */
  live: boolean;
}

const isPreset = (v: string | null): v is RangePreset =>
  v !== null && (RANGE_PRESETS as readonly string[]).includes(v);

export function useScope(): Scope {
  const sp = useSearchParams();
  const from = sp.get('from') ?? undefined;
  const to = sp.get('to') ?? undefined;
  const range = sp.get('range');
  return useMemo(
    () => ({
      range: from && to ? undefined : isPreset(range) ? range : '1h',
      from: from && to ? from : undefined,
      to: from && to ? to : undefined,
      environment: sp.get('env') ?? undefined,
      service: sp.get('service') ?? undefined,
      live: !(from && to),
    }),
    [sp, from, to, range],
  );
}

export function scopeToApiParams(scope: Scope): Params {
  return {
    range: scope.range,
    from: scope.from,
    to: scope.to,
    environment: scope.environment,
    service: scope.service,
  };
}

/** Updates URL search params in place, preserving the rest of the view state. */
export function useSetSearchParams() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  return useCallback(
    (patch: Record<string, string | null | undefined>, opts: { push?: boolean } = {}) => {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined || v === '') next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      if (opts.push) router.push(url);
      else router.replace(url, { scroll: false });
    },
    [router, pathname, sp],
  );
}

/** Builds an in-app link that carries the current time range and filters along. */
export function useScopedHref() {
  const sp = useSearchParams();
  return useCallback(
    (path: string, extra: Record<string, string | undefined> = {}) => {
      const q = new URLSearchParams();
      for (const k of SCOPE_KEYS) {
        const v = sp.get(k);
        if (v) q.set(k, v);
      }
      for (const [k, v] of Object.entries(extra)) if (v !== undefined) q.set(k, v);
      const s = q.toString();
      return s ? `${path}?${s}` : path;
    },
    [sp],
  );
}
