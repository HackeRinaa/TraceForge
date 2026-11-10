'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { createProjectSchema, type MeResponse, type ProjectDto } from '@traceforge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/fields';
import {
  Badge,
  EmptyState,
  ErrorState,
  PageHeader,
  Panel,
  TableSkeleton,
} from '@/components/ui/panel';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';

type Values = z.infer<typeof createProjectSchema> & { workspaceId: string };

export function ProjectsView() {
  const router = useRouter();
  const notify = useToast();
  const client = useQueryClient();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: ({ signal }) => api<MeResponse>('/v1/me', { signal }),
  });
  const workspaces = me.data?.workspaces ?? [];

  const projects = useQuery({
    queryKey: ['all-projects', workspaces.map((w) => w.id)],
    enabled: workspaces.length > 0,
    queryFn: async ({ signal }) =>
      (
        await Promise.all(
          workspaces.map((w) =>
            api<{ projects: ProjectDto[] }>(`/v1/workspaces/${w.id}/projects`, { signal }),
          ),
        )
      ).flatMap((r) => r.projects),
  });

  const form = useForm<Values>({
    resolver: zodResolver(createProjectSchema.extend({ workspaceId: z.string() })) as never,
    defaultValues: { name: '', workspaceId: '' },
  });

  const create = useMutation({
    mutationFn: (v: Values) =>
      api<ProjectDto>(`/v1/workspaces/${v.workspaceId || workspaces[0]?.id}/projects`, {
        method: 'POST',
        body: { name: v.name },
      }),
    onSuccess: async (project) => {
      await client.invalidateQueries({ queryKey: ['workspace-projects'] });
      notify({ title: 'Project created', description: project.name, tone: 'success' });
      router.push(`/projects/${project.id}/settings`);
    },
    onError: (e) =>
      notify({
        title: 'Could not create the project',
        description: e instanceof ApiError ? e.message : undefined,
        tone: 'error',
      }),
  });

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHeader
        title="Projects"
        description="Each project has its own API keys, telemetry, alerts and incidents."
      />
      <Panel title="Your projects" flush>
        {projects.isPending && <TableSkeleton rows={3} cols={2} />}
        {projects.isError && (
          <div className="p-4">
            <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />
          </div>
        )}
        {projects.data?.length === 0 && (
          <EmptyState title="No projects yet">
            Create your first project below, then create an API key in its settings to start sending
            telemetry.
          </EmptyState>
        )}
        {projects.data?.map((p) => (
          <Link
            key={p.id}
            href={`/projects/${p.id}/overview`}
            className="flex items-center justify-between border-t border-line px-4 py-3 first:border-t-0 hover:bg-surface-2"
          >
            <span className="font-medium">{p.name}</span>
            <span className="flex items-center gap-2">
              {p.isDemo && <Badge tone="warn">DEMO DATA</Badge>}
              <span className="text-dim">
                {workspaces.find((w) => w.id === p.workspaceId)?.name}
              </span>
            </span>
          </Link>
        ))}
      </Panel>

      <Panel title="Create a project">
        <form
          onSubmit={form.handleSubmit((v) => create.mutate(v))}
          noValidate
          className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        >
          <Field label="Name" error={form.formState.errors.name?.message}>
            {(id, d) => (
              <Input
                id={id}
                aria-describedby={d}
                placeholder="checkout-api"
                {...form.register('name')}
              />
            )}
          </Field>
          <Field label="Workspace">
            {(id) => (
              <Select id={id} {...form.register('workspaceId')}>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button
            type="submit"
            variant="primary"
            disabled={create.isPending || workspaces.length === 0}
          >
            {create.isPending ? 'Creating…' : 'Create project'}
          </Button>
        </form>
      </Panel>
    </div>
  );
}
