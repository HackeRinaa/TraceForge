'use client';

import type { EChartsCoreOption } from 'echarts/core';
import dynamic from 'next/dynamic';
import { useMemo } from 'react';
import { Skeleton } from '@/components/ui/panel';
import { useIsClient, useTheme } from '@/lib/theme';

const ChartImpl = dynamic(() => import('./chart-impl'), { ssr: false });

export interface Palette {
  text: string;
  muted: string;
  dim: string;
  line: string;
  surface: string;
  err: string;
  series: string[];
}

function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    text: v('--text'),
    muted: v('--muted'),
    dim: v('--dim'),
    line: v('--line'),
    surface: v('--surface-2'),
    err: v('--err'),
    series: [1, 2, 3, 4, 5, 6].map((n) => v(`--series-${n}`)),
  };
}

/** Current chart colors; null until mounted (CSS variables are not available during server rendering). */
export function usePalette(): Palette | null {
  const mounted = useIsClient();
  const { theme } = useTheme();
  // readPalette() reads CSS variables that change with the theme, so recompute whenever it changes.
  return useMemo(() => (mounted && theme ? readPalette() : null), [mounted, theme]);
}

export function Chart({
  option,
  height = 200,
  label,
}: {
  option: EChartsCoreOption | null;
  height?: number;
  label: string;
}) {
  if (!option) return <Skeleton className="w-full" />;
  return <ChartImpl option={option} height={height} label={label} />;
}
