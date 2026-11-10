'use client';

import type { ProjectDto, WorkspaceDto } from '@traceforge/contracts';
import clsx from 'clsx';
import { Bell, ChartGantt, LayoutDashboard, Route, Settings, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Select } from '@/components/ui/fields';
import { useLive } from '@/lib/live';
import { useScopedHref } from '@/lib/scope';

const NAV = [
  { slug: 'overview', label: 'Overview', icon: LayoutDashboard },
  { slug: 'endpoints', label: 'Endpoints', icon: Route },
  { slug: 'traces', label: 'Traces', icon: ChartGantt },
  { slug: 'errors', label: 'Errors', icon: TriangleAlert },
  { slug: 'alerts', label: 'Alerts', icon: Bell },
  { slug: 'settings', label: 'Settings', icon: Settings },
] as const;

export function Logo() {
  return (
    <span className="flex items-center gap-2.5">
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M4 5h9M8 12h12M12 19h8" />
        <circle cx="4" cy="5" r="1.4" fill="var(--accent)" />
      </svg>
      <span className="text-[15px] font-semibold tracking-tight">TraceForge</span>
    </span>
  );
}

export function Sidebar({
  workspaces,
  projects,
  project,
  workspaceId,
  onNavigate,
}: {
  workspaces: WorkspaceDto[];
  projects: ProjectDto[];
  project: ProjectDto | undefined;
  workspaceId: string | undefined;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const scoped = useScopedHref();
  const { snapshot, status } = useLive();
  const active = snapshot?.activeIncidents ?? 0;

  const section = pathname.split('/')[3];
  const switchProject = (id: string) => {
    const keep = section && NAV.some((n) => n.slug === section) ? section : 'overview';
    router.push(scoped(`/projects/${id}/${keep}`));
    onNavigate?.();
  };

  return (
    <div className="flex h-full flex-col gap-4 p-3">
      <div className="px-1.5 pt-1">
        <Link href="/" aria-label="TraceForge home">
          <Logo />
        </Link>
      </div>

      <div className="flex flex-col gap-2">
        <label className="sr-only" htmlFor="workspace-select">
          Workspace
        </label>
        <Select
          id="workspace-select"
          value={workspaceId ?? ''}
          onChange={(e) => {
            const first = projects.find((p) => p.workspaceId === e.target.value);
            router.push(first ? scoped(`/projects/${first.id}/overview`) : '/projects');
            onNavigate?.();
          }}
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
        <label className="sr-only" htmlFor="project-select">
          Project
        </label>
        <Select
          id="project-select"
          value={project?.id ?? ''}
          onChange={(e) => switchProject(e.target.value)}
          disabled={!project}
        >
          {projects
            .filter((p) => p.workspaceId === workspaceId)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.isDemo ? ' (demo)' : ''}
              </option>
            ))}
        </Select>
      </div>

      {project && (
        <nav aria-label="Project" className="flex flex-col gap-0.5">
          {NAV.map(({ slug, label, icon: Icon }) => {
            const href = scoped(`/projects/${project.id}/${slug}`);
            const current = section === slug;
            return (
              <Link
                key={slug}
                href={href}
                onClick={onNavigate}
                aria-current={current ? 'page' : undefined}
                className={clsx(
                  'flex items-center gap-2.5 rounded-control px-2.5 py-1.5',
                  current
                    ? 'bg-surface-3 font-medium text-text'
                    : 'text-muted hover:bg-surface-2 hover:text-text',
                )}
              >
                <Icon className="size-4" aria-hidden />
                <span className="flex-1">{label}</span>
                {slug === 'alerts' && active > 0 && (
                  <span
                    className="rounded-full bg-err-soft px-1.5 font-mono text-[11px] text-err-text"
                    aria-label={`${active} active incidents`}
                  >
                    {active}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      )}

      <div className="mt-auto space-y-1 border-t border-line px-1.5 pt-3 text-[12px] text-muted">
        <PipelineIndicator />
        {status === 'polling' && (
          <p className="text-dim">Live stream unavailable; refreshing by polling.</p>
        )}
      </div>
    </div>
  );
}

function PipelineIndicator() {
  const { snapshot, status } = useLive();
  const health = snapshot?.ingestion;
  const tone = !health
    ? 'bg-dim'
    : health.status === 'healthy'
      ? 'bg-ok'
      : health.status === 'delayed'
        ? 'bg-warn'
        : 'bg-dim';
  const text = !health
    ? status === 'connecting'
      ? 'Connecting…'
      : 'Waiting for data'
    : health.status === 'healthy'
      ? 'Pipeline healthy'
      : health.status === 'delayed'
        ? 'Pipeline delayed'
        : 'No recent telemetry';
  return (
    <>
      <p className="flex items-center gap-2">
        <span className={clsx('size-2 rounded-full', tone)} aria-hidden />
        {text}
      </p>
      {health && health.spansLastMinute > 0 && (
        <p className="font-mono text-[11px] text-dim">
          {health.spansLastMinute} spans/min
          {health.visibilityDelayMs !== null &&
            ` · ${Math.round(health.visibilityDelayMs)} ms delay`}
        </p>
      )}
    </>
  );
}
