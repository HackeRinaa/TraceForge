import { SpanStatusCode, SpanKind, trace } from '@traceforge/telemetry';
import Fastify, { type FastifyInstance } from 'fastify';
import { FAULT_HEADER, createRng, parseFaults, simulatedDb, simulatedWork, sleep } from './sim';

/** Sets http.route and a conventional span name on the active server span, and records handler exceptions. */
export function instrument(app: FastifyInstance): void {
  app.addHook('onRequest', async (req) => {
    const span = trace.getActiveSpan();
    const route = req.routeOptions.url;
    if (span && route) {
      span.setAttribute('http.route', route);
      span.updateName(`${req.method} ${route}`);
    }
  });
  app.setErrorHandler((error: Error & { statusCode?: number }, _req, reply) => {
    const span = trace.getActiveSpan();
    span?.recordException(error);
    span?.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    return reply.status(status).send({ error: error.message });
  });
}

const jitter = (rng: () => number, min: number, max: number): number =>
  Math.round(min + rng() * (max - min));

/** Stock lookups backed by a (simulated) database. */
export async function buildInventory(seed: number): Promise<FastifyInstance> {
  const rng = createRng(seed + 1);
  const app = Fastify();
  instrument(app);

  app.get<{ Params: { id: string } }>('/stock/:id', async (req) => {
    const faults = parseFaults(req.headers[FAULT_HEADER]);
    const base = jitter(rng, 15, 90) + (faults.has('slow-db') ? jitter(rng, 400, 900) : 0);
    await simulatedDb('SELECT stock', 'SELECT sku, quantity FROM stock WHERE sku = $1', base);
    return { sku: `SKU-${req.params.id}`, quantity: Math.floor(rng() * 50) };
  });
  app.get('/healthz', async () => ({ ok: true }));
  return app;
}

/** Card charging with a fraud check and an outbound bank call. */
export async function buildPayments(seed: number): Promise<FastifyInstance> {
  const rng = createRng(seed + 2);
  const app = Fastify();
  instrument(app);

  app.post('/charge', async (req) => {
    const faults = parseFaults(req.headers[FAULT_HEADER]);
    await simulatedWork('fraud-check', jitter(rng, 10, 50));
    if (faults.has('downstream-timeout')) {
      // Hang long enough that the gateway's 2 s client timeout fires first.
      await trace.getTracer('demo').startActiveSpan(
        'bank-api authorize',
        {
          kind: SpanKind.CLIENT,
          attributes: { 'peer.service': 'bank-api', 'demo.simulated': true },
        },
        async (span) => {
          await sleep(5000);
          span.end();
        },
      );
      return { status: 'late' };
    }
    const bankMs =
      jitter(rng, 80, 220) + (faults.has('slow-downstream') ? jitter(rng, 800, 1500) : 0);
    await trace.getTracer('demo').startActiveSpan(
      'bank-api authorize',
      {
        kind: SpanKind.CLIENT,
        attributes: { 'peer.service': 'bank-api', 'demo.simulated': true },
      },
      async (span) => {
        await sleep(bankMs);
        span.end();
      },
    );
    return { status: 'authorized', authorizationId: Math.floor(rng() * 1e9).toString(16) };
  });
  app.get('/healthz', async () => ({ ok: true }));
  return app;
}
