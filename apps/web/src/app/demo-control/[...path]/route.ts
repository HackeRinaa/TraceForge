import type { NextRequest } from 'next/server';
import { serverGet } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

const GATEWAY = process.env.DEMO_GATEWAY_URL ?? 'http://127.0.0.1:4100';
const ALLOWED = new Set(['state', 'scenarios', 'traffic']);

/**
 * Same-origin proxy to the demo gateway's control API. It exists so the dashboard can toggle demo faults and traffic,
 * and is available only when DEMO_MODE=true, to signed-in users, with same-origin requests for mutations.
 */
async function handle(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  if (process.env.DEMO_MODE !== 'true')
    return Response.json({ error: 'demo mode is disabled' }, { status: 404 });
  const { path } = await params;
  const target = path.join('/');
  if (path.length !== 1 || !ALLOWED.has(target))
    return Response.json({ error: 'not found' }, { status: 404 });
  if (!(await serverGet('/v1/me')))
    return Response.json({ error: 'sign in required' }, { status: 401 });

  if (req.method !== 'GET') {
    const origin = req.headers.get('origin');
    if (!origin || new URL(origin).host !== req.headers.get('host')) {
      return Response.json({ error: 'cross-origin request rejected' }, { status: 403 });
    }
  }
  try {
    const res = await fetch(`${GATEWAY}/__demo/${target}`, {
      method: req.method,
      headers: { 'content-type': 'application/json' },
      ...(req.method === 'GET' ? {} : { body: await req.text() }),
      signal: AbortSignal.timeout(5000),
    });
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    });
  } catch {
    return Response.json(
      { error: 'The demo services are not running. Start them with `pnpm dev:demo`.' },
      { status: 503 },
    );
  }
}

export { handle as GET, handle as POST };
