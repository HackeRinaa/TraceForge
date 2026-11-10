import type { Logger } from '@traceforge/logger';
import { Kafka, logLevel, type KafkaConfig, type logCreator } from 'kafkajs';

export interface KafkaOptions {
  brokers: string[];
  clientId: string;
  logger: Logger;
  /** Kafka client retry settings; producers on the request path use tight bounds, consumers use patient ones. */
  retry?: KafkaConfig['retry'];
}

/** Routes KafkaJS's internal logging through our structured logger. */
function pinoLogCreator(logger: Logger): logCreator {
  const levels: Record<number, 'error' | 'warn' | 'info' | 'debug'> = {
    [logLevel.ERROR]: 'error',
    [logLevel.NOTHING]: 'error',
    [logLevel.WARN]: 'warn',
    [logLevel.INFO]: 'info',
    [logLevel.DEBUG]: 'debug',
  };
  return () =>
    ({ level, log }) => {
      const { message, ...extra } = log;
      logger[levels[level] ?? 'info']({ kafka: extra }, `kafkajs: ${message}`);
    };
}

export function createKafka({ brokers, clientId, logger, retry }: KafkaOptions): Kafka {
  return new Kafka({
    clientId,
    brokers,
    logLevel: logLevel.WARN,
    logCreator: pinoLogCreator(logger),
    connectionTimeout: 5000,
    requestTimeout: 15_000,
    ...(retry ? { retry } : {}),
  });
}
