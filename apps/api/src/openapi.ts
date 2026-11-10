import {
  alertRuleInputSchema,
  alertRuleUpdateSchema,
  analyticsQuerySchema,
  createApiKeySchema,
  createProjectSchema,
  deleteProjectSchema,
  endpointDetailQuerySchema,
  endpointsQuerySchema,
  errorsQuerySchema,
  loginSchema,
  otlpTraceRequestSchema,
  registerSchema,
  tracesQuerySchema,
} from '@traceforge/contracts';
import type { FastifyInstance } from 'fastify';
import { z, type ZodType } from 'zod';

type Method = 'get' | 'post' | 'patch' | 'delete';

interface Operation {
  method: Method;
  path: string;
  summary: string;
  tag: string;
  auth: 'none' | 'session' | 'apiKey';
  query?: ZodType;
  body?: ZodType;
  status?: number;
}

const P = '/v1/projects/{projectId}';

const operations: Operation[] = [
  {
    method: 'post',
    path: '/v1/traces',
    summary: 'Ingest spans (OTLP/HTTP JSON)',
    tag: 'Ingestion',
    auth: 'apiKey',
    body: otlpTraceRequestSchema,
  },
  {
    method: 'post',
    path: '/v1/auth/register',
    summary: 'Create an account and sign in',
    tag: 'Auth',
    auth: 'none',
    body: registerSchema,
    status: 201,
  },
  {
    method: 'post',
    path: '/v1/auth/login',
    summary: 'Sign in',
    tag: 'Auth',
    auth: 'none',
    body: loginSchema,
  },
  {
    method: 'post',
    path: '/v1/auth/logout',
    summary: 'Sign out',
    tag: 'Auth',
    auth: 'session',
    status: 204,
  },
  {
    method: 'get',
    path: '/v1/me',
    summary: 'Current user and workspaces',
    tag: 'Auth',
    auth: 'session',
  },
  {
    method: 'get',
    path: '/v1/workspaces/{workspaceId}/projects',
    summary: 'List projects',
    tag: 'Projects',
    auth: 'session',
  },
  {
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/projects',
    summary: 'Create a project',
    tag: 'Projects',
    auth: 'session',
    body: createProjectSchema,
    status: 201,
  },
  {
    method: 'delete',
    path: P,
    summary: 'Delete a project (requires the project name)',
    tag: 'Projects',
    auth: 'session',
    body: deleteProjectSchema,
    status: 204,
  },
  {
    method: 'get',
    path: `${P}/api-keys`,
    summary: 'List API keys (never includes secrets)',
    tag: 'API keys',
    auth: 'session',
  },
  {
    method: 'post',
    path: `${P}/api-keys`,
    summary: 'Create an API key; the secret is returned once',
    tag: 'API keys',
    auth: 'session',
    body: createApiKeySchema,
    status: 201,
  },
  {
    method: 'post',
    path: `${P}/api-keys/{keyId}/rotate`,
    summary: 'Rotate a key; the new secret is returned once',
    tag: 'API keys',
    auth: 'session',
    status: 201,
  },
  {
    method: 'delete',
    path: `${P}/api-keys/{keyId}`,
    summary: 'Revoke a key',
    tag: 'API keys',
    auth: 'session',
    status: 204,
  },
  {
    method: 'get',
    path: `${P}/overview`,
    summary: 'Overview: totals, series, rankings, recent traces and incidents',
    tag: 'Analytics',
    auth: 'session',
    query: analyticsQuerySchema,
  },
  {
    method: 'get',
    path: `${P}/endpoints`,
    summary: 'Endpoint table (sortable, searchable, paginated)',
    tag: 'Analytics',
    auth: 'session',
    query: endpointsQuerySchema,
  },
  {
    method: 'get',
    path: `${P}/endpoints/detail`,
    summary: 'One endpoint: stats, time series, slow and failed traces',
    tag: 'Analytics',
    auth: 'session',
    query: endpointDetailQuerySchema,
  },
  {
    method: 'get',
    path: `${P}/services`,
    summary: 'Service health summaries',
    tag: 'Analytics',
    auth: 'session',
    query: analyticsQuerySchema,
  },
  {
    method: 'get',
    path: `${P}/dimensions`,
    summary: 'Environments and services present in the range',
    tag: 'Analytics',
    auth: 'session',
    query: analyticsQuerySchema,
  },
  {
    method: 'get',
    path: `${P}/ingestion-health`,
    summary: 'Ingestion freshness and visibility delay',
    tag: 'Analytics',
    auth: 'session',
  },
  {
    method: 'get',
    path: `${P}/traces`,
    summary: 'Search traces (cursor pagination)',
    tag: 'Traces',
    auth: 'session',
    query: tracesQuerySchema,
  },
  {
    method: 'get',
    path: `${P}/traces/{traceId}`,
    summary: 'Trace detail with all spans',
    tag: 'Traces',
    auth: 'session',
  },
  {
    method: 'get',
    path: `${P}/errors`,
    summary: 'Error groups by fingerprint',
    tag: 'Errors',
    auth: 'session',
    query: errorsQuerySchema,
  },
  {
    method: 'get',
    path: `${P}/errors/{fingerprint}`,
    summary: 'Error group detail',
    tag: 'Errors',
    auth: 'session',
    query: analyticsQuerySchema,
  },
  {
    method: 'get',
    path: `${P}/alert-rules`,
    summary: 'List alert rules',
    tag: 'Alerts',
    auth: 'session',
  },
  {
    method: 'post',
    path: `${P}/alert-rules`,
    summary: 'Create an alert rule',
    tag: 'Alerts',
    auth: 'session',
    body: alertRuleInputSchema,
    status: 201,
  },
  {
    method: 'patch',
    path: `${P}/alert-rules/{ruleId}`,
    summary: 'Edit, enable or disable a rule',
    tag: 'Alerts',
    auth: 'session',
    body: alertRuleUpdateSchema,
  },
  {
    method: 'delete',
    path: `${P}/alert-rules/{ruleId}`,
    summary: 'Delete a rule',
    tag: 'Alerts',
    auth: 'session',
    status: 204,
  },
  {
    method: 'get',
    path: `${P}/incidents`,
    summary: 'List incidents (?status=firing,acknowledged,resolved)',
    tag: 'Alerts',
    auth: 'session',
  },
  {
    method: 'get',
    path: `${P}/incidents/{incidentId}`,
    summary: 'Incident with evidence and history',
    tag: 'Alerts',
    auth: 'session',
  },
  {
    method: 'post',
    path: `${P}/incidents/{incidentId}/acknowledge`,
    summary: 'Acknowledge a firing incident',
    tag: 'Alerts',
    auth: 'session',
  },
  {
    method: 'post',
    path: `${P}/incidents/{incidentId}/resolve`,
    summary: 'Resolve an incident',
    tag: 'Alerts',
    auth: 'session',
  },
  {
    method: 'get',
    path: `${P}/stream`,
    summary: 'Server-sent events: aggregate live snapshots',
    tag: 'Live',
    auth: 'session',
  },
  { method: 'get', path: '/healthz', summary: 'Liveness', tag: 'Operations', auth: 'none' },
  {
    method: 'get',
    path: '/readyz',
    summary: 'Readiness with dependency states',
    tag: 'Operations',
    auth: 'none',
  },
  {
    method: 'get',
    path: '/metrics',
    summary: 'Prometheus metrics',
    tag: 'Operations',
    auth: 'none',
  },
];

