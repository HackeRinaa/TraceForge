import { TOPICS } from '@traceforge/contracts';
import { backoffDelayMs } from '@traceforge/domain';
import type { Logger } from '@traceforge/logger';
import type { Consumer, EachBatchPayload, Kafka } from 'kafkajs';
import type { WorkerConfig } from './config';
import { processChunk, type PipelineDeps, type RawMessage } from './pipeline';
import type { PipelineState } from './state';
import type { WorkerMetrics } from './metrics';

const RESTART_BASE_MS = 1000;
const RESTART_MAX_MS = 30_000;

/**
 * Owns the Kafka consumer lifecycle. Offsets are committed manually and only after a chunk is durably stored or
 * dead-lettered (at-least-once). If the consumer cannot connect or crashes (for example after a long ClickHouse outage
 * exhausted in-process retries), it is rebuilt with capped exponential backoff and jitter until shutdown is requested.
 */
export class SpanConsumer {
  private stopping = false;
  private current: Consumer | null = null;
  private wake: (() => void) | null = null;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly kafka: Kafka,
    private readonly cfg: WorkerConfig,
    private readonly pipeline: PipelineDeps,
    private readonly state: PipelineState,
    private readonly metrics: WorkerMetrics,
    private readonly logger: Logger,
    private readonly topic: string = TOPICS.spans,
  ) {}

  start(): void {
    this.loop = this.supervise();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    // stop() waits for the batch being processed to finish, so shutdown never abandons a half-committed chunk.
    await this.current?.stop().catch(() => undefined);
    await this.loop;
    this.state.phase = 'stopped';
  }

  private async supervise(): Promise<void> {
    let failures = 0;
    while (!this.stopping) {
      const consumer = this.buildConsumer();
      this.current = consumer;
      try {
        this.state.phase = 'connecting';
        const crashed = new Promise<Error>((resolve) => {
          consumer.on(consumer.events.CRASH, (e) => resolve(e.payload.error));
          this.wake = () => resolve(new Error('stopping'));
        });
        await consumer.connect();
        await consumer.subscribe({ topic: this.topic, fromBeginning: true });
        await consumer.run({
          autoCommit: false,
          eachBatchAutoResolve: false,
          partitionsConsumedConcurrently: this.cfg.WORKER_CONSUMER_CONCURRENCY,
          eachBatch: (payload) => this.handleBatch(consumer, payload),
        });
        this.state.phase = 'running';
        failures = 0;
        this.logger.info({ group: this.cfg.KAFKA_CONSUMER_GROUP }, 'consumer running');
        const reason = await crashed;
        if (!this.stopping) throw reason;
      } catch (error) {
        if (this.stopping) break;
        failures++;
        this.state.phase = 'crashed';
        this.state.recordFailure(error);
        this.logger.error(
          { err: error, failures },
          'consumer stopped unexpectedly; restarting with backoff',
        );
      } finally {
        await consumer.disconnect().catch(() => undefined);
        this.current = null;
      }
      if (this.stopping) break;
      await new Promise<void>((resolve) => {
        const t = setTimeout(
          resolve,
          backoffDelayMs(failures, { baseMs: RESTART_BASE_MS, maxMs: RESTART_MAX_MS }),
        );
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
  }

  private buildConsumer(): Consumer {
    return this.kafka.consumer({
      groupId: this.cfg.KAFKA_CONSUMER_GROUP,
      sessionTimeout: 30_000,
      heartbeatInterval: 3000,
      // Larger batches under load, bounded latency when idle: the broker answers after minBytes or maxWait, whichever first.
      minBytes: 16 * 1024,
      maxWaitTimeInMs: this.cfg.WORKER_BATCH_MAX_WAIT_MS,
      maxBytes: 10 * 1024 * 1024,
      maxBytesPerPartition: 1024 * 1024,
      allowAutoTopicCreation: false,
      retry: {
        retries: 8,
        initialRetryTime: 300,
        maxRetryTime: 30_000,
        restartOnFailure: () => Promise.resolve(false),
      },
    });
  }

  private async handleBatch(consumer: Consumer, payload: EachBatchPayload): Promise<void> {
    const { batch } = payload;
    const size = this.cfg.WORKER_BATCH_MAX_MESSAGES;
    for (let i = 0; i < batch.messages.length; i += size) {
      if (!payload.isRunning() || payload.isStale()) return;
      const slice = batch.messages.slice(i, i + size);
      const chunk: RawMessage[] = slice.map((m) => ({
        topic: batch.topic,
        partition: batch.partition,
        offset: m.offset,
        key: m.key ? m.key.toString('utf8') : null,
        value: m.value,
      }));
      try {
        const outcome = await processChunk(chunk, this.pipeline);
        this.state.recordSuccess(outcome.persisted, outcome.deadLettered);
        this.metrics.consecutiveFailures.set(0);
      } catch (error) {
        this.state.recordFailure(error);
        this.metrics.batchFailures.inc();
        this.metrics.consecutiveFailures.set(this.state.consecutiveFailures);
        this.logger.error(
          { err: error, partition: batch.partition, messages: chunk.length },
          'chunk failed; offsets not committed',
        );
        throw error;
      }
      const last = slice[slice.length - 1];
      if (last) {
        payload.resolveOffset(last.offset);
        await consumer.commitOffsets([
          {
            topic: batch.topic,
            partition: batch.partition,
            offset: (BigInt(last.offset) + 1n).toString(),
          },
        ]);
      }
      await payload.heartbeat();
    }
  }
}
