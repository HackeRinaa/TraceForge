import type { LiveSnapshot } from '@traceforge/contracts';
import type { Logger } from '@traceforge/logger';
import {
  analytics,
  countActiveIncidents,
  type ClickHouseClient,
  type Db,
} from '@traceforge/storage';

type Listener = (snapshot: LiveSnapshot) => void;

interface Topic {
  listeners: Set<Listener>;
  timer: NodeJS.Timeout;
  last: LiveSnapshot | null;
  inflight: boolean;
}

const INTERVAL_MS = 5000;

/**
 * Fans small aggregate snapshots out to SSE clients. One timer and one set of queries per project regardless of how
 * many browsers are watching, and never individual spans. Topics are torn down when the last client leaves.
 */
export class LiveHub {
  private readonly topics = new Map<string, Topic>();

  constructor(
    private readonly db: Db,
    private readonly ch: ClickHouseClient,
    private readonly logger: Logger,
  ) {}

  subscribe(projectId: string, listener: Listener): () => void {
    let topic = this.topics.get(projectId);
    if (!topic) {
      const created: Topic = {
        listeners: new Set(),
        last: null,
        inflight: false,
        timer: setInterval(() => void this.tick(projectId), INTERVAL_MS),
      };
      created.timer.unref();
      this.topics.set(projectId, created);
      topic = created;
      void this.tick(projectId);
    }
    topic.listeners.add(listener);
    if (topic.last) listener(topic.last);
    return () => {
      const t = this.topics.get(projectId);
      if (!t) return;
      t.listeners.delete(listener);
      if (t.listeners.size === 0) {
        clearInterval(t.timer);
        this.topics.delete(projectId);
      }
    };
  }

  private async tick(projectId: string): Promise<void> {
    const topic = this.topics.get(projectId);
    if (!topic || topic.inflight) return;
    topic.inflight = true;
    try {
      const to = new Date();
      const from = new Date(to.getTime() - 60_000);
      const [totals, ingestion, active] = await Promise.all([
        analytics.getTotals(this.ch, { projectId, from, to }),
        analytics.getIngestionHealth(this.ch, projectId),
        countActiveIncidents(this.db, projectId),
      ]);
      const snapshot: LiveSnapshot = {
        at: to.toISOString(),
        requestsLastMinute: totals.requests,
        errorRateLastMinute: totals.errorRate,
        p95LastMinute: totals.p95,
        activeIncidents: active,
        ingestion,
      };
      topic.last = snapshot;
      for (const l of topic.listeners) l(snapshot);
    } catch (error) {
      // Clients keep their last snapshot; the next tick retries. Nothing is fabricated.
      this.logger.warn({ err: error, projectId }, 'live snapshot failed');
    } finally {
      topic.inflight = false;
    }
  }

  close(): void {
    for (const t of this.topics.values()) clearInterval(t.timer);
    this.topics.clear();
  }
}
