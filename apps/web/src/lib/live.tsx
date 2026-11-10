'use client';

import type { LiveSnapshot } from '@traceforge/contracts';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'polling';

interface LiveValue {
  snapshot: LiveSnapshot | null;
  status: LiveStatus;
}

const LiveContext = createContext<LiveValue>({ snapshot: null, status: 'connecting' });
export const useLive = (): LiveValue => useContext(LiveContext);

const MAX_RECONNECTS = 6;
const REFRESH_THROTTLE_MS = 8000;
const POLL_FALLBACK_MS = 20_000;

/**
 * Subscribes to the project's server-sent aggregate snapshots and refreshes visible data when new telemetry arrives.
 * Reconnects with exponential backoff; after repeated failures it degrades to plain polling so the dashboard keeps
 * updating even where event streams are blocked. The EventSource is closed on unmount.
 */
export function LiveProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const lastRefresh = useRef(0);
  const lastSpanAt = useRef<string | null>(null);

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let failures = 0;
    let disposed = false;

    const refresh = () => {
      const now = Date.now();
      if (now - lastRefresh.current < REFRESH_THROTTLE_MS) return;
      lastRefresh.current = now;
      void queryClient.invalidateQueries({ queryKey: ['p', projectId], refetchType: 'active' });
    };

    const startPolling = () => {
      setStatus('polling');
      pollTimer ??= setInterval(refresh, POLL_FALLBACK_MS);
    };

    const connect = () => {
      if (disposed) return;
      source = new EventSource(`/api/v1/projects/${projectId}/stream`);
      source.addEventListener('snapshot', (e) => {
        failures = 0;
        setStatus('live');
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = undefined;
        const data = JSON.parse((e as MessageEvent<string>).data) as LiveSnapshot;
        setSnapshot(data);
        // Only refetch when something new was ingested, so an idle project causes no churn.
        if (data.ingestion.lastSpanAt !== lastSpanAt.current) {
          lastSpanAt.current = data.ingestion.lastSpanAt;
          refresh();
        }
      });
      source.onerror = () => {
        // EventSource retries by itself while CONNECTING; a CLOSED stream (auth, 429, 5xx) needs a manual retry.
        if (source?.readyState !== EventSource.CLOSED) {
          setStatus('reconnecting');
          return;
        }
        source.close();
        failures++;
        if (failures > MAX_RECONNECTS) return startPolling();
        setStatus('reconnecting');
        retryTimer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** failures));
      };
    };
    connect();

    return () => {
      disposed = true;
      source?.close();
      clearTimeout(retryTimer);
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [projectId, queryClient]);

  const value = useMemo(() => ({ snapshot, status }), [snapshot, status]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}
