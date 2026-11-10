'use client';

import type { MeResponse, ProjectDto } from '@traceforge/contracts';
import { useQueries } from '@tanstack/react-query';
import { Bell, LogOut, Menu as MenuIcon, Moon, Search, Sun, X } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Select } from '@/components/ui/fields';
import { Menu, MenuItem } from '@/components/ui/menu';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useProjectQuery } from '@/lib/hooks';
import { LiveProvider, useLive } from '@/lib/live';
import { useScopedHref, useSetSearchParams, useScope } from '@/lib/scope';
import { useTheme } from '@/lib/theme';
import { CommandPalette } from './command-palette';
import { Logo, Sidebar } from './sidebar';
import { TimeRangePicker } from './time-range';

export function Shell({ me, children }: { me: MeResponse; children: ReactNode }) {
  const { projectId } = useParams<{ projectId?: string }>();
  return projectId ? (
    <LiveProvider projectId={projectId}>
      <ShellFrame me={me} projectId={projectId}>
        {children}
      </ShellFrame>
    </LiveProvider>
  ) : (
    <ShellFrame me={me} projectId={undefined}>
      {children}
    </ShellFrame>
  );
}

function ShellFrame({
  me,
  projectId,
  children,
}: {
  me: MeResponse;
  projectId: string | undefined;
  children: ReactNode;
}) {
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);

  const projectQueries = useQueries({
    queries: me.workspaces.map((w) => ({
      queryKey: ['workspace-projects', w.id],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api<{ projects: ProjectDto[] }>(`/v1/workspaces/${w.id}/projects`, { signal }),
      staleTime: 30_000,
    })),
  });
  const projects = projectQueries.flatMap((q) => q.data?.projects ?? []);
  const current = projects.find((p) => p.id === projectId);
  const workspaceId = current?.workspaceId ?? me.workspaces[0]?.id;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && projectId) {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [projectId]);

  const sidebar = (
    <Sidebar
      workspaces={me.workspaces}
      projects={projects}
      project={current}
      workspaceId={workspaceId}
      onNavigate={() => setDrawer(false)}
    />
  );

  return (
    <div className="flex min-h-dvh">
      <aside
        className="sticky top-0 hidden h-dvh w-[232px] shrink-0 border-r border-line bg-sidebar lg:block"
        aria-label="Sidebar"
      >
        {sidebar}
      </aside>

      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-black/60"
            onClick={() => setDrawer(false)}
          />
          <aside
            className="absolute inset-y-0 left-0 w-[264px] border-r border-line bg-sidebar"
            aria-label="Sidebar"
          >
            <button
              type="button"
              aria-label="Close menu"
              className="absolute top-3 right-3 text-dim hover:text-text"
              onClick={() => setDrawer(false)}
            >
              <X className="size-4" aria-hidden />
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          me={me}
          projectId={projectId}
          onMenu={() => setDrawer(true)}
          onSearch={() => setPalette(true)}
        />
        <main className="flex-1 px-4 py-5 sm:px-6">{children}</main>
      </div>
      {projectId && <CommandPalette open={palette} onClose={() => setPalette(false)} />}
    </div>
  );
}

function Topbar({
  me,
  projectId,
  onMenu,
  onSearch,
}: {
  me: MeResponse;
  projectId: string | undefined;
  onMenu: () => void;
  onSearch: () => void;
}) {
  return (
    <header className="sticky top-0 z-30 flex flex-wrap items-center gap-2 border-b border-line bg-bg/95 px-4 py-2 backdrop-blur sm:px-6">
      <button
        type="button"
        onClick={onMenu}
        aria-label="Open menu"
        className="rounded p-1.5 text-muted hover:text-text lg:hidden"
      >
        <MenuIcon className="size-5" aria-hidden />
      </button>
      <span className="lg:hidden">
        <Logo />
      </span>
      {projectId && (
        <>
          <EnvironmentSelect />
          <TimeRangePicker />
        </>
      )}
      <div className="flex-1" />
      {projectId && <LiveBadge />}
      {projectId && (
        <button
          type="button"
          onClick={onSearch}
          className="hidden h-8 min-w-56 cursor-pointer items-center gap-2 rounded-control border border-line-strong bg-surface px-2.5 text-dim hover:text-muted md:flex"
        >
          <Search className="size-3.5" aria-hidden />
          <span className="flex-1 text-left">Jump to…</span>
          <kbd className="rounded border border-line-strong px-1 font-mono text-[11px]">⌘K</kbd>
        </button>
      )}
      {projectId && <IncidentBell projectId={projectId} />}
      <UserMenu me={me} />
    </header>
  );
}

