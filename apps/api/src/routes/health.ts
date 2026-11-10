import { TOPICS } from '@traceforge/contracts';
import { getConsumerLag } from '@traceforge/messaging';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../services/access';
import type { Services } from '../services';

type Check = 'ok' | 'down';

async function check(fn: () => Promise<unknown>, timeoutMs = 2000): Promise<Check> {
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs).unref()),
    ]);
    return 'ok';
  } catch {
    return 'down';
  }
}

export function registerHealthRoutes(app: FastifyInstance, s: Services): void {
  const { pg, ch, publisher, metrics, kafka, cfg } = s.deps;

  // Liveness: the process is running and the event loop is responsive. Never depends on other systems, so a
  // dependency outage can never trigger restart loops.
  app.get('/healthz', async () => ({ status: 'ok' }));

  // Readiness: can this instance usefully take traffic? Only Postgres is required (sessions and API keys). A Kafka or
  // ClickHouse outage degrades ingestion or queries respectively but leaves the rest working, so it is reported
  // without taking the instance out of rotation.
  app.get('/readyz', async (_req, reply) => {
    const [postgres, clickhouse] = await Promise.all([
      check(() => pg.ping()),
      check(() => ch.ping()),
    ]);
    const kafkaState: Check = publisher.isConnected ? 'ok' : 'down';
    const ready = postgres === 'ok';
    const degraded = ready && (clickhouse === 'down' || kafkaState === 'down');
    return reply.status(ready ? 200 : 503).send({
      status: !ready ? 'unavailable' : degraded ? 'degraded' : 'ok',
      checks: { postgres, clickhouse, kafka: kafkaState },
    });
  });

  app.get('/metrics', async (_req, reply) => {
    return reply
      .header('content-type', metrics.registry.contentType)
      .send(await metrics.registry.metrics());
  });

  // Pipeline status for signed-in users: is telemetry flowing from Kafka into ClickHouse, and how far behind is it?
  app.get('/v1/pipeline/status', async (req) => {
    await requireUser(req, pg.db);
    const lag = await getConsumerLag(kafka, cfg.KAFKA_CONSUMER_GROUP, TOPICS.spans).then(
      (l) => ({ totalLag: l.totalLag, partitions: l.partitions.length }),
      () => null,
    );
    return { producerConnected: publisher.isConnected, consumer: lag };
  });
}
