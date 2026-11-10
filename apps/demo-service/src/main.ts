import { loadDotEnv } from '@traceforge/config';
import { startTelemetry } from '@traceforge/telemetry';

type Role = 'gateway' | 'inventory' | 'payments';

const SERVICE_NAMES: Record<Role, string> = {
  gateway: 'checkout-api',
  inventory: 'inventory-svc',
  payments: 'payments-svc',
};

async function main(): Promise<void> {
  loadDotEnv('.env', '.env.demo');

  // Fault injection and synthetic traffic must never run in a real deployment.
  if (process.env.NODE_ENV === 'production')
    throw new Error('the demo service refuses to start with NODE_ENV=production');
  if (process.env.DEMO_MODE !== 'true')
    throw new Error('set DEMO_MODE=true to run the demo services');

  const role = (process.env.DEMO_ROLE ?? 'gateway') as Role;
  if (!(role in SERVICE_NAMES)) throw new Error(`unknown DEMO_ROLE "${role}"`);

  const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
  const ports = {
    gateway: num('DEMO_GATEWAY_PORT', 4100),
    inventory: num('DEMO_INVENTORY_PORT', 4101),
    payments: num('DEMO_PAYMENTS_PORT', 4102),
  };
  const seed = num('DEMO_SEED', 42);

  const endpoint = process.env.TRACEFORGE_OTLP_ENDPOINT;
  const apiKey = process.env.TRACEFORGE_API_KEY;
  const telemetry = startTelemetry({
    serviceName: SERVICE_NAMES[role],
    environment: 'demo',
    endpoint: apiKey ? endpoint : undefined,
    apiKey,
    // Marks every span from these processes as simulated demo telemetry.
    resourceAttributes: { 'traceforge.demo': true },
    ignoreIncomingPaths: ['/healthz', '/__demo/state'],
  });
  if (!telemetry.enabled) {
    console.warn(
      `[${role}] telemetry disabled: TRACEFORGE_API_KEY is not set. Run \`pnpm demo:setup\` first.`,
    );
  }

  // Imported after telemetry starts so the http instrumentation patches Node's http module before fastify loads.
  if (role === 'gateway') {
    const { buildGateway } = await import('./gateway');
    const { stop } = await buildGateway({
      port: ports.gateway,
      inventoryUrl: `http://127.0.0.1:${ports.inventory}`,
      paymentsUrl: `http://127.0.0.1:${ports.payments}`,
      seed,
      defaultRps: num('DEMO_DEFAULT_RPS', 5),
    });
    console.log(`[gateway] checkout-api on :${ports.gateway} (seed ${seed})`);
    process.on('SIGTERM', () => stop());
  } else {
    const { buildInventory, buildPayments } = await import('./services');
    const app = role === 'inventory' ? await buildInventory(seed) : await buildPayments(seed);
    await app.listen({ host: process.env.DEMO_HOST ?? '127.0.0.1', port: ports[role] });
    console.log(`[${role}] ${SERVICE_NAMES[role]} on :${ports[role]}`);
  }

  const shutdown = (): void => {
    void telemetry.shutdown().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
