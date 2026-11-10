import type { FastifyInstance } from 'fastify';
import { AppError } from '../errors';
import { projectContext } from '../services/access';
import type { Services } from '../services';

const MAX_CONNECTIONS_PER_USER = 5;
const HEARTBEAT_MS = 15_000;

/**
 * Server-sent events carrying small aggregate snapshots (see LiveHub). Authenticated with the session cookie and
 * authorized per project; bounded per user. Clients reconnect automatically and fall back to polling if unavailable.
 */
export function registerStreamRoutes(app: FastifyInstance, s: Services): void {
  const { pg, metrics } = s.deps;

  app.get('/v1/projects/:projectId/stream', async (req, reply) => {
    const ctx = await projectContext(req, pg.db);
    const open = s.sseConnections.get(ctx.user.id) ?? 0;
    if (open >= MAX_CONNECTIONS_PER_USER) {
      throw new AppError(
        429,
        'RATE_LIMITED',
        'Too many live connections for this account',
        undefined,
        { 'retry-after': '10' },
      );
    }
    s.sseConnections.set(ctx.user.id, open + 1);
    metrics.sseConnections.inc();

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-request-id': req.id,
    });
    raw.write('retry: 3000\n\n');

    const unsubscribe = s.hub.subscribe(ctx.project.id, (snapshot) => {
      raw.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    });
    const heartbeat = setInterval(() => raw.write(': ping\n\n'), HEARTBEAT_MS);

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsubscribe();
      metrics.sseConnections.dec();
      const left = (s.sseConnections.get(ctx.user.id) ?? 1) - 1;
      if (left <= 0) s.sseConnections.delete(ctx.user.id);
      else s.sseConnections.set(ctx.user.id, left);
    };
    req.raw.on('close', cleanup);
    raw.on('error', cleanup);
  });
}
