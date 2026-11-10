import { createServer, type Server, type ServerResponse } from 'node:http';
import type { Logger } from '@traceforge/logger';
import type { ClickHouseClient } from '@traceforge/storage';
import type { Registry } from 'prom-client';
import type { PipelineState } from './state';

export interface HttpDeps {
  state: PipelineState;
  registry: Registry;
  ch: ClickHouseClient;
  stallAfterMs: number;
  logger: Logger;
}

/**
 * Operational endpoints, intentionally separate from the Kafka loop:
 *  /healthz  liveness  - the process is up (never depends on other systems, so outages cannot cause restart loops)
 *  /readyz   readiness - consumer is running, ClickHouse answers, and the pipeline is not stalled
 *  /pipeline detail    - full pipeline state for diagnosis
 *  /metrics  Prometheus
 */
export function startOpsServer(deps: HttpDeps, host: string, port: number): Server {
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    const handle = async (): Promise<void> => {
      switch (url) {
        case '/healthz':
          return json(res, 200, { status: 'ok' });
        case '/readyz': {
          const clickhouse = await deps.ch
            .ping()
            .then((r) => (r.success ? 'ok' : 'down'))
            .catch(() => 'down');
          const snap = deps.state.snapshot(deps.stallAfterMs);
          const ready =
            snap.phase === 'running' && clickhouse === 'ok' && snap.status !== 'stalled';
          return json(res, ready ? 200 : 503, {
            status: ready ? 'ok' : 'unavailable',
            pipeline: snap.status,
            clickhouse,
          });
        }
        case '/pipeline':
          return json(res, 200, deps.state.snapshot(deps.stallAfterMs));
        case '/metrics':
          res.writeHead(200, { 'content-type': deps.registry.contentType });
          return void res.end(await deps.registry.metrics());
        default:
          return json(res, 404, { error: 'not found' });
      }
    };
    handle().catch((error: unknown) => {
      deps.logger.error({ err: error }, 'ops endpoint failed');
      json(res, 500, { error: 'internal error' });
    });
  });
  server.listen(port, host);
  return server;
}
