'use client';

import type { AlertRuleDto, IncidentDto } from '@traceforge/contracts';
import { formatDuration } from '@traceforge/domain/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { DemoBadge } from '@/components/data/demo-badge';
import { IncidentBadge } from '@/components/data/widgets';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/fields';
import {
  Badge,
  EmptyState,
  ErrorState,
  PageHeader,
  Panel,
  TableSkeleton,
} from '@/components/ui/panel';
import { Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { formatTimestamp, timeAgo } from '@/lib/format';
import { useProjectId, useProjectQuery } from '@/lib/hooks';
import { useScopedHref, useSetSearchParams } from '@/lib/scope';
import { METRICS, RuleDialog, describeRule } from './rule-dialog';

type Tab = 'incidents' | 'rules';

export function AlertsView() {
  const projectId = useProjectId();
  const sp = useSearchParams();
  const setParams = useSetSearchParams();
  const tab: Tab = sp.get('tab') === 'rules' ? 'rules' : 'incidents';
  const incidentId = sp.get('incident');

  const rules = useProjectQuery<{ rules: AlertRuleDto[] }>(
    'alert-rules',
    {},
    { scoped: false, refetchInterval: false },
  );
  const incidents = useProjectQuery<{ incidents: IncidentDto[] }>(
    'incidents',
    {},
    { scoped: false, refetchInterval: 10_000 },
  );
  const active = incidents.data?.incidents.filter((i) => i.status !== 'resolved').length;

  const [editing, setEditing] = useState<AlertRuleDto | null>(null);
  const [dialog, setDialog] = useState(false);

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-4">
      <PageHeader
        title="Alerts"
        description="Rules are evaluated against stored telemetry every 15 seconds by the worker."
        actions={
          <>
            <DemoBadge />
            <Button
              variant="primary"
              onClick={() => {
                setEditing(null);
                setDialog(true);
              }}
            >
              <Plus className="size-3.5" aria-hidden /> New alert rule
            </Button>
          </>
        }
      />
      <Tabs
        label="Alerts"
        value={tab}
        onChange={(t) => setParams({ tab: t === 'incidents' ? null : t, incident: null })}
        tabs={[
          { id: 'incidents', label: 'Incidents', count: active },
          { id: 'rules', label: 'Rules', count: rules.data?.rules.length },
        ]}
      />

      {tab === 'incidents' ? (
        <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_420px]">
          <Panel flush>
            {incidents.isPending && <TableSkeleton rows={4} cols={3} />}
            {incidents.isError && (
              <div className="p-4">
                <ErrorState error={incidents.error} onRetry={() => void incidents.refetch()} />
              </div>
            )}
            {incidents.data?.incidents.length === 0 && (
              <EmptyState title="No incidents yet">
                Incidents open automatically when an enabled rule's condition holds. Create a rule,
                then generate traffic or switch on a demo fault.
              </EmptyState>
            )}
            {incidents.data?.incidents.map((i) => (
              <button
                key={i.id}
                type="button"
                onClick={() => setParams({ incident: i.id })}
                aria-pressed={incidentId === i.id}
                className={`flex w-full cursor-pointer flex-wrap items-center gap-3 border-t border-line px-4 py-3 text-left first:border-t-0 hover:bg-surface-2 ${incidentId === i.id ? 'bg-accent-soft' : ''}`}
              >
                <IncidentBadge status={i.status} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{i.ruleName}</span>
                  <span className="block text-muted">
                    {METRICS[i.evidence.metric].label} {i.evidence.operator === 'gt' ? '>' : '<'}{' '}
                    {i.evidence.threshold}
                    {METRICS[i.evidence.metric].unit} · peak {Number(i.peakValue.toFixed(2))}
                  </span>
                </span>
                <span className="font-mono text-muted">{timeAgo(i.openedAt)}</span>
              </button>
            ))}
          </Panel>
          {incidentId ? (
            <IncidentDetail incidentId={incidentId} />
          ) : (
            <Panel>
              <p className="text-muted">
                Select an incident to see the evidence that triggered it and its history.
              </p>
            </Panel>
          )}
        </div>
      ) : (
        <RulesTable
          rules={rules}
          onEdit={(r) => {
            setEditing(r);
            setDialog(true);
          }}
        />
      )}
      <RuleDialog open={dialog} onClose={() => setDialog(false)} rule={editing} />
      <p className="sr-only">{projectId}</p>
    </div>
  );
}

