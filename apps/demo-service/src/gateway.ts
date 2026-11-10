import { SpanStatusCode, trace, untraced } from '@traceforge/telemetry';
import Fastify, { type FastifyInstance } from 'fastify';
import { instrument } from './services';
import {
  FAULT_HEADER,
  SCENARIOS,
  createRng,
  isScenario,
  simulatedDb,
  simulatedWork,
  sleep,
  type Scenario,
} from './sim';

export interface GatewayOptions {
  port: number;
  inventoryUrl: string;
  paymentsUrl: string;
  seed: number;
  /** Requests per second the traffic generator sends when started without an explicit rate. */
  defaultRps: number;
}

const CLIENT_TIMEOUT_MS = 2000;
const HIGH_VOLUME_MULTIPLIER = 5;
const MAX_IN_FLIGHT = 60;

const jitter = (rng: () => number, min: number, max: number): number =>
  Math.round(min + rng() * (max - min));

class DemoError extends Error {
  constructor(
    name: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = name;
  }
}

/** Sends seeded, weighted traffic to the gateway's own public endpoints. Spans are real; only the callers are synthetic. */
class TrafficGenerator {
  running = false;
  rps: number;
  sent = 0;
  failed = 0;
  private timer: NodeJS.Timeout | null = null;
  private budget = 0;
  private inFlight = 0;
  private readonly orderIds: string[] = [];

  constructor(
    private readonly baseUrl: string,
    private readonly rng: () => number,
    defaultRps: number,
    private readonly isActive: (s: Scenario) => boolean,
  ) {
    this.rps = defaultRps;
  }

  start(rps: number): void {
    this.rps = rps;
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.tick(), 100);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get effectiveRps(): number {
    return this.rps * (this.isActive('high-volume') ? HIGH_VOLUME_MULTIPLIER : 1);
  }

  private tick(): void {
    this.budget += this.effectiveRps / 10;
    while (this.budget >= 1) {
      this.budget -= 1;
      if (this.inFlight >= MAX_IN_FLIGHT) continue; // shed load rather than queue unboundedly
      void this.fire();
    }
  }

  private pick(): { method: string; path: string; body?: unknown } {
    const r = this.rng();
    const id = 1 + Math.floor(this.rng() * 200);
    if (r < 0.4) return { method: 'GET', path: '/api/products' };
    if (r < 0.65) return { method: 'GET', path: `/api/products/${id}` };
    if (r < 0.77) return { method: 'GET', path: `/api/inventory/${id}` };
    if (r < 0.9)
      return {
        method: 'POST',
        path: '/api/orders',
        body: { sku: `SKU-${id}`, quantity: 1 + Math.floor(this.rng() * 3) },
      };
    const known = this.orderIds[Math.floor(this.rng() * this.orderIds.length)];
    return { method: 'GET', path: `/api/orders/${known ?? 'ord_unknown'}` };
  }

  private async fire(): Promise<void> {
    const req = this.pick();
    this.inFlight++;
    this.sent++;
    try {
      // untraced: the generator is not part of the application, so each trace must start at the gateway's server span.
      const res = await untraced(() =>
        fetch(`${this.baseUrl}${req.path}`, {
          method: req.method,
          headers: { 'content-type': 'application/json' },
          ...(req.body ? { body: JSON.stringify(req.body) } : {}),
          signal: AbortSignal.timeout(10_000),
        }),
      );
      if (res.status >= 500) this.failed++;
      if (req.method === 'POST' && res.ok) {
        const created = (await res.json()) as { id?: string };
        if (created.id) {
          this.orderIds.push(created.id);
          if (this.orderIds.length > 200) this.orderIds.shift();
        }
      } else {
        await res.arrayBuffer();
      }
    } catch {
      this.failed++;
    } finally {
      this.inFlight--;
    }
  }
}

