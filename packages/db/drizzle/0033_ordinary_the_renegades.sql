-- Create run_tool_invocations table for tool/external-call effect ledger (VAL-RUN-086).
-- Forward-only and additive; new table with no changes to existing tables.
CREATE TABLE "run_tool_invocations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"step_key" text NOT NULL,
	"attempt" integer NOT NULL,
	"tool_id" text NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"replay_class" text NOT NULL,
	"state" text NOT NULL,
	"args_summary" jsonb,
	"result_summary" jsonb,
	"logical_call_id" text,
	"provider_request_id_hash" text,
	"external_call_id" text,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"trace_id" text,
	"started_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_tool_invocations" ADD CONSTRAINT "run_tool_invocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_tool_invocations" ADD CONSTRAINT "run_tool_invocations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_tool_invocations" ADD CONSTRAINT "run_tool_invocations_run_id_mission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mission_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_tool_invocations_deterministic" ON "run_tool_invocations" USING btree ("run_id","step_key","attempt","tool_id","ordinal");--> statement-breakpoint
CREATE INDEX "idx_run_tool_invocations_run" ON "run_tool_invocations" USING btree ("run_id","state");--> statement-breakpoint
CREATE INDEX "idx_run_tool_invocations_company" ON "run_tool_invocations" USING btree ("company_id","run_id");
