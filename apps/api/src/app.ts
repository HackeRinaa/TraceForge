import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Deps } from './deps';
import { AppError, errorHandler, sendError } from './errors';
import { registerAlertRoutes } from './routes/alerts';
import { registerAnalyticsRoutes } from './routes/analytics';
import { registerAuthRoutes } from './routes/auth';
import { registerHealthRoutes } from './routes/health';
import { INGEST_PATH, registerIngestRoutes } from './routes/ingest';
import { registerStreamRoutes } from './routes/stream';
import { registerWorkspaceRoutes } from './routes/workspaces';
import { registerOpenApiRoute } from './openapi';
import { createServices } from './services';
import { assertSameOrigin } from './services/access';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const QUIET_ROUTES = new Set(['/healthz', '/readyz', '/metrics']);

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const { cfg, metrics, logger } = deps;
  const services = createServices(deps);
  // Widen to Fastify's logger interface so the instance type is the standard FastifyInstance.
  const loggerInstance: FastifyBaseLogger = logger;

  const app = Fastify({
    loggerInstance,
    disableRequestLogging: true,
    requestIdLogLabel: 'requestId',
    // Non-ingest routes carry small JSON; the ingest route raises its own limit.
    bodyLimit: 256 * 1024,
    trustProxy: cfg.TRUST_PROXY,
    // Lets shutdown complete even while server-sent-event streams are open.
    forceCloseConnections: true,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && /^[\w.-]{8,64}$/.test(incoming)
        ? incoming
        : randomUUID();
    },
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: cfg.WEB_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-traceforge-key', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'retry-after'],
    maxAge: 600,
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((req, reply) =>
    sendError(req, reply, new AppError(404, 'NOT_FOUND', 'Route not found')),
  );

  app.addHook('onRequest', async (req, reply) => {
    void reply.header('x-request-id', req.id);
    // Cookie-authenticated mutations must originate from an allowed web origin. Ingestion uses API keys, not cookies.
    if (!SAFE_METHODS.has(req.method) && !req.url.startsWith(INGEST_PATH)) {
      assertSameOrigin(req, cfg.WEB_ORIGINS);
    }
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    void reply.header('x-content-type-options', 'nosniff');
    if (!reply.hasHeader('cache-control')) void reply.header('cache-control', 'no-store');
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    const seconds = reply.elapsedTime / 1000;
    metrics.httpRequests.inc({ method: req.method, route, status: String(reply.statusCode) });
    metrics.httpDuration.observe({ method: req.method, route }, seconds);
    const level = QUIET_ROUTES.has(route) ? 'debug' : reply.statusCode >= 500 ? 'warn' : 'info';
    req.log[level](
      {
        method: req.method,
        route,
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime * 10) / 10,
      },
      'request completed',
    );
  });

  app.addHook('onClose', async () => services.close());

  registerHealthRoutes(app, services);
  registerIngestRoutes(app, services);
  registerAuthRoutes(app, services);
  registerWorkspaceRoutes(app, services);
  registerAnalyticsRoutes(app, services);
  registerAlertRoutes(app, services);
  registerStreamRoutes(app, services);
  registerOpenApiRoute(app);

  return app;
}
