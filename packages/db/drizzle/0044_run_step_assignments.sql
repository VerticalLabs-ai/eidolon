-- Create run_step_assignments table for materializing approved topology
-- into stable child shells and dependencies (VAL-SUB-001, 002, 003, 005).
--
-- Each non-root executable plan node produces exactly one child run and one
-- step assignment. Unique (root_run_id, step_key) prevents a second child per
-- approved step; unique (run_id) ensures one assignment per child run.
--
-- Forward-only and additive: a new table with FK references to existing
-- mission_runs, companies, projects, and run_plan_revisions. No changes to
-- existing table enums or constraints.
CREATE TABLE "run_step_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"root_run_id" text NOT NULL,
	"parent_run_id" text NOT NULL,
	"run_id" text NOT NULL,
	"step_key" text NOT NULL,
	"parent_step_key" text,
	"child_ordinal" integer,
	"node_kind" text NOT NULL,
	"approved_plan_revision_id" text NOT NULL,
	"approved_content_hash" text NOT NULL,
	"assignment_status" text NOT NULL DEFAULT 'pending_dependencies',
	"routing_kind" text,
	"routing_requirements" jsonb,
	"executing_agent_id" text,
	"billing_agent_id" text,
	"budget_allocation_id" text,
	"result_status" text,
	"result_revision" text,
	"result_hash" text,
	"failure_category" text,
	"failure_code" text,
	"safe_error_message" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_step_assignments_company_id" ON "run_step_assignments" USING btree ("company_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_step_assignments_root_step" ON "run_step_assignments" USING btree ("root_run_id", "step_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_step_assignments_run" ON "run_step_assignments" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "idx_run_step_assignments_root" ON "run_step_assignments" USING btree ("root_run_id");
--> statement-breakpoint
CREATE INDEX "idx_run_step_assignments_parent" ON "run_step_assignments" USING btree ("parent_run_id");
--> statement-breakpoint
CREATE INDEX "idx_run_step_assignments_company_project" ON "run_step_assignments" USING btree ("company_id", "project_id");
--> statement-breakpoint
ALTER TABLE "run_step_assignments" ADD CONSTRAINT "run_step_assignments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_step_assignments" ADD CONSTRAINT "run_step_assignments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_step_assignments" ADD CONSTRAINT "run_step_assignments_run_id_mission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "mission_runs" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_step_assignments" ADD CONSTRAINT "run_step_assignments_approved_plan_revision_id_run_plan_revisions_id_fk" FOREIGN KEY ("approved_plan_revision_id") REFERENCES "run_plan_revisions" ("id") ON DELETE cascade ON UPDATE no action;
