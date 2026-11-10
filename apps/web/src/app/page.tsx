import type { MeResponse, ProjectDto } from '@traceforge/contracts';
import { redirect } from 'next/navigation';
import { serverGet } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

/** Entry point: send visitors to their first project, to project creation, or to sign-in. */
export default async function Home() {
  const me = await serverGet<MeResponse>('/v1/me');
  if (!me) redirect('/login');
  for (const w of me.workspaces) {
    const res = await serverGet<{ projects: ProjectDto[] }>(`/v1/workspaces/${w.id}/projects`);
    const first = res?.projects[0];
    if (first) redirect(`/projects/${first.id}/overview`);
  }
  redirect('/projects');
}
