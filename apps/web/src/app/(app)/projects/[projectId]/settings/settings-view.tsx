'use client';

import type { ApiKeyDto, CreatedApiKeyDto } from '@traceforge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/fields';
import {
  Badge,
  EmptyState,
  ErrorState,
  PageHeader,
  Panel,
  Skeleton,
  TableSkeleton,
} from '@/components/ui/panel';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { useProject, useProjectId } from '@/lib/hooks';
import { DemoControls } from './demo-controls';

export function SettingsView() {
  const project = useProject();
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <PageHeader
        title="Settings"
        description="Project configuration, API keys and instrumentation instructions."
      />
      {project.isPending && <Skeleton className="h-40" />}
      {project.isError && (
        <ErrorState error={project.error} onRetry={() => void project.refetch()} />
      )}
      {project.data && (
        <>
          <GeneralSection />
          <ApiKeysSection />
          <InstrumentationSection />
          {project.data.isDemo && <DemoControls />}
          <RetentionSection />
          <DangerSection />
        </>
      )}
    </div>
  );
}

function GeneralSection() {
  const project = useProject();
  const client = useQueryClient();
  const notify = useToast();
  // `null` = unedited: the field shows the saved name. Saving or reloading resets it without an effect.
  const [edited, setName] = useState<string | null>(null);
  const name = edited ?? project.data?.name ?? '';
  const save = useMutation({
    mutationFn: () => api(`/v1/projects/${project.data?.id}`, { method: 'PATCH', body: { name } }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['project'] });
      await client.invalidateQueries({ queryKey: ['workspace-projects'] });
      setName(null);
      notify({ title: 'Project renamed', tone: 'success' });
    },
    onError: (e) =>
      notify({
        title: 'Could not rename the project',
        description: e instanceof ApiError ? e.message : undefined,
        tone: 'error',
      }),
  });
  const dirty = !!project.data && name.trim() !== project.data.name && name.trim().length > 0;
  return (
    <Panel title="General">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) save.mutate();
        }}
      >
        <Field label="Project name" className="min-w-64 flex-1">
          {(id) => (
            <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          )}
        </Field>
        <Button type="submit" variant="primary" disabled={!dirty || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </form>
      <p className="mt-3 font-mono text-[12px] text-dim">Project ID {project.data?.id}</p>
    </Panel>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard unavailable; the value remains selectable */
        }
      }}
    >
      {done ? (
        <Check className="size-3.5" aria-hidden />
      ) : (
        <Copy className="size-3.5" aria-hidden />
      )}
      {done ? 'Copied' : 'Copy'}
    </Button>
  );
}

