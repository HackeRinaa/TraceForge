'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/fields';
import { Badge, ErrorState, Panel, Skeleton } from '@/components/ui/panel';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';

interface DemoState {
  scenarios: Array<{ name: string; description: string; active: boolean }>;
  traffic: { running: boolean; rps: number; effectiveRps: number; sent: number; failed: number };
  seed: number;
}

async function demo<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/demo-control/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok)
    throw new ApiError(
      res.status,
      'DEMO_ERROR',
      json.error ?? `Request failed (${res.status})`,
      null,
    );
  return json as T;
}

/** Controls for the bundled demo services: seeded synthetic traffic and injectable faults. Demo projects only. */
export function DemoControls() {
  const client = useQueryClient();
  const notify = useToast();
  const state = useQuery({
    queryKey: ['demo-state'],
    queryFn: () => demo<DemoState>('state'),
    refetchInterval: 4000,
    retry: false,
  });
  const mutate = useMutation({
    mutationFn: (p: { path: string; body: unknown }) => demo<DemoState>(p.path, p.body),
    onSuccess: (d) => client.setQueryData(['demo-state'], d),
    onError: (e) =>
      notify({
        title: 'Demo control failed',
        description: e instanceof Error ? e.message : undefined,
        tone: 'error',
      }),
  });
  const s = state.data;

  return (
    <Panel
      title="Demo controls"
      subtitle="Generate traffic and inject faults in the bundled demo services. Everything here is simulated."
      actions={<Badge tone="warn">SIMULATED</Badge>}
    >
      {state.isPending && <Skeleton className="h-24" />}
      {state.isError && <ErrorState error={state.error} onRetry={() => void state.refetch()} />}
      {s && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            {s.traffic.running ? (
              <Button
                onClick={() => mutate.mutate({ path: 'traffic', body: { action: 'stop' } })}
                disabled={mutate.isPending}
              >
                <Square className="size-3.5" aria-hidden /> Stop traffic
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() =>
                  mutate.mutate({ path: 'traffic', body: { action: 'start', rps: 8 } })
                }
                disabled={mutate.isPending}
              >
                <Play className="size-3.5" aria-hidden /> Generate traffic (8 req/s)
              </Button>
            )}
            <span className="font-mono text-[12px] text-muted" role="status">
              {s.traffic.running ? `sending ${s.traffic.effectiveRps} req/s` : 'idle'} ·{' '}
              {s.traffic.sent} sent · {s.traffic.failed} failed · seed {s.seed}
            </span>
          </div>
          <ul className="divide-y divide-line rounded-control border border-line">
            {s.scenarios.map((sc) => (
              <li key={sc.name} className="flex items-center gap-3 px-3 py-2.5">
                <Switch
                  checked={sc.active}
                  label={`${sc.active ? 'Disable' : 'Enable'} ${sc.name}`}
                  onChange={(enabled) =>
                    mutate.mutate({ path: 'scenarios', body: { name: sc.name, enabled } })
                  }
                  disabled={mutate.isPending}
                />
                <div>
                  <p className="font-mono">{sc.name}</p>
                  <p className="text-[12px] text-muted">{sc.description}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
