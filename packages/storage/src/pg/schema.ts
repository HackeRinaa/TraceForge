import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { IncidentEvidence } from '@traceforge/contracts';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const memberRole = pgEnum('member_role', ['owner', 'admin', 'member', 'viewer']);
export const alertMetric = pgEnum('alert_metric', [
  'error_rate',
  'p95_latency_ms',
  'p99_latency_ms',
  'request_rate',
]);
export const alertOperator = pgEnum('alert_operator', ['gt', 'lt']);
export const alertSeverity = pgEnum('alert_severity', ['warning', 'critical']);
export const incidentStatus = pgEnum('incident_status', ['firing', 'acknowledged', 'resolved']);
export const incidentResolution = pgEnum('incident_resolution', ['auto', 'manual']);
export const incidentEventType = pgEnum('incident_event_type', [
  'opened',
  'acknowledged',
  'resolved',
  'auto_resolved',
]);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Stored lowercased; uniqueness is therefore case-insensitive. */
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: createdAt(),
});

/** Server-side sessions. Only a SHA-256 of the cookie token is stored, so a database leak cannot be replayed. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: createdAt(),
});

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: memberRole('role').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index('members_user_idx').on(t.userId),
  ],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    isDemo: boolean('is_demo').notNull().default(false),
    createdAt: createdAt(),
    /** Soft delete: telemetry already in ClickHouse is left to expire via TTL. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('projects_workspace_slug_idx').on(t.workspaceId, t.slug)],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** First characters of the key, safe to display so users can tell keys apart. */
    prefix: text('prefix').notNull(),
    /** SHA-256 of the full key. Keys are 256-bit random values, so a fast hash is sufficient. */
    keyHash: text('key_hash').notNull().unique(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('api_keys_project_idx').on(t.projectId)],
);

export const alertRules = pgTable(
  'alert_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    metric: alertMetric('metric').notNull(),
    operator: alertOperator('operator').notNull(),
    threshold: doublePrecision('threshold').notNull(),
    windowMinutes: integer('window_minutes').notNull(),
    minRequests: integer('min_requests').notNull().default(20),
    environment: text('environment'),
    service: text('service'),
    method: text('method'),
    route: text('route'),
    severity: alertSeverity('severity').notNull().default('warning'),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('alert_rules_project_idx').on(t.projectId)],
);

export const alertIncidents = pgTable(
  'alert_incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => alertRules.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    status: incidentStatus('status').notNull().default('firing'),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    acknowledgedBy: uuid('acknowledged_by').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    resolution: incidentResolution('resolution'),
    peakValue: doublePrecision('peak_value').notNull(),
    lastValue: doublePrecision('last_value').notNull(),
    recoveryStreak: integer('recovery_streak').notNull().default(0),
    lastEvaluatedAt: timestamp('last_evaluated_at', { withTimezone: true }),
    /** Latest evidence that the condition held (observed value, window, sample traces). */
    evidence: jsonb('evidence').$type<IncidentEvidence>().notNull(),
    /** Rule name and severity at the time of opening, so history survives rule edits and deletion. */
    ruleSnapshot: jsonb('rule_snapshot')
      .$type<{ name: string; severity: 'warning' | 'critical' }>()
      .notNull(),
  },
  (t) => [
    // The database, not application code, guarantees an active alert never has two incidents.
    uniqueIndex('alert_incidents_one_open_per_rule_idx')
      .on(t.ruleId)
      .where(sql`${t.status} <> 'resolved'`),
    index('alert_incidents_project_opened_idx').on(t.projectId, t.openedAt),
  ],
);

export const incidentEvents = pgTable(
  'incident_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => alertIncidents.id, { onDelete: 'cascade' }),
    type: incidentEventType('type').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index('incident_events_incident_idx').on(t.incidentId, t.at)],
);