function RulesTable({
  rules,
  onEdit,
}: {
  rules: ReturnType<typeof useProjectQuery<{ rules: AlertRuleDto[] }>>;
  onEdit: (r: AlertRuleDto) => void;
}) {
  const projectId = useProjectId();
  const client = useQueryClient();
  const notify = useToast();
  const [deleting, setDeleting] = useState<AlertRuleDto | null>(null);

  const refresh = () => client.invalidateQueries({ queryKey: ['p', projectId, 'alert-rules'] });
  const toggle = useMutation({
    mutationFn: (r: AlertRuleDto) =>
      api(`/v1/projects/${projectId}/alert-rules/${r.id}`, {
        method: 'PATCH',
        body: { enabled: !r.enabled },
      }),
    onSuccess: refresh,
    onError: (e) =>
      notify({
        title: 'Could not update the rule',
        description: e instanceof ApiError ? e.message : undefined,
        tone: 'error',
      }),
  });
  const remove = useMutation({
    mutationFn: (r: AlertRuleDto) =>
      api(`/v1/projects/${projectId}/alert-rules/${r.id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await refresh();
      notify({ title: 'Alert rule deleted', tone: 'success' });
      setDeleting(null);
    },
    onError: (e) =>
      notify({
        title: 'Could not delete the rule',
        description: e instanceof ApiError ? e.message : undefined,
        tone: 'error',
      }),
  });

  return (
    <Panel flush>
      {rules.isPending && <TableSkeleton rows={3} cols={3} />}
      {rules.isError && (
        <div className="p-4">
          <ErrorState error={rules.error} onRetry={() => void rules.refetch()} />
        </div>
      )}
      {rules.data?.rules.length === 0 && (
        <EmptyState title="No alert rules">
          Create a rule to be told when error rate, latency or traffic crosses a threshold.
        </EmptyState>
      )}
      {rules.data?.rules.map((r) => (
        <div
          key={r.id}
          className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3 first:border-t-0"
        >
          <Switch
            checked={r.enabled}
            label={`${r.enabled ? 'Disable' : 'Enable'} ${r.name}`}
            onChange={() => toggle.mutate(r)}
            disabled={toggle.isPending}
          />
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {r.name} {r.severity === 'critical' && <Badge tone="err">CRITICAL</Badge>}{' '}
              {!r.enabled && <Badge>DISABLED</Badge>}
            </p>
            <p className="font-mono text-[12px] text-muted">{describeRule(r)}</p>
          </div>
          <Button size="sm" onClick={() => onEdit(r)}>
            Edit
          </Button>
          <Button size="sm" variant="danger" onClick={() => setDeleting(r)}>
            Delete
          </Button>
        </div>
      ))}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting)}
        pending={remove.isPending}
        title="Delete this alert rule?"
        description={`“${deleting?.name ?? ''}” and its incident history will be permanently removed.`}
        confirmLabel="Delete rule"
      />
    </Panel>
  );
}

function IncidentDetail({ incidentId }: { incidentId: string }) {
  const projectId = useProjectId();
  const client = useQueryClient();
  const notify = useToast();
  const scoped = useScopedHref();
  const q = useProjectQuery<IncidentDto>(
    `incidents/${incidentId}`,
    {},
    { scoped: false, refetchInterval: 10_000 },
  );
  const act = useMutation({
    mutationFn: (action: 'acknowledge' | 'resolve') =>
      api<IncidentDto>(`/v1/projects/${projectId}/incidents/${incidentId}/${action}`, {
        method: 'POST',
      }),
    onSuccess: async (_d, action) => {
      await client.invalidateQueries({ queryKey: ['p', projectId, 'incidents'] });
      await client.invalidateQueries({ queryKey: ['p', projectId, `incidents/${incidentId}`] });
      notify({
        title: action === 'acknowledge' ? 'Incident acknowledged' : 'Incident resolved',
        tone: 'success',
      });
    },
    onError: (e) =>
      notify({
        title: 'Action failed',
        description: e instanceof ApiError ? e.message : undefined,
        tone: 'error',
      }),
  });

  if (q.isPending)
    return (
      <Panel>
        <TableSkeleton rows={4} cols={2} />
      </Panel>
    );
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const i = q.data;
  const ev = i.evidence;
  const unit = METRICS[ev.metric].unit;

  return (
    <Panel
      title={i.ruleName}
      subtitle={<IncidentBadge status={i.status} />}
      actions={
        i.status !== 'resolved' && (
          <>
            {i.status === 'firing' && (
              <Button size="sm" disabled={act.isPending} onClick={() => act.mutate('acknowledge')}>
                Acknowledge
              </Button>
            )}
            <Button size="sm" disabled={act.isPending} onClick={() => act.mutate('resolve')}>
              Resolve
            </Button>
          </>
        )
      }
      flush
    >
      <div className="border-b border-line p-4">
        <h3 className="mb-2 text-[12px] font-medium text-dim">Evidence (latest evaluation)</h3>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-[12px] text-dim">Observed {METRICS[ev.metric].label}</p>
            <p className="tabular text-[20px] font-semibold text-err-text">
              {unit === 'ms'
                ? formatDuration(ev.observed)
                : `${Number(ev.observed.toFixed(2))}${unit === '%' ? '%' : ` ${unit}`}`}
            </p>
          </div>
          <div>
            <p className="text-[12px] text-dim">
              Threshold ({ev.operator === 'gt' ? 'above' : 'below'})
            </p>
            <p className="tabular text-[20px] font-semibold">
              {unit === 'ms'
                ? formatDuration(ev.threshold)
                : `${ev.threshold}${unit === '%' ? '%' : ` ${unit}`}`}
            </p>
          </div>
        </div>
        <p className="mt-2 font-mono text-[12px] text-muted">
          {ev.windowMinutes} min window · {ev.requests} requests · {formatTimestamp(ev.windowStart)}{' '}
          – {formatTimestamp(ev.windowEnd)}
        </p>
        {ev.sampleTraceIds.length > 0 && (
          <p className="mt-2 text-[12px]">
            Sample traces:{' '}
            {ev.sampleTraceIds.map((t) => (
              <Link
                key={t}
                href={scoped(`/projects/${projectId}/traces/${t}`)}
                className="mr-2 font-mono text-accent hover:underline"
              >
                {t.slice(0, 10)}
              </Link>
            ))}
          </p>
        )}
        <p className="mt-2 text-[12px] text-dim">
          Peak {Number(i.peakValue.toFixed(2))} · last value {Number(i.lastValue.toFixed(2))} · last
          evaluated {timeAgo(i.lastEvaluatedAt)}
        </p>
      </div>
      <div className="p-4">
        <h3 className="mb-2 text-[12px] font-medium text-dim">Timeline</h3>
        <ol className="space-y-1.5">
          {i.events?.map((e) => (
            <li key={e.id} className="grid grid-cols-[88px_1fr] gap-2">
              <span className="font-mono text-[12px] text-dim">{formatTimestamp(e.at)}</span>
              <span>
                {
                  {
                    opened: 'Opened',
                    acknowledged: 'Acknowledged',
                    resolved: 'Resolved manually',
                    auto_resolved: 'Auto-resolved after recovery',
                  }[e.type]
                }
                {e.actor ? ` by ${e.actor}` : ''}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </Panel>
  );
}
