import { TOPICS, type DeadLetterV1 } from '@traceforge/contracts';
import type { Logger } from '@traceforge/logger';
import { CompressionTypes, Partitioners, type Kafka, type Producer } from 'kafkajs';

/** Publishes dead letters with the same durability guarantees as ingestion (idempotent, acks=all). */
export class DeadLetterPublisher {
  private readonly producer: Producer;
  private connected = false;

  constructor(
    kafka: Kafka,
    private readonly logger: Logger,
    private readonly topic: string = TOPICS.dlq,
  ) {
    this.producer = kafka.producer({
      idempotent: true,
      allowAutoTopicCreation: false,
      createPartitioner: Partitioners.DefaultPartitioner,
    });
  }

  async publish(entries: DeadLetterV1[]): Promise<void> {
    if (!this.connected) {
      await this.producer.connect();
      this.connected = true;
    }
    await this.producer.send({
      topic: this.topic,
      acks: -1,
      compression: CompressionTypes.GZIP,
      messages: entries.map((e) => ({ key: e.key, value: JSON.stringify(e) })),
    });
    this.logger.warn(
      { count: entries.length, reasons: [...new Set(entries.map((e) => e.reason))] },
      'messages routed to dead-letter topic',
    );
  }

  async stop(): Promise<void> {
    if (this.connected) await this.producer.disconnect().catch(() => undefined);
    this.connected = false;
  }
}
