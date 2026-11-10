import type { Kafka } from 'kafkajs';

export interface ConsumerLag {
  /** Messages produced but not yet committed by the group, summed over partitions. */
  totalLag: number;
  partitions: Array<{ partition: number; lag: number }>;
}

/** Committed-offset lag for a consumer group. A group that never committed is measured from the log start. */
export async function getConsumerLag(
  kafka: Kafka,
  groupId: string,
  topic: string,
): Promise<ConsumerLag> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    const [latest, committed] = await Promise.all([
      admin.fetchTopicOffsets(topic),
      admin.fetchOffsets({ groupId, topics: [topic] }),
    ]);
    const committedByPartition = new Map(
      (committed[0]?.partitions ?? []).map((p) => [p.partition, Number(p.offset)]),
    );
    const partitions = latest.map((p) => {
      const end = Number(p.high);
      const start = Number(p.low);
      const done = committedByPartition.get(p.partition) ?? -1;
      return { partition: p.partition, lag: Math.max(0, end - (done < 0 ? start : done)) };
    });
    return { totalLag: partitions.reduce((n, p) => n + p.lag, 0), partitions };
  } finally {
    await admin.disconnect();
  }
}

/** Creates topics if missing. Used by tests that need isolated topics; production uses infrastructure/kafka. */
export async function ensureTopics(
  kafka: Kafka,
  topics: Array<{ topic: string; partitions: number }>,
): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.createTopics({
      waitForLeaders: true,
      topics: topics.map((t) => ({
        topic: t.topic,
        numPartitions: t.partitions,
        replicationFactor: 1,
      })),
    });
  } finally {
    await admin.disconnect();
  }
}

export async function deleteTopics(kafka: Kafka, topics: string[]): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.deleteTopics({ topics });
  } finally {
    await admin.disconnect();
  }
}
