/**
 * Controls the running demo gateway (the one started by `pnpm dev:demo`).
 *
 *   pnpm demo:traffic status
 *   pnpm demo:traffic start [rps]          start seeded synthetic traffic (default 5 req/s)
 *   pnpm demo:traffic stop
 *   pnpm demo:traffic scenario <name> on|off
 *
 * Scenarios: slow-db, slow-downstream, intermittent-errors, downstream-timeout, high-volume
 */
const BASE =
  process.env.DEMO_GATEWAY_URL ?? `http://127.0.0.1:${process.env.DEMO_GATEWAY_PORT ?? '4100'}`;
const [command = 'status', arg1, arg2] = process.argv.slice(2);

async function call(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).catch(() => {
    throw new Error(`cannot reach the demo gateway at ${BASE}; is \`pnpm dev:demo\` running?`);
  });
  const json: unknown = await res.json();
  if (!res.ok) throw new Error(`demo gateway returned ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

let result: unknown;
switch (command) {
  case 'status':
    result = await call('/__demo/state');
    break;
  case 'start':
    result = await call('/__demo/traffic', {
      action: 'start',
      ...(arg1 ? { rps: Number(arg1) } : {}),
    });
    break;
  case 'stop':
    result = await call('/__demo/traffic', { action: 'stop' });
    break;
  case 'scenario':
    if (!arg1 || (arg2 !== 'on' && arg2 !== 'off'))
      throw new Error('usage: scenario <name> on|off');
    result = await call('/__demo/scenarios', { name: arg1, enabled: arg2 === 'on' });
    break;
  default:
    throw new Error(`unknown command "${command}"`);
}
console.log(JSON.stringify(result, null, 2));
export {};
