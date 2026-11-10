import type { Deps } from './deps';
import { TokenBucketLimiter } from './security/rate-limiter';
import { ApiKeyAuthenticator } from './services/api-key-auth';
import { LiveHub } from './services/live-hub';

/** Per-process collaborators shared by route modules. */
export interface Services {
  deps: Deps;
  authenticator: ApiKeyAuthenticator;
  /** Ingestion budget per project, measured in spans. */
  ingestLimiter: TokenBucketLimiter;
  /** Throttles invalid-API-key attempts per client address. */
  badKeyLimiter: TokenBucketLimiter;
  /** Throttles login and registration attempts per address and per email. */
  authLimiter: TokenBucketLimiter;
  hub: LiveHub;
  /** Open live-update connections per user, bounded to keep one account from exhausting sockets. */
  sseConnections: Map<string, number>;
  close(): void;
}

export function createServices(deps: Deps): Services {
  const authenticator = new ApiKeyAuthenticator(deps.pg.db, deps.logger);
  const ingestLimiter = new TokenBucketLimiter(
    deps.cfg.INGEST_RATE_LIMIT_SPANS_PER_SECOND,
    deps.cfg.INGEST_RATE_LIMIT_BURST_SPANS,
  );
  const badKeyLimiter = new TokenBucketLimiter(0.5, 20);
  const authLimiter = new TokenBucketLimiter(10 / 60, 10);
  const hub = new LiveHub(deps.pg.db, deps.ch, deps.logger);
  return {
    deps,
    authenticator,
    ingestLimiter,
    badKeyLimiter,
    authLimiter,
    hub,
    sseConnections: new Map(),
    close() {
      ingestLimiter.close();
      badKeyLimiter.close();
      authLimiter.close();
      hub.close();
    },
  };
}