function ApiKeysSection() {
  const projectId = useProjectId();
  const client = useQueryClient();
  const notify = useToast();
  const keys = useQuery({
    queryKey: ['p', projectId, 'api-keys'],
    queryFn: ({ signal }) =>
      api<{ keys: ApiKeyDto[] }>(`/v1/projects/${projectId}/api-keys`, { signal }),
    retry: false,
  });
  const [name, setName] = useState('');
  const [secret, setSecret] = useState<CreatedApiKeyDto | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyDto | null>(null);
  const [rotating, setRotating] = useState<ApiKeyDto | null>(null);

  const refresh = () => client.invalidateQueries({ queryKey: ['p', projectId, 'api-keys'] });
  const onError = (title: string) => (e: unknown) =>
    notify({ title, description: e instanceof ApiError ? e.message : undefined, tone: 'error' });
  const create = useMutation({
    mutationFn: () =>
      api<CreatedApiKeyDto>(`/v1/projects/${projectId}/api-keys`, {
        method: 'POST',
        body: { name },
      }),
    onSuccess: async (k) => {
      setName('');
      setSecret(k);
      await refresh();
    },
    onError: onError('Could not create the key'),
  });
  const rotate = useMutation({
    mutationFn: (k: ApiKeyDto) =>
      api<CreatedApiKeyDto>(`/v1/projects/${projectId}/api-keys/${k.id}/rotate`, {
        method: 'POST',
      }),
    onSuccess: async (k) => {
      setRotating(null);
      setSecret(k);
      await refresh();
    },
    onError: onError('Could not rotate the key'),
  });
  const revoke = useMutation({
    mutationFn: (k: ApiKeyDto) =>
      api(`/v1/projects/${projectId}/api-keys/${k.id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      setRevoking(null);
      await refresh();
      notify({
        title: 'API key revoked',
        description: 'It may keep working for up to 30 seconds on instances that cached it.',
        tone: 'success',
      });
    },
    onError: onError('Could not revoke the key'),
  });

  return (
    <Panel
      title="API keys"
      subtitle="Keys authenticate telemetry ingestion for this project. A key is shown once, when created."
      flush
    >
      <form
        className="flex flex-wrap items-end gap-3 border-b border-line p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <Field label="New key name" className="min-w-56 flex-1">
          {(id) => (
            <Input
              id={id}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="checkout-service"
              maxLength={100}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" disabled={!name.trim() || create.isPending}>
          <KeyRound className="size-3.5" aria-hidden /> Create key
        </Button>
      </form>
      {keys.isPending && <TableSkeleton rows={2} cols={3} />}
      {keys.isError && (
        <div className="p-4">
          {keys.error instanceof ApiError && keys.error.status === 403 ? (
            <p className="text-muted">Only workspace admins can manage API keys.</p>
          ) : (
            <ErrorState error={keys.error} onRetry={() => void keys.refetch()} />
          )}
        </div>
      )}
      {keys.data?.keys.length === 0 && (
        <EmptyState title="No API keys">Create a key to start sending telemetry.</EmptyState>
      )}
      {keys.data?.keys.map((k) => (
        <div
          key={k.id}
          className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
        >
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {k.name} {k.revokedAt && <Badge tone="err">REVOKED</Badge>}
            </p>
            <p className="font-mono text-[12px] text-muted">
              {k.prefix}… · created {timeAgo(k.createdAt)} ·{' '}
              {k.lastUsedAt ? `last used ${timeAgo(k.lastUsedAt)}` : 'never used'}
            </p>
          </div>
          {!k.revokedAt && (
            <>
              <Button size="sm" onClick={() => setRotating(k)}>
                Rotate
              </Button>
              <Button size="sm" variant="danger" onClick={() => setRevoking(k)}>
                Revoke
              </Button>
            </>
          )}
        </div>
      ))}

      <Dialog
        open={!!secret}
        onClose={() => setSecret(null)}
        title="Copy your API key now"
        description="This is the only time the full key is shown. Store it in your secret manager."
        footer={
          <Button variant="primary" onClick={() => setSecret(null)}>
            I have saved the key
          </Button>
        }
      >
        <div className="flex items-center gap-2">
          <code
            className="min-w-0 flex-1 rounded bg-surface-2 px-2.5 py-2 font-mono text-[12px] break-all"
            data-testid="api-key-secret"
          >
            {secret?.secret}
          </code>
          {secret && <CopyButton value={secret.secret} label="Copy API key" />}
        </div>
      </Dialog>
      <ConfirmDialog
        open={!!rotating}
        onClose={() => setRotating(null)}
        onConfirm={() => rotating && rotate.mutate(rotating)}
        pending={rotate.isPending}
        title="Rotate this key?"
        description="A new key is created and this one is revoked immediately. Update your services with the new key."
        confirmLabel="Rotate key"
      />
      <ConfirmDialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        onConfirm={() => revoking && revoke.mutate(revoking)}
        pending={revoke.isPending}
        title="Revoke this key?"
        description="Services using it will start receiving 401 responses. This cannot be undone."
        confirmLabel="Revoke key"
      />
    </Panel>
  );
}

function InstrumentationSection() {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const endpoint =
    process.env.NEXT_PUBLIC_INGEST_URL ?? `${origin.replace(/:3000$/, ':4000')}/v1/traces`;
  const env = `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${endpoint}
OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer <YOUR_API_KEY>
OTEL_SERVICE_NAME=my-service
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production`;
  const node = `import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: '${endpoint}',
    headers: { authorization: \`Bearer \${process.env.TRACEFORGE_API_KEY}\` },
  }),
}).start();`;
  return (
    <Panel
      title="Instrumentation"
      subtitle="OTLP over HTTP with JSON encoding. Protobuf is not supported yet."
    >
      <div className="space-y-4">
        <Snippet title="Environment variables (any OpenTelemetry SDK)" code={env} />
        <Snippet title="Node.js" code={node} />
        <p className="text-muted">
          Use the <span className="font-mono">deployment.environment</span> resource attribute to
          populate the environment selector. Authorization headers, cookies, URL query strings and
          SQL literals are removed before telemetry is stored.
        </p>
      </div>
    </Panel>
  );
}

function Snippet({ title, code }: { title: string; code: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-[12px] font-medium text-dim">{title}</h3>
        <CopyButton value={code} label={`Copy ${title}`} />
      </div>
      <pre className="overflow-x-auto rounded-control bg-surface-2 p-3 font-mono text-[12px] leading-relaxed">
        {code}
      </pre>
    </div>
  );
}

function RetentionSection() {
  return (
    <Panel title="Data retention">
      <p>
        Telemetry is kept for <b>14 days</b>, enforced by ClickHouse TTL. This is a deployment-wide
        setting; per-project retention is not supported yet.
      </p>
    </Panel>
  );
}

function DangerSection() {
  const project = useProject();
  const router = useRouter();
  const client = useQueryClient();
  const notify = useToast();
  const [open, setOpen] = useState(false);
  const del = useMutation({
    mutationFn: () =>
      api(`/v1/projects/${project.data?.id}`, {
        method: 'DELETE',
        body: { confirmName: project.data?.name },
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['workspace-projects'] });
      notify({ title: 'Project deleted', tone: 'success' });
      router.push('/');
      router.refresh();
    },
    onError: (e) =>
      notify({
        title: 'Could not delete the project',
        description: e instanceof ApiError ? e.message : undefined,
        tone: 'error',
      }),
  });
  return (
    <Panel title="Delete project" className="border-err/40">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-muted">
          Deleting stops ingestion and removes the project's keys and alerts. Stored telemetry
          expires with the retention window.
        </p>
        <Button variant="danger" onClick={() => setOpen(true)}>
          Delete project…
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={() => del.mutate()}
        pending={del.isPending}
        title="Delete this project?"
        description="This cannot be undone."
        confirmLabel="Delete project"
        requireText={project.data?.name ?? ''}
      />
    </Panel>
  );
}
