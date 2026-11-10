import { randomUUID } from 'node:crypto';
import type { DeadLetterV1 } from '@traceforge/contracts';
import { SpanPublisher } from '@traceforge/messaging';
import { analytics, createClickHouse, insertDerivedRows } from '@traceforge/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestInfra, type TestInfra } from '../../../tests/helpers/infra';
import { spanEvent, waitFor } from '../../../tests/helpers/spans';
import { isTransientClickHouseError } from './clickhouse-errors';
import type { WorkerConfig } from './config';
import { SpanConsumer } from './consumer';
import { DeadLetterPublisher } from './dlq';
import { createWorkerMetrics } from './metrics';
import type { PipelineDeps } from './pipeline';
import { PipelineState } from './state';

describe('worker pipeline against real Kafka and ClickHouse', () => {
  let infra: TestInfra;
  const projectId = randomUUID();
  const group = `it-group-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    infra = await createTestInfra({ topics: true });
  });
  afterAll(async () => {
    await infra.cleanup();
  });

  const cfg = (): WorkerConfig =>
    ({
      KAFKA_CONSUMER_GROUP: group,
      WORKER_BATCH_MAX_MESSAGES: 100,
      WORKER_BATCH_MAX_WAIT_MS: 100,
      WORKER_CONSUMER_CONCURRENCY: 1,
    }) as unknown as WorkerConfig;

  function build(ch = infra.ch, retry = { maxAttempts: 2, baseMs: 5, maxMs: 20 }) {
    const state = new PipelineState();
    const dlq = new DeadLetterPublisher(infra.kafka, infra.logger, infra.dlqTopic);
    const deps: PipelineDeps = {
      insert: (rows) => insertDerivedRows(ch, rows),
      deadLetter: (e) => dlq.publish(e),
      isTransient: isTransientClickHouseError,
      retry,
      consumerGroup: group,
      now: Date.now,
      hooks: {
        onBatch: () => undefined,
        onRetry: () => undefined,
        onInsert: () => undefined,
        onPersisted: () => undefined,
        onDeadLetter: () => undefined,
      },
    };
    const consumer = new SpanConsumer(
      infra.kafka,
      cfg(),
      deps,
      state,
      createWorkerMetrics(),
      infra.logger,
      infra.spansTopic,
    );
    return { consumer, state, dlq };
  }

  const scope = () => ({
    projectId,
    from: new Date(Date.now() - 600_000),
    to: new Date(Date.now() + 60_000),
  });

  it('moves published spans through Kafka into ClickHouse, de-duplicating redelivery, and routes poison messages to the DLQ', async () => {
    const publisher = new SpanPublisher(infra.kafka, infra.logger, infra.spansTopic);
    const { consumer, dlq } = build();
    consumer.start();

    const events = Array.from({ length: 20 }, () => spanEvent(projectId));
    await publisher.publish(events);
    await publisher.publish(events.slice(0, 5)); // at-least-once redelivery of five spans

    // A raw message that is not JSON, and one that is JSON but violates the schema.
    const raw = infra.kafka.producer();
    await raw.connect();
    await raw.send({
      topic: infra.spansTopic,
      messages: [
        { key: 'bad1', value: 'this is not json' },
        { key: 'bad2', value: JSON.stringify({ schemaVersion: 1 }) },
      ],
    });
    await raw.disconnect();

    const totals = await waitFor(async () => {
      const t = await analytics.getTotals(infra.ch, scope());
      return t.requests >= 20 ? t : null;
    }, 30_000);
    expect(totals.requests).toBe(20); // 25 delivered, 20 distinct

    // Dead letters arrive on the DLQ topic with the original payload and reason.
    const letters: DeadLetterV1[] = [];
    const c = infra.kafka.consumer({ groupId: `dlq-reader-${group}` });
    await c.connect();
    await c.subscribe({ topic: infra.dlqTopic, fromBeginning: true });
    await c.run({
      eachMessage: ({ message }) => {
        letters.push(JSON.parse(message.value?.toString() ?? '{}') as DeadLetterV1);
        return Promise.resolve();
      },
    });
    await waitFor(() => Promise.resolve(letters.length >= 2), 20_000);
    await c.disconnect();
    expect(letters.map((l) => l.reason).sort()).toEqual(['invalid_json', 'invalid_schema']);
    expect(letters.find((l) => l.reason === 'invalid_json')?.payload).toBe('this is not json');

    await consumer.stop();
    await dlq.stop();
    await publisher.stop();
  });

  it('commits offsets only after persistence: a worker restart neither loses nor duplicates data', async () => {
    const publisher = new SpanPublisher(infra.kafka, infra.logger, infra.spansTopic);
    const before = (await analytics.getTotals(infra.ch, scope())).requests;
    const first = build();
    first.consumer.start();
    await publisher.publish(Array.from({ length: 10 }, () => spanEvent(projectId)));
    await waitFor(
      async () => (await analytics.getTotals(infra.ch, scope())).requests >= before + 10 || null,
      30_000,
    );
    await first.consumer.stop(); // "restart": a new consumer in the same group resumes from the committed offset

    const second = build();
    second.consumer.start();
    await publisher.publish(Array.from({ length: 5 }, () => spanEvent(projectId)));
    await waitFor(
      async () => (await analytics.getTotals(infra.ch, scope())).requests >= before + 15 || null,
      30_000,
    );
    expect((await analytics.getTotals(infra.ch, scope())).requests).toBe(before + 15);
    await second.consumer.stop();
    await publisher.stop();
  });

  it('survives a ClickHouse outage: reports failure, loses nothing, and catches up when the store returns', async () => {
    const publisher = new SpanPublisher(infra.kafka, infra.logger, infra.spansTopic);
    const before = (await analytics.getTotals(infra.ch, scope())).requests;

    // A client pointed at a dead port stands in for a ClickHouse outage.
    const dead = createClickHouse(
      { ...infra.clickhouse, url: 'http://127.0.0.1:1' },
      { requestTimeoutMs: 500 },
    );
    const down = build(dead);
    down.consumer.start();
    await publisher.publish(Array.from({ length: 6 }, () => spanEvent(projectId)));
    await waitFor(() => Promise.resolve(down.state.consecutiveFailures > 0), 30_000);
    expect(down.state.status(60_000)).toBe('degraded');
    expect((await analytics.getTotals(infra.ch, scope())).requests).toBe(before); // nothing was acknowledged or lost
    await down.consumer.stop();
    await dead.close();

    const up = build(); // store is back: the same uncommitted messages are processed
    up.consumer.start();
    await waitFor(
      async () => (await analytics.getTotals(infra.ch, scope())).requests >= before + 6 || null,
      40_000,
    );
    expect(up.state.status(60_000)).toBe('ok');
    await up.consumer.stop();
    await publisher.stop();
  });
});
