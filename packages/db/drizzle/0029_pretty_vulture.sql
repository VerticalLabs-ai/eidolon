CREATE TABLE "budget_allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"root_reservation_id" text NOT NULL,
	"run_id" text NOT NULL,
	"billing_agent_id" text,
	"allocated_cents" integer NOT NULL,
	"settled_cents" integer DEFAULT 0 NOT NULL,
	"released_cents" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"run_id" text NOT NULL,
	"billing_agent_id" text,
	"requested_cents" integer NOT NULL,
	"reserved_cents" integer NOT NULL,
	"settled_cents" integer DEFAULT 0 NOT NULL,
	"released_cents" integer DEFAULT 0 NOT NULL,
	"period_key" text NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"expires_at" timestamp (3) with time zone,
	"terminal_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mission_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"project_thread_id" text NOT NULL,
	"root_run_id" text NOT NULL,
	"parent_run_id" text,
	"retry_of_run_id" text,
	"depth" integer DEFAULT 0 NOT NULL,
	"child_ordinal" integer,
	"initiating_user_id" text,
	"initiating_agent_id" text,
	"executing_agent_id" text,
	"billing_agent_id" text,
	"routing_kind" text DEFAULT 'company_agent' NOT NULL,
	"request_envelope" jsonb NOT NULL,
	"request_content_hash" text NOT NULL,
	"mode_profile_id" text,
	"resolved_mode" text NOT NULL,
	"policy_snapshot_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"state_version" integer DEFAULT 1 NOT NULL,
	"last_event_sequence" bigint DEFAULT 0 NOT NULL,
	"waiting_from_status" text,
	"current_question_set_id" text,
	"current_plan_revision_id" text,
	"approved_plan_revision_id" text,
	"partial_result_policy" text DEFAULT 'require_all' NOT NULL,
	"available_at" timestamp (3) with time zone,
	"lease_owner" text,
	"lease_token" text,
	"lease_expires_at" timestamp (3) with time zone,
	"heartbeat_at" timestamp (3) with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"provider_call_count" integer DEFAULT 0 NOT NULL,
	"descendant_count" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"output_bytes" integer DEFAULT 0 NOT NULL,
	"actual_cost_cents" integer DEFAULT 0 NOT NULL,
	"cancel_requested_at" timestamp (3) with time zone,
	"cancel_requested_by" text,
	"failure_category" text,
	"failure_code" text,
	"safe_error_message" text,
	"started_at" timestamp (3) with time zone,
	"terminal_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_commands" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"run_id" text,
	"type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"expected_state_version" integer,
	"status" text DEFAULT 'received' NOT NULL,
	"result_status_code" integer,
	"result_body" jsonb,
	"error_code" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"applied_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"type" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"command_id" text,
	"actor_type" text,
	"actor_id" text,
	"trace_id" text,
	"occurred_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_policy_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"source_profile" text,
	"source_profile_version" integer,
	"provider" text NOT NULL,
	"adapter_id" text,
	"model" text NOT NULL,
	"reasoning_depth" text,
	"system_prompt_hash" text,
	"instruction_hash" text,
	"tool_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"domain_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"research_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"planning_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approval_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fallback_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"partial_result_policy" text DEFAULT 'require_all' NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "budget_allocations" ADD CONSTRAINT "budget_allocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_allocations" ADD CONSTRAINT "budget_allocations_root_reservation_id_budget_reservations_id_fk" FOREIGN KEY ("root_reservation_id") REFERENCES "public"."budget_reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_allocations" ADD CONSTRAINT "budget_allocations_run_id_mission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mission_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_allocations" ADD CONSTRAINT "budget_allocations_billing_agent_id_agents_id_fk" FOREIGN KEY ("billing_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_run_id_mission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mission_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_billing_agent_id_agents_id_fk" FOREIGN KEY ("billing_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_runs" ADD CONSTRAINT "mission_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_runs" ADD CONSTRAINT "mission_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_runs" ADD CONSTRAINT "mission_runs_project_thread_id_project_threads_id_fk" FOREIGN KEY ("project_thread_id") REFERENCES "public"."project_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_runs" ADD CONSTRAINT "mission_runs_initiating_agent_id_agents_id_fk" FOREIGN KEY ("initiating_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_runs" ADD CONSTRAINT "mission_runs_executing_agent_id_agents_id_fk" FOREIGN KEY ("executing_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_runs" ADD CONSTRAINT "mission_runs_billing_agent_id_agents_id_fk" FOREIGN KEY ("billing_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_runs" ADD CONSTRAINT "mission_runs_policy_snapshot_id_run_policy_snapshots_id_fk" FOREIGN KEY ("policy_snapshot_id") REFERENCES "public"."run_policy_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_commands" ADD CONSTRAINT "run_commands_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_commands" ADD CONSTRAINT "run_commands_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_commands" ADD CONSTRAINT "run_commands_run_id_mission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mission_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_mission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mission_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_command_id_run_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."run_commands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_policy_snapshots" ADD CONSTRAINT "run_policy_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_budget_allocations_run" ON "budget_allocations" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_budget_allocations_root" ON "budget_allocations" USING btree ("root_reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_budget_reservations_run" ON "budget_reservations" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_budget_reservations_company_period" ON "budget_reservations" USING btree ("company_id","period_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mission_runs_company_id" ON "mission_runs" USING btree ("company_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mission_runs_parent_ordinal" ON "mission_runs" USING btree ("parent_run_id","child_ordinal");--> statement-breakpoint
CREATE INDEX "idx_mission_runs_company_project_created" ON "mission_runs" USING btree ("company_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_mission_runs_status_scope" ON "mission_runs" USING btree ("company_id","project_id","status");--> statement-breakpoint
CREATE INDEX "idx_mission_runs_claim" ON "mission_runs" USING btree ("status","available_at","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_commands_start_idempotency" ON "run_commands" USING btree ("company_id","project_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_commands_run_idempotency" ON "run_commands" USING btree ("company_id","run_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_run_commands_run_created" ON "run_commands" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_events_sequence" ON "run_events" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "idx_run_events_run_sequence" ON "run_events" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "idx_run_events_company_project" ON "run_events" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "idx_run_policy_snapshots_content_hash" ON "run_policy_snapshots" USING btree ("content_hash");--> statement-breakpoint
-- Mission lifecycle, scope, immutability, and bounded-record checks.
-- Forward-only and additive; enforced at the database so projections and
-- workers cannot violate the authoritative invariants.
--> statement-breakpoint
ALTER TABLE "mission_runs" ADD CONSTRAINT "chk_mission_runs_terminal_at" CHECK (
  ("status" IN ('completed','failed','cancelled') AND "terminal_at" IS NOT NULL)
  OR
  ("status" NOT IN ('completed','failed','cancelled') AND "terminal_at" IS NULL)
);--> statement-breakpoint
ALTER TABLE "mission_runs" ADD CONSTRAINT "chk_mission_runs_depth_nonneg" CHECK ("depth" >= 0);--> statement-breakpoint
ALTER TABLE "mission_runs" ADD CONSTRAINT "chk_mission_runs_counters_nonneg" CHECK (
  "attempt_count" >= 0 AND "provider_call_count" >= 0 AND "descendant_count" >= 0 AND
  "input_tokens" >= 0 AND "output_tokens" >= 0 AND "output_bytes" >= 0 AND
  "actual_cost_cents" >= 0 AND "state_version" >= 1 AND "last_event_sequence" >= 0
);--> statement-breakpoint
ALTER TABLE "mission_runs" ADD CONSTRAINT "chk_mission_runs_parent_not_self" CHECK (
  "parent_run_id" IS NULL OR "parent_run_id" <> "id"
);--> statement-breakpoint
ALTER TABLE "mission_runs" ADD CONSTRAINT "chk_mission_runs_root_self_for_root" CHECK (
  "parent_run_id" IS NULL AND "root_run_id" = "id"
  OR "parent_run_id" IS NOT NULL
);--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "chk_budget_reservations_nonneg" CHECK (
  "requested_cents" >= 0 AND "reserved_cents" >= 0 AND "settled_cents" >= 0 AND "released_cents" >= 0
);--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "chk_budget_reservations_settled_le_reserved" CHECK (
  "settled_cents" + "released_cents" <= "reserved_cents"
);--> statement-breakpoint
ALTER TABLE "budget_allocations" ADD CONSTRAINT "chk_budget_allocations_nonneg" CHECK (
  "allocated_cents" >= 0 AND "settled_cents" >= 0 AND "released_cents" >= 0
);--> statement-breakpoint
ALTER TABLE "budget_allocations" ADD CONSTRAINT "chk_budget_allocations_settled_le_allocated" CHECK (
  "settled_cents" + "released_cents" <= "allocated_cents"
);--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "chk_run_events_sequence_pos" CHECK ("sequence" > 0);--> statement-breakpoint
ALTER TABLE "run_commands" ADD CONSTRAINT "chk_run_commands_idempotency_key_len" CHECK (
  char_length("idempotency_key") >= 1 AND char_length("idempotency_key") <= 128
);