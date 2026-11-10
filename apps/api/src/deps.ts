import type { Logger } from '@traceforge/logger';
import type { Kafka, SpanPublisher } from '@traceforge/messaging';
import type { ClickHouseClient, PgHandle } from '@traceforge/storage';
import type { ApiConfig } from './config';
import type { Metrics } from './metrics';

/** Everything the HTTP layer needs, injected so tests can build the app against real or test dependencies. */
export interface Deps {
  cfg: ApiConfig;
  logger: Logger;
  pg: PgHandle;
  ch: ClickHouseClient;
  kafka: Kafka;
  publisher: SpanPublisher;
  metrics: Metrics;
}
