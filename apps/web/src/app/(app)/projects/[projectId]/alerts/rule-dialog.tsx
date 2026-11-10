'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { alertRuleInputSchema, type AlertMetric, type AlertRuleDto } from '@traceforge/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/fields';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { useProjectId } from '@/lib/hooks';

type FormValues = z.input<typeof alertRuleInputSchema>;

export const METRICS: Record<AlertMetric, { label: string; unit: string }> = {
  error_rate: { label: 'Error rate', unit: '%' },
  p95_latency_ms: { label: 'p95 latency', unit: 'ms' },
  p99_latency_ms: { label: 'p99 latency', unit: 'ms' },
  request_rate: { label: 'Request rate', unit: 'req/min' },
};

export function describeRule(
  r: Pick<
    AlertRuleDto,
    | 'metric'
    | 'operator'
    | 'threshold'
    | 'windowMinutes'
    | 'minRequests'
    | 'method'
    | 'route'
    | 'service'
    | 'environment'
  >,
): string {
  const m = METRICS[r.metric];
  const scope = [
    r.method,
    r.route,
    r.service && `service ${r.service}`,
    r.environment && `env ${r.environment}`,
  ]
    .filter(Boolean)
    .join(' ');
  return `${m.label} ${r.operator === 'gt' ? '>' : '<'} ${r.threshold}${m.unit === '%' ? '%' : ` ${m.unit}`} over ${r.windowMinutes} min${r.metric !== 'request_rate' ? ` (min ${r.minRequests} requests)` : ''}${scope ? ` · ${scope}` : ''}`;
}

const DEFAULTS: FormValues = {
  name: '',
  metric: 'p95_latency_ms',
  operator: 'gt',
  threshold: 500,
  windowMinutes: 5,
  minRequests: 20,
  environment: '',
  service: '',
  method: '',
  route: '',
  severity: 'warning',
  enabled: true,
};

const blankToNull = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

/**
 * Optional text inputs are empty strings in the form but "unset" in the schema (which rejects empty strings), so blanks
 * are normalized before validation. Without this, an untouched optional field would block saving with no visible error.
 */
const schemaResolver = zodResolver(alertRuleInputSchema);
const normalizingResolver: typeof schemaResolver = (values, context, options) =>
  schemaResolver(
    {
      ...values,
      environment: blankToNull(values.environment),
      service: blankToNull(values.service),
      method: blankToNull(values.method),
      route: blankToNull(values.route),
    },
    context,
    options,
  );

export function RuleDialog({
  open,
  onClose,
  rule,
}: {
  open: boolean;
  onClose: () => void;
  rule: AlertRuleDto | null;
}) {
  const projectId = useProjectId();
  const client = useQueryClient();
  const notify = useToast();
  const form = useForm<FormValues>({
    resolver: normalizingResolver as never,
    defaultValues: DEFAULTS,
  });
  const { errors } = form.formState;
  const metric = useWatch({ control: form.control, name: 'metric' });

  useEffect(() => {
    if (!open) return;
    form.reset(
      rule
        ? {
            ...rule,
            environment: rule.environment ?? '',
            service: rule.service ?? '',
            method: rule.method ?? '',
            route: rule.route ?? '',
          }
        : DEFAULTS,
    );
  }, [open, rule, form]);

  const save = useMutation({
    mutationFn: (v: FormValues) => {
      const body = {
        ...v,
        environment: blankToNull(v.environment),
        service: blankToNull(v.service),
        method: blankToNull(v.method),
        route: blankToNull(v.route),
      };
      return rule
        ? api<AlertRuleDto>(`/v1/projects/${projectId}/alert-rules/${rule.id}`, {
            method: 'PATCH',
            body,
          })
        : api<AlertRuleDto>(`/v1/projects/${projectId}/alert-rules`, { method: 'POST', body });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['p', projectId, 'alert-rules'] });
      notify({ title: rule ? 'Alert rule updated' : 'Alert rule created', tone: 'success' });
      onClose();
    },
    onError: (e) =>
      notify({
        title: 'Could not save the rule',
        description: e instanceof ApiError ? e.message : undefined,
        tone: 'error',
      }),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={rule ? 'Edit alert rule' : 'New alert rule'}
      description="Evaluated every 15 seconds against stored request telemetry. An incident opens when the condition holds and resolves after two healthy evaluations."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={save.isPending}
            onClick={form.handleSubmit((v) => save.mutate(v))}
          >
            {save.isPending ? 'Saving…' : 'Save rule'}
          </Button>
        </>
      }
    >
      <form
        noValidate
        onSubmit={form.handleSubmit((v) => save.mutate(v))}
        className="grid gap-3 sm:grid-cols-2"
      >
        <Field label="Name" error={errors.name?.message} className="sm:col-span-2">
          {(id, d) => (
            <Input
              id={id}
              aria-describedby={d}
              placeholder="Slow checkout"
              {...form.register('name')}
            />
          )}
        </Field>
        <Field label="Metric">
          {(id) => (
            <Select id={id} {...form.register('metric')}>
              {Object.entries(METRICS).map(([k, m]) => (
                <option key={k} value={k}>
                  {m.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="grid grid-cols-[110px_1fr] gap-2">
          <Field label="Fires when">
            {(id) => (
              <Select id={id} {...form.register('operator')}>
                <option value="gt">above</option>
                <option value="lt">below</option>
              </Select>
            )}
          </Field>
          <Field label={`Threshold (${METRICS[metric].unit})`} error={errors.threshold?.message}>
            {(id, d) => (
              <Input
                id={id}
                type="number"
                step="any"
                aria-describedby={d}
                {...form.register('threshold', { valueAsNumber: true })}
              />
            )}
          </Field>
        </div>
        <Field label="Evaluation window (minutes)" error={errors.windowMinutes?.message}>
          {(id, d) => (
            <Input
              id={id}
              type="number"
              min={1}
              max={60}
              aria-describedby={d}
              {...form.register('windowMinutes', { valueAsNumber: true })}
            />
          )}
        </Field>
        <Field
          label="Minimum requests"
          hint={
            metric === 'request_rate'
              ? 'Not used for request rate.'
              : 'Ratios and percentiles are ignored below this sample size.'
          }
          error={errors.minRequests?.message}
        >
          {(id, d) => (
            <Input
              id={id}
              type="number"
              min={0}
              disabled={metric === 'request_rate'}
              aria-describedby={d}
              {...form.register('minRequests', { valueAsNumber: true })}
            />
          )}
        </Field>
        <Field label="Severity">
          {(id) => (
            <Select id={id} {...form.register('severity')}>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </Select>
          )}
        </Field>
        <Field label="Environment (optional)">
          {(id) => <Input id={id} placeholder="all" {...form.register('environment')} />}
        </Field>
        <Field label="Service (optional)">
          {(id) => <Input id={id} placeholder="all" {...form.register('service')} />}
        </Field>
        <div className="grid grid-cols-[110px_1fr] gap-2">
          <Field label="Method">
            {(id) => (
              <Select id={id} {...form.register('method')}>
                <option value="">any</option>
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Route (optional)">
            {(id) => (
              <Input
                id={id}
                className="font-mono"
                placeholder="/api/orders"
                {...form.register('route')}
              />
            )}
          </Field>
        </div>
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}
