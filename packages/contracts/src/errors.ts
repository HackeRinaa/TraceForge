import { z } from 'zod';

export const API_ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'INVALID_API_KEY',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'INGESTION_UNAVAILABLE',
  'QUERY_TIMEOUT',
  'QUERY_FAILED',
  'CSRF_REJECTED',
  'REGISTRATION_DISABLED',
  'INTERNAL_ERROR',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const apiErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
    requestId: z.string(),
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});

export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>;