function pathParams(path: string) {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({
    name: m[1] as string,
    in: 'path' as const,
    required: true,
    schema: { type: 'string' },
  }));
}

function queryParams(schema: ZodType) {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return Object.entries(json.properties ?? {}).map(([name, s]) => ({
    name,
    in: 'query' as const,
    required: json.required?.includes(name) ?? false,
    schema: s,
  }));
}

/** Builds the OpenAPI 3.1 document from the same Zod schemas the handlers validate with. */
export function buildOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of operations) {
    const parameters = [...pathParams(op.path), ...(op.query ? queryParams(op.query) : [])];
    (paths[op.path] ??= {})[op.method] = {
      summary: op.summary,
      tags: [op.tag],
      security:
        op.auth === 'none' ? [] : [op.auth === 'apiKey' ? { apiKey: [] } : { sessionCookie: [] }],
      parameters,
      ...(op.body
        ? {
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: z.toJSONSchema(op.body, { io: 'input', unrepresentable: 'any' }),
                },
              },
            },
          }
        : {}),
      responses: {
        [String(op.status ?? 200)]: { description: 'Success' },
        '4XX': { $ref: '#/components/responses/Error' },
        '5XX': { $ref: '#/components/responses/Error' },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'TraceForge API',
      version: '0.1.0',
      description:
        'Telemetry ingestion (OTLP/HTTP JSON) and analytics. Errors use a standard envelope with a request id.',
    },
    paths,
    components: {
      securitySchemes: {
        apiKey: { type: 'http', scheme: 'bearer', description: 'Project API key (tf_live_…)' },
        sessionCookie: { type: 'apiKey', in: 'cookie', name: 'tf_session' },
      },
      responses: {
        Error: {
          description: 'Error envelope',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  error: {
                    type: 'object',
                    required: ['code', 'message', 'requestId'],
                    properties: {
                      code: { type: 'string' },
                      message: { type: 'string' },
                      requestId: { type: 'string' },
                      details: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: { path: { type: 'string' }, message: { type: 'string' } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

export function registerOpenApiRoute(app: FastifyInstance): void {
  const doc = buildOpenApi();
  app.get('/openapi.json', async (_req, reply) =>
    reply.header('cache-control', 'public, max-age=300').send(doc),
  );
}
