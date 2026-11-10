import { TOPICS, type SpanEventV1 } from '@traceforge/contracts';
import type { Logger } from '@traceforge/logger';
import { CompressionTypes, Partitioners, type Kafka, type Message, type Producer } from 'kafkajs';

/** Kafka's default broker limit is 1 MiB per message batch; stay safely under it. */
export const MAX_MESSAGE_BYTES = 900_000;
const MAX_BATCH_MESSAGES = 500;
const MAX_BATCH_BYTES = 800_000;

export class PublishError extends Error {
  override name = 'PublishError';
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export interface PublishResult {
  published: number;
  /** Events dropped because a single serialized event exceeded the message size limit. */
  oversized: number;
}

/**
 * Publishes span events to Kafka with idempotent, fully-acknowledged writes. `publish` resolves only after the
 * brokers have acknowledged every message (acks=all), which is what lets the ingestion API return success honestly.
 */
export class SpanPublisher {
  private readonly producer: Producer;
  private connecting: Promise<void> | null = null;
  private connected = false;

  constructor(
    kafka: Kafka,
    private readonly logger: Logger,
    private readonly topic: string = TOPICS.spans,
  ) {
    this.producer = kafka.producer({
      idempotent: true,
      maxInFlightRequests: 5,
      allowAutoTopicCreation: false,
      createPartitioner: Partitioners.DefaultPartitioner,
      retry: { retries: 2, initialRetryTime: 100, maxRetryTime: 2000 },
    });
    this.producer.on(this.producer.events.DISCONNECT, () => {
      this.connected = false;
      this.connecting = null;
    });
  }

  /** True once a connection has been established and not since lost; used for readiness reporting. */
  get isConnected(): boolean {
    return this.connected;
  }

  private ensureConnected(): Promise<void> {
    if (this.connected) return Promise.resolve();
    this.connecting ??= this.producer
      .connect()
      .then(() => {
        this.connected = true;
        this.logger.info('kafka producer connected');
      })
      .catch((error: unknown) => {
        this.connecting = null;
        throw error;
      });
    return this.connecting;
  }

  /** Best-effort connect at startup; failure is non-fatal because publish() reconnects lazily. */
  async start(): Promise<void> {
    try {
      await this.ensureConnected();
    } catch (error) {
      this.logger.warn(
        { err: error },
        'kafka producer could not connect at startup; will retry on demand',
      );
    }
  }

  async publish(events: readonly SpanEventV1[]): Promise<PublishResult> {
    let oversized = 0;
    const messages: Array<Message & { size: number }> = [];
    for (const e of events) {
      const value = JSON.stringify(e);
      const size = Buffer.byteLength(value);
      if (size > MAX_MESSAGE_BYTES) {
        oversized++;
        continue;
      }
      // Keying by trace ID keeps every span of a trace on one partition, preserving per-trace ordering.
      messages.push({ key: e.traceId, value, size });
    }

    try {
      await this.ensureConnected();
      for (const batch of chunk(messages)) {
        await this.producer.send({
          topic: this.topic,
          acks: -1,
          compression: CompressionTypes.GZIP,
          timeout: 10_000,
          messages: batch.map(({ key, value }) => ({ key, value })),
        });
      }
    } catch (error) {
      this.connected = false;
      this.connecting = null;
      throw new PublishError('failed to publish spans to Kafka', error);
    }
    return { published: messages.length, oversized };
  }

  async stop(): Promise<void> {
    this.connected = false;
    await this.producer.disconnect().catch((error: unknown) => {
      this.logger.warn({ err: error }, 'error while disconnecting kafka producer');
    });
  }
}

function* chunk<T extends { size: number }>(items: readonly T[]): Generator<T[]> {
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    if (
      current.length > 0 &&
      (current.length >= MAX_BATCH_MESSAGES || bytes + item.size > MAX_BATCH_BYTES)
    ) {
      yield current;
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += item.size;
  }
  if (current.length > 0) yield current;
}