function EnvironmentSelect() {
  const scope = useScope();
  const setParams = useSetSearchParams();
  const dims = useProjectQuery<{ environments: string[]; services: string[] }>('dimensions');
  const environments = dims.data?.environments ?? [];
  const selected = scope.environment;
  const options =
    selected && !environments.includes(selected) ? [selected, ...environments] : environments;
  return (
    <>
      <label className="sr-only" htmlFor="env-select">
        Environment
      </label>
      <Select
        id="env-select"
        className="w-40"
        value={selected ?? ''}
        onChange={(e) => setParams({ env: e.target.value || null })}
      >
        <option value="">All environments</option>
        {options.map((e) => (
          <option key={e} value={e}>
            {e}
          </option>
        ))}
      </Select>
    </>
  );
}

function LiveBadge() {
  const scope = useScope();
  const { status } = useLive();
  if (!scope.live)
    return <span className="hidden text-[12px] text-dim sm:inline">Fixed range</span>;
  const text =
    status === 'live'
      ? 'Live'
      : status === 'polling'
        ? 'Polling'
        : status === 'reconnecting'
          ? 'Reconnecting'
          : 'Connecting';
  return (
    <span className="hidden items-center gap-1.5 text-[12px] text-muted sm:flex" role="status">
      <span
        className={`size-2 rounded-full ${status === 'live' ? 'bg-ok' : 'bg-warn'}`}
        aria-hidden
      />
      {text}
    </span>
  );
}

function IncidentBell({ projectId }: { projectId: string }) {
  const { snapshot } = useLive();
  const scoped = useScopedHref();
  const n = snapshot?.activeIncidents ?? 0;
  return (
    <Link
      href={scoped(`/projects/${projectId}/alerts`)}
      aria-label={n > 0 ? `${n} active incident${n === 1 ? '' : 's'}` : 'No active incidents'}
      className="relative grid size-8 place-items-center rounded-control border border-line-strong bg-surface text-muted hover:text-text"
    >
      <Bell className="size-4" aria-hidden />
      {n > 0 && <span className="absolute top-1 right-1 size-2 rounded-full bg-err" aria-hidden />}
    </Link>
  );
}

function UserMenu({ me }: { me: MeResponse }) {
  const router = useRouter();
  const notify = useToast();
  const { theme, toggle } = useTheme();
  const initials = me.user.name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const signOut = async () => {
    try {
      await api('/v1/auth/logout', { method: 'POST' });
      router.push('/login');
      router.refresh();
    } catch {
      notify({ title: 'Could not sign out', description: 'Please try again.', tone: 'error' });
    }
  };

  return (
    <Menu
      label="Account menu"
      trigger={
        <span className="grid size-8 place-items-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent">
          {initials}
        </span>
      }
    >
      {(close) => (
        <>
          <div className="border-b border-line px-2.5 py-2">
            <p className="font-medium">{me.user.name}</p>
            <p className="text-[12px] text-dim">{me.user.email}</p>
          </div>
          <MenuItem
            onClick={() => {
              toggle();
              close();
            }}
          >
            {theme === 'dark' ? (
              <Sun className="size-4" aria-hidden />
            ) : (
              <Moon className="size-4" aria-hidden />
            )}
            {theme === 'dark' ? 'Light theme' : 'Dark theme'}
          </MenuItem>
          <MenuItem onClick={() => void signOut()}>
            <LogOut className="size-4" aria-hidden />
            Sign out
          </MenuItem>
        </>
      )}
    </Menu>
  );
}
