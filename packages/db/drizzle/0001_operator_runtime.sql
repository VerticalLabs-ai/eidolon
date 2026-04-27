ALTER TABLE "agent_executions" ADD COLUMN "liveness_status" text DEFAULT 'healthy' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_executions" ADD COLUMN "last_useful_action" text;--> statement-breakpoint
ALTER TABLE "agent_executions" ADD COLUMN "next_action_hint" text;--> statement-breakpoint
ALTER TABLE "agent_executions" ADD COLUMN "continuation_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_executions" ADD COLUMN "last_continuation_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "agent_executions" ADD COLUMN "watchdog_last_checked_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "agent_executions" ADD COLUMN "recovery_task_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "default_environment_id" text;--> statement-breakpoint
CREATE TABLE "task_thread_items" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"task_id" text NOT NULL,
	"kind" text DEFAULT 'comment' NOT NULL,
	"author_user_id" text,
	"author_agent_id" text,
	"content" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"interaction_type" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"idempotency_key" text,
	"related_approval_id" text,
	"related_execution_id" text,
	"resolved_by_user_id" text,
	"resolution_note" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp (3) with time zone
);--> statement-breakpoint
CREATE TABLE "task_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"task_id" text NOT NULL,
	"action" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"previous_status" text,
	"reason" text,
	"created_by_user_id" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	"resolved_at" timestamp (3) with time zone
);--> statement-breakpoint
CREATE TABLE "execution_environments" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"provider" text DEFAULT 'local' NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"workspace_path" text,
	"branch_name" text,
	"runtime_url" text,
	"lease_owner_agent_id" text,
	"lease_owner_execution_id" text,
	"leased_at" timestamp (3) with time zone,
	"released_at" timestamp (3) with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "agent_executions" ADD CONSTRAINT "agent_executions_recovery_task_id_tasks_id_fk" FOREIGN KEY ("recovery_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- task_thread_items_company_id_companies_id_fk and task_thread_items_task_id_tasks_id_fk intentionally use NO ACTION:
-- task thread items are audit records and should not be silently removed by parent deletion.
-- task_holds_company_id_companies_id_fk and task_holds_task_id_tasks_id_fk cascade because holds are active control state.
ALTER TABLE "task_thread_items" ADD CONSTRAINT "task_thread_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_thread_items" ADD CONSTRAINT "task_thread_items_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_thread_items" ADD CONSTRAINT "task_thread_items_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_thread_items" ADD CONSTRAINT "task_thread_items_related_approval_id_approvals_id_fk" FOREIGN KEY ("related_approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_thread_items" ADD CONSTRAINT "task_thread_items_related_execution_id_agent_executions_id_fk" FOREIGN KEY ("related_execution_id") REFERENCES "public"."agent_executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_holds" ADD CONSTRAINT "task_holds_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_holds" ADD CONSTRAINT "task_holds_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_environments" ADD CONSTRAINT "execution_environments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_environments" ADD CONSTRAINT "execution_environments_lease_owner_agent_id_agents_id_fk" FOREIGN KEY ("lease_owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_environments" ADD CONSTRAINT "execution_environments_lease_owner_execution_id_agent_executions_id_fk" FOREIGN KEY ("lease_owner_execution_id") REFERENCES "public"."agent_executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_default_environment_id_execution_environments_id_fk" FOREIGN KEY ("default_environment_id") REFERENCES "public"."execution_environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_task_thread_items_task" ON "task_thread_items" USING btree ("company_id","task_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_task_thread_items_status" ON "task_thread_items" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "idx_task_thread_items_payload" ON "task_thread_items" USING gin ("payload");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_task_thread_items_idempotency" ON "task_thread_items" USING btree ("company_id","task_id","idempotency_key") WHERE "idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_task_holds_company_task" ON "task_holds" USING btree ("company_id","task_id");--> statement-breakpoint
CREATE INDEX "idx_task_holds_active" ON "task_holds" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_task_holds_active_action" ON "task_holds" USING btree ("company_id","task_id","action") WHERE "status" = 'active';--> statement-breakpoint
CREATE INDEX "idx_execution_environments_company" ON "execution_environments" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "idx_execution_environments_lease" ON "execution_environments" USING btree ("lease_owner_agent_id");--> statement-breakpoint
CREATE INDEX "idx_execution_environments_execution" ON "execution_environments" USING btree ("lease_owner_execution_id");--> statement-breakpoint
CREATE INDEX "idx_agent_executions_liveness" ON "agent_executions" USING btree ("company_id","liveness_status","watchdog_last_checked_at");
