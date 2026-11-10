CREATE TYPE "public"."alert_metric" AS ENUM('error_rate', 'p95_latency_ms', 'p99_latency_ms', 'request_rate');--> statement-breakpoint
CREATE TYPE "public"."alert_operator" AS ENUM('gt', 'lt');--> statement-breakpoint
CREATE TYPE "public"."alert_severity" AS ENUM('warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."incident_event_type" AS ENUM('opened', 'acknowledged', 'resolved', 'auto_resolved');--> statement-breakpoint
CREATE TYPE "public"."incident_resolution" AS ENUM('auto', 'manual');--> statement-breakpoint
CREATE TYPE "public"."incident_status" AS ENUM('firing', 'acknowledged', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'member', 'viewer');--> statement-breakpoint
CREATE TABLE "alert_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"status" "incident_status" DEFAULT 'firing' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution" "incident_resolution",
	"peak_value" double precision NOT NULL,
	"last_value" double precision NOT NULL,
	"recovery_streak" integer DEFAULT 0 NOT NULL,
	"last_evaluated_at" timestamp with time zone,
	"evidence" jsonb NOT NULL,
	"rule_snapshot" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"metric" "alert_metric" NOT NULL,
	"operator" "alert_operator" NOT NULL,
	"threshold" double precision NOT NULL,
	"window_minutes" integer NOT NULL,
	"min_requests" integer DEFAULT 20 NOT NULL,
	"environment" text,
	"service" text,
	"method" text,
	"route" text,
	"severity" "alert_severity" DEFAULT 'warning' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "incident_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"type" "incident_event_type" NOT NULL,
	"actor_user_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "alert_incidents" ADD CONSTRAINT "alert_incidents_rule_id_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."alert_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_incidents" ADD CONSTRAINT "alert_incidents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_incidents" ADD CONSTRAINT "alert_incidents_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_incidents" ADD CONSTRAINT "alert_incidents_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_incident_id_alert_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."alert_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_incidents_one_open_per_rule_idx" ON "alert_incidents" USING btree ("rule_id") WHERE "alert_incidents"."status" <> 'resolved';--> statement-breakpoint
CREATE INDEX "alert_incidents_project_opened_idx" ON "alert_incidents" USING btree ("project_id","opened_at");--> statement-breakpoint
CREATE INDEX "alert_rules_project_idx" ON "alert_rules" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "api_keys_project_idx" ON "api_keys" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "incident_events_incident_idx" ON "incident_events" USING btree ("incident_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_workspace_slug_idx" ON "projects" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "members_user_idx" ON "workspace_members" USING btree ("user_id");