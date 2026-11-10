'use client';

import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import type { EChartsCoreOption } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';

// Only the pieces used are registered, keeping the chart bundle small.
echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, CanvasRenderer]);

export default function ChartImpl({
  option,
  height,
  label,
}: {
  option: EChartsCoreOption;
  height: number;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const instance = echarts.init(el, undefined, { renderer: 'canvas' });
    chart.current = instance;
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(el);
    return () => {
      observer.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true });
  }, [option]);

  return <div ref={host} role="img" aria-label={label} style={{ height, width: '100%' }} />;
}
