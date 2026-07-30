CREATE TABLE "workspace_lifecycle_events" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"lease_id" text,
	"event_type" text NOT NULL,
	"actor_agent_id" text,
	"actor_execution_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "execution_environments" ADD COLUMN "lease_id" text;--> statement-breakpoint
ALTER TABLE "execution_environments" ADD COLUMN "lease_heartbeat_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "execution_environments" ADD COLUMN "lease_expires_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "execution_environments" ADD COLUMN "lease_base_sha" text;--> statement-breakpoint
ALTER TABLE "agent_runtime_sessions" ADD COLUMN "environment_lease_id" text;--> statement-breakpoint
UPDATE "execution_environments"
SET
	"lease_id" = gen_random_uuid()::text,
	"lease_heartbeat_at" = COALESCE("leased_at", now()),
	"lease_expires_at" = now() + interval '5 minutes'
WHERE "status" = 'leased' AND "lease_id" IS NULL;--> statement-breakpoint
INSERT INTO "workspace_lifecycle_events" (
	"id",
	"company_id",
	"environment_id",
	"lease_id",
	"event_type",
	"metadata",
	"created_at"
)
SELECT
	gen_random_uuid()::text,
	"environment"."company_id",
	"environment"."id",
	NULL,
	'created',
	jsonb_build_object('migration', '0007', 'backfilled', true),
	"environment"."created_at"
FROM "execution_environments" AS "environment";--> statement-breakpoint
INSERT INTO "workspace_lifecycle_events" (
	"id",
	"company_id",
	"environment_id",
	"lease_id",
	"event_type",
	"actor_agent_id",
	"actor_execution_id",
	"metadata",
	"created_at"
)
SELECT
	gen_random_uuid()::text,
	"environment"."company_id",
	"environment"."id",
	"environment"."lease_id",
	'leased',
	"environment"."lease_owner_agent_id",
	"environment"."lease_owner_execution_id",
	jsonb_build_object('migration', '0007', 'backfilled', true),
	COALESCE("environment"."leased_at", "environment"."lease_heartbeat_at", now())
FROM "execution_environments" AS "environment"
WHERE "environment"."status" = 'leased' AND "environment"."lease_id" IS NOT NULL;--> statement-breakpoint
UPDATE "agent_runtime_sessions" AS "session"
SET "environment_lease_id" = "environment"."lease_id"
FROM "execution_environments" AS "environment"
WHERE
	"session"."environment_id" = "environment"."id"
	AND "environment"."status" = 'leased'
	AND "environment"."lease_id" IS NOT NULL
	AND (
		"session"."execution_id" = "environment"."lease_owner_execution_id"
		OR (
			"session"."execution_id" IS NULL
			AND "environment"."lease_owner_execution_id" IS NULL
		)
	);--> statement-breakpoint
ALTER TABLE "workspace_lifecycle_events" ADD CONSTRAINT "workspace_lifecycle_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_lifecycle_events" ADD CONSTRAINT "workspace_lifecycle_events_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_lifecycle_events" ADD CONSTRAINT "workspace_lifecycle_events_actor_execution_id_agent_executions_id_fk" FOREIGN KEY ("actor_execution_id") REFERENCES "public"."agent_executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_workspace_lifecycle_events_environment" ON "workspace_lifecycle_events" USING btree ("environment_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_workspace_lifecycle_events_company" ON "workspace_lifecycle_events" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_workspace_lifecycle_events_lease" ON "workspace_lifecycle_events" USING btree ("lease_id");--> statement-breakpoint
CREATE INDEX "idx_execution_environments_lease_expiry" ON "execution_environments" USING btree ("company_id","status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_agent_runtime_sessions_environment_lease" ON "agent_runtime_sessions" USING btree ("environment_id","environment_lease_id");--> statement-breakpoint
ALTER TABLE public.workspace_lifecycle_events ENABLE ROW LEVEL SECURITY;
