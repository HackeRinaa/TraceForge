import type { ApiErrorCode, ApiErrorEnvelope } from '@traceforge/contracts';
import { isClickHouseTimeout } from '@traceforge/storage';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type ZodType } from 'zod';

export class AppError extends Error {
  override name = 'AppError';
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: Array<{ path: string; message: string }>,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const unauthenticated = () =>
  new AppError(401, 'UNAUTHENTICATED', 'Authentication is required');
export const forbidden = (msg = 'You do not have permission to perform this action') =>
  new AppError(403, 'FORBIDDEN', msg);

function zodDetails(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/** Validates untrusted input, turning schema failures into a 400 with per-field details. */
export function parse<T>(schema: ZodType<T>, input: unknown, what = 'The request'): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new AppError(400, 'VALIDATION_ERROR', `${what} is invalid`, zodDetails(result.error));
}

function envelope(
  req: FastifyRequest,
  code: ApiErrorCode,
  message: string,
  details?: AppError['details'],
): ApiErrorEnvelope {
  return { error: { code, message, requestId: req.id, ...(details ? { details } : {}) } };
}

export function sendError(req: FastifyRequest, reply: FastifyReply, err: AppError): FastifyReply {
  if (err.headers) void reply.headers(err.headers);
  return reply.status(err.status).send(envelope(req, err.code, err.message, err.details));
}

/** Central error handler. Internal details (stack traces, SQL, upstream messages) are logged, never returned. */
export function errorHandler(
  error: FastifyError | Error,
  req: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof AppError) return sendError(req, reply, error);
  if (error instanceof ZodError) {
    return sendError(
      req,
      reply,
      new AppError(400, 'VALIDATION_ERROR', 'The request is invalid', zodDetails(error)),
    );
  }
  const code = (error as FastifyError).code;
  switch (code) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return sendError(
        req,
        reply,
        new AppError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large'),
      );
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return sendError(
        req,
        reply,
        new AppError(
          415,
          'UNSUPPORTED_MEDIA_TYPE',
          req.url.startsWith('/v1/traces')
            ? 'Unsupported content type. TraceForge accepts OTLP/HTTP JSON (application/json); ' +
                'protobuf is not supported. Set OTEL_EXPORTER_OTLP_PROTOCOL=http/json.'
            : 'Unsupported content type. Send application/json.',
        ),
      );
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_CONTENT_LENGTH':
      return sendError(
        req,
        reply,
        new AppError(400, 'VALIDATION_ERROR', 'The request body is not valid JSON'),
      );
  }
  if (isClickHouseTimeout(error)) {
    req.log.warn({ err: error }, 'analytics query timed out');
    return sendError(
      req,
      reply,
      new AppError(
        504,
        'QUERY_TIMEOUT',
        'The query took too long. Try a shorter time range or add filters.',
      ),
    );
  }
  req.log.error({ err: error }, 'unhandled error');
  return sendError(req, reply, new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred'));
}

/** Wraps a data-store call so failures are reported as a clean 502-style error rather than fabricated data. */
export async function queryOrFail<T>(req: FastifyRequest, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (isClickHouseTimeout(error)) throw error;
    req.log.error({ err: error }, 'analytics query failed');
    throw new AppError(
      502,
      'QUERY_FAILED',
      'The analytics store could not answer this query. Please retry.',
    );
  }
}
