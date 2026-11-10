import { createGunzip } from 'node:zlib';
import { PassThrough } from 'node:stream';
import { otlpTraceRequestSchema } from '@traceforge/contracts';
import { convertOtlpTrace, countSpans } from '@traceforge/domain';
import { PublishError } from '@traceforge/messaging';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../errors';
import { looksLikeApiKey } from '../security/crypto';
import type { Services } from '../services';

export const INGEST_PATH = '/v1/traces';

/** Accepts `Authorization: Bearer <key>` (OTLP exporter convention) or `x-traceforge-key`. */
function extractKey(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && /^bearer /i.test(auth)) return auth.slice(7).trim();
  const header = req.headers['x-traceforge-key'];
  return typeof header === 'string' ? header.trim() : null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the ingest authentication hook. */
    ingestProjectId?: string;
  }
}

/**
 * OTLP/HTTP JSON ingestion.
 *
 * Acknowledgement contract: a 2xx response means every accepted span has been written to Kafka with acks=all by an
 * idempotent producer. If Kafka cannot confirm, the client receives 503 + Retry-After and must retry; nothing is
 * acknowledged and then lost in an in-process buffer. Persistence to ClickHouse happens asynchronously afterwards.
 */
export function registerIngestRoutes(app: FastifyInstance, s: Services): void {
  const { cfg, metrics, publisher, logger } = s.deps;
  let inflight = 0;

  app.post(
    INGEST_PATH,
    {
      bodyLimit: cfg.INGEST_MAX_BODY_BYTES,
      // Authenticate before reading the body so unauthenticated callers cannot make us parse megabytes.
      onRequest: async (req) => {
        const key = extractKey(req);
        const identity =
          key && looksLikeApiKey(key) ? await s.authenticator.authenticate(key) : null;
        if (!identity) {
          metrics.authFailures.inc({ kind: 'api_key' });
          const throttle = s.badKeyLimiter.take(req.ip);
          if (!throttle.allowed) {
            throw new AppError(429, 'RATE_LIMITED', 'Too many invalid credentials', undefined, {
              'retry-after': String(throttle.retryAfterSeconds),
            });
          }
          throw new AppError(401, 'INVALID_API_KEY', 'A valid TraceForge API key is required');
        }
        req.ingestProjectId = identity.projectId;
      },
      // Transparent gzip support. The body limit applies to the decompressed bytes, which bounds zip bombs.
      preParsing: (req, _reply, payload, done) => {
        const encoding = req.headers['content-encoding'];
        if (encoding === undefined || encoding === 'identity') return done(null, payload);
        if (encoding !== 'gzip') {
          return done(
            new AppError(
              415,
              'UNSUPPORTED_MEDIA_TYPE',
              `Unsupported content-encoding "${String(encoding)}"; use gzip or none`,
            ),
          );
        }
        const out = new PassThrough();
        const gunzip = createGunzip();
        payload.on('error', (e) => out.destroy(e));
        gunzip.on('error', () =>
          out.destroy(new AppError(400, 'VALIDATION_ERROR', 'The gzip body is corrupt')),
        );
        payload.pipe(gunzip).pipe(out);
        delete req.headers['content-encoding'];
        delete req.headers['content-length'];
        done(null, out);
      },
    },
    async (req, reply) => {
      const started = process.hrtime.bigint();
      const projectId = req.ingestProjectId;
      if (!projectId)
        throw new AppError(401, 'INVALID_API_KEY', 'A valid TraceForge API key is required');

      const parsed = otlpTraceRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        metrics.ingestRequests.inc({ outcome: 'invalid' });
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          'The body is not a valid OTLP/HTTP JSON trace export',
          parsed.error.issues
            .slice(0, 10)
            .map((i) => ({ path: i.path.join('.'), message: i.message })),
        );
      }

      const spanCount = countSpans(parsed.data);
      if (spanCount === 0) return reply.send({});
      if (spanCount > cfg.INGEST_MAX_SPANS_PER_REQUEST) {
        metrics.ingestRequests.inc({ outcome: 'too_large' });
        throw new AppError(
          413,
          'PAYLOAD_TOO_LARGE',
          `A request may contain at most ${cfg.INGEST_MAX_SPANS_PER_REQUEST} spans`,
        );
      }

      const budget = s.ingestLimiter.take(projectId, spanCount);
      if (!budget.allowed) {
        metrics.ingestRequests.inc({ outcome: 'rate_limited' });
        throw new AppError(
          429,
          'RATE_LIMITED',
          'Ingestion rate limit exceeded for this project',
          undefined,
          {
            'retry-after': String(budget.retryAfterSeconds),
          },
        );
      }

      // Backpressure: bound concurrent Kafka publishes so a slow broker produces fast 503s instead of unbounded memory.
      if (inflight >= cfg.INGEST_MAX_CONCURRENT_PUBLISHES) {
        metrics.ingestRequests.inc({ outcome: 'overloaded' });
        throw new AppError(
          503,
          'INGESTION_UNAVAILABLE',
          'The ingestion pipeline is overloaded; retry shortly',
          undefined,
          {
            'retry-after': '2',
          },
        );
      }

      const receivedAt = Date.now();
      const converted = convertOtlpTrace(parsed.data, {
        projectId,
        receivedAt,
        maxAgeMs: cfg.RETENTION_DAYS * 86_400_000,
        maxFutureMs: 5 * 60_000,
      });
      if (converted.rejected > 0)
        metrics.spansRejected.inc({ reason: 'invalid' }, converted.rejected);

      if (converted.events.length > 0) {
        inflight++;
        metrics.inflightPublishes.set(inflight);
        const publishStarted = process.hrtime.bigint();
        try {
          const result = await publisher.publish(converted.events);
          metrics.spansAccepted.inc(result.published);
          if (result.oversized > 0)
            metrics.spansRejected.inc({ reason: 'oversized' }, result.oversized);
          converted.rejected += result.oversized;
        } catch (error) {
          metrics.publishFailures.inc();
          metrics.ingestRequests.inc({ outcome: 'kafka_unavailable' });
          if (error instanceof PublishError) {
            logger.error(
              { err: error, projectId, spans: converted.events.length },
              'kafka publish failed; rejecting batch',
            );
            throw new AppError(
              503,
              'INGESTION_UNAVAILABLE',
              'Telemetry could not be queued; retry shortly',
              undefined,
              {
                'retry-after': '5',
              },
            );
          }
          throw error;
        } finally {
          inflight--;
          metrics.inflightPublishes.set(inflight);
          metrics.publishDuration.observe(Number(process.hrtime.bigint() - publishStarted) / 1e9);
        }
      }

      metrics.ingestRequests.inc({ outcome: 'accepted' });
      req.log.debug(
        { projectId, spans: spanCount, ms: Number(process.hrtime.bigint() - started) / 1e6 },
        'ingested',
      );
      if (converted.rejected === 0) return reply.send({});
      return reply.send({
        partialSuccess: {
          rejectedSpans: converted.rejected,
          errorMessage: converted.rejectionReasons.join('; ') || 'some spans were rejected',
        },
      });
    },
  );
}
