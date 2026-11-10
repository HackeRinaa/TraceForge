export type ConsumerPhase = 'idle' | 'connecting' | 'running' | 'crashed' | 'stopped';
export type PipelineStatus = 'starting' | 'ok' | 'degraded' | 'stalled' | 'stopped';

/**
 * Observable state of the processing pipeline, shared by the consumer and the health endpoints.
 * "degraded" means failures are happening but recent (transient trouble); "stalled" means they have lasted long
 * enough that an operator should intervene.
 */
export class PipelineState {
  phase: ConsumerPhase = 'idle';
  lastSuccessAt: number | null = null;
  lastFailureAt: number | null = null;
  lastError: string | null = null;
  consecutiveFailures = 0;
  processed = 0;
  deadLettered = 0;
  private failingSince: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  recordSuccess(persisted: number, deadLettered: number): void {
    this.lastSuccessAt = this.now();
    this.consecutiveFailures = 0;
    this.failingSince = null;
    this.processed += persisted;
    this.deadLettered += deadLettered;
  }

  recordFailure(error: unknown): void {
    const t = this.now();
    this.lastFailureAt = t;
    this.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    this.consecutiveFailures++;
    this.failingSince ??= t;
  }

  status(stallAfterMs: number): PipelineStatus {
    if (this.phase === 'stopped') return 'stopped';
    if (this.failingSince !== null)
      return this.now() - this.failingSince >= stallAfterMs ? 'stalled' : 'degraded';
    return this.phase === 'running' ? 'ok' : 'starting';
  }

  snapshot(stallAfterMs: number) {
    return {
      status: this.status(stallAfterMs),
      phase: this.phase,
      consecutiveFailures: this.consecutiveFailures,
      lastSuccessAt: this.lastSuccessAt ? new Date(this.lastSuccessAt).toISOString() : null,
      lastFailureAt: this.lastFailureAt ? new Date(this.lastFailureAt).toISOString() : null,
      lastError: this.lastError,
      processed: this.processed,
      deadLettered: this.deadLettered,
    };
  }
}