export async function buildGateway(
  opts: GatewayOptions,
): Promise<{ app: FastifyInstance; stop: () => void }> {
  const rng = createRng(opts.seed);
  const active = new Set<Scenario>();
  const app = Fastify();
  instrument(app);
  const generator = new TrafficGenerator(
    `http://127.0.0.1:${opts.port}`,
    createRng(opts.seed + 99),
    opts.defaultRps,
    (s) => active.has(s),
  );
  const orders = new Set<string>();

  const faultHeaders = (): Record<string, string> => ({ [FAULT_HEADER]: [...active].join(',') });
  const slowDb = (): number => (active.has('slow-db') ? jitter(rng, 400, 900) : 0);

  // --- application endpoints -------------------------------------------------------------------------------------

  app.get('/api/products', async () => {
    await simulatedDb(
      'SELECT products',
      'SELECT id, name, price FROM products ORDER BY id LIMIT 50',
      jitter(rng, 10, 45) + slowDb(),
    );
    return {
      items: Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `Product ${i + 1}` })),
    };
  });

  app.get<{ Params: { id: string } }>('/api/products/:id', async (req) => {
    await simulatedWork('cache lookup', jitter(rng, 1, 4));
    await simulatedDb(
      'SELECT product',
      'SELECT * FROM products WHERE id = $1',
      jitter(rng, 8, 30) + slowDb(),
    );
    return {
      id: req.params.id,
      name: `Product ${req.params.id}`,
      price: 10 + Math.floor(rng() * 90),
    };
  });

  app.get<{ Params: { id: string } }>('/api/inventory/:id', async (req) => {
    const res = await fetch(`${opts.inventoryUrl}/stock/${encodeURIComponent(req.params.id)}`, {
      headers: faultHeaders(),
      signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS * 2),
    });
    return res.json();
  });

  app.post<{ Body: { sku?: string; quantity?: number } }>('/api/orders', async (req, reply) => {
    await simulatedWork('validate order', jitter(rng, 3, 12));
    const sku = req.body?.sku ?? 'SKU-1';
    const stock = await fetch(
      `${opts.inventoryUrl}/stock/${encodeURIComponent(sku.replace('SKU-', ''))}`,
      {
        headers: faultHeaders(),
        signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS * 2),
      },
    );
    if (!stock.ok)
      throw new DemoError('InventoryError', `inventory lookup failed with ${stock.status}`, 502);

    try {
      const charge = await fetch(`${opts.paymentsUrl}/charge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...faultHeaders() },
        body: JSON.stringify({ sku, amount: 42 }),
        signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
      });
      if (!charge.ok)
        throw new DemoError('PaymentError', `payments service returned ${charge.status}`, 502);
      await charge.arrayBuffer();
    } catch (error) {
      if (error instanceof DemoError) throw error;
      throw new DemoError(
        'PaymentTimeoutError',
        `payments service did not respond within ${CLIENT_TIMEOUT_MS} ms`,
        504,
      );
    }

    const failure =
      active.has('intermittent-errors') && rng() < 0.18
        ? new DemoError('DeadlockError', 'deadlock detected while inserting order', 500)
        : undefined;
    await simulatedDb(
      'INSERT order',
      'INSERT INTO orders (sku, quantity, status) VALUES ($1, $2, $3)',
      jitter(rng, 20, 60) + slowDb(),
    );
    if (failure) throw failure;

    const id = `ord_${Math.floor(rng() * 1e9).toString(36)}`;
    orders.add(id);
    return reply.status(201).send({ id });
  });

  app.get<{ Params: { id: string } }>('/api/orders/:id', async (req, reply) => {
    await simulatedDb(
      'SELECT order',
      'SELECT * FROM orders WHERE id = $1',
      jitter(rng, 6, 25) + slowDb(),
    );
    if (!orders.has(req.params.id)) return reply.status(404).send({ error: 'order not found' });
    return { id: req.params.id, status: 'paid' };
  });

  app.get('/healthz', async () => ({ ok: true }));

  // --- demo control (registered only because DEMO_MODE was verified at startup) -------------------------------------

  const state = () => ({
    scenarios: (Object.keys(SCENARIOS) as Scenario[]).map((name) => ({
      name,
      description: SCENARIOS[name],
      active: active.has(name),
    })),
    traffic: {
      running: generator.running,
      rps: generator.rps,
      effectiveRps: generator.running ? generator.effectiveRps : 0,
      sent: generator.sent,
      failed: generator.failed,
    },
    seed: opts.seed,
    simulated: true,
  });

  app.get('/__demo/state', async () => state());

  app.post<{ Body: { name?: string; enabled?: boolean } }>(
    '/__demo/scenarios',
    async (req, reply) => {
      const { name, enabled } = req.body ?? {};
      if (!name || !isScenario(name) || typeof enabled !== 'boolean') {
        return reply.status(400).send({ error: 'expected { name: <scenario>, enabled: boolean }' });
      }
      if (enabled) active.add(name);
      else active.delete(name);
      return state();
    },
  );

  app.post<{ Body: { action?: string; rps?: number } }>('/__demo/traffic', async (req, reply) => {
    const { action, rps } = req.body ?? {};
    if (action === 'start') {
      const rate = typeof rps === 'number' && rps > 0 && rps <= 100 ? rps : opts.defaultRps;
      generator.start(rate);
    } else if (action === 'stop') generator.stop();
    else
      return reply
        .status(400)
        .send({ error: 'expected { action: "start" | "stop", rps?: 1-100 }' });
    return state();
  });

  await app.listen({ host: process.env.DEMO_HOST ?? '127.0.0.1', port: opts.port });
  return { app, stop: () => generator.stop() };
}

export { SpanStatusCode, trace, sleep };
