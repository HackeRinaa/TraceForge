import type { MeResponse } from '@traceforge/contracts';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { Shell } from '@/components/shell/shell';
import { serverGet } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

/** Authenticated area: resolves the session on the server so protected pages never render for anonymous visitors. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const me = await serverGet<MeResponse>('/v1/me');
  if (!me) redirect('/login');
  return <Shell me={me}>{children}</Shell>;
}
