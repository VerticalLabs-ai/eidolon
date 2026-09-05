-- Create run_scheduling_permits table for child execution running permits
-- (VAL-SUB-109) and add child policy columns to run_step_assignments
-- (VAL-SUB-087, VAL-SUB-108).
--
-- Forward-only and additive: a new table plus nullable columns on an
-- existing table. No changes to existing enums or constraints.
--
-- run_scheduling_permits tracks root_running and parent_running permits.
-- Each routed child acquires both permits immediately before active work
-- (transitioning from queued to running) and releases them idempotently on
-- terminalization or awaiting_input. Unique (run_id, permit_kind) ensures
-- one of each kind per run — no double-acquire or double-release.
CREATE TABLE "run_scheduling_permits" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"root_run_id" text NOT NULL,
	"parent_run_id" text NOT NULL,
	"run_id" text NOT NULL,
	"permit_kind" text NOT NULL,
	"status" text NOT NULL DEFAULT 'held',
	"acquired_at" timestamp (3) with time zone NOT NULL,
	"released_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_scheduling_permits_company_id" ON "run_scheduling_permits" USING btree ("company_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_scheduling_permits_run_kind" ON "run_scheduling_permits" USING btree ("run_id", "permit_kind");
--> statement-breakpoint
CREATE INDEX "idx_run_scheduling_permits_root_kind_status" ON "run_scheduling_permits" USING btree ("root_run_id", "permit_kind", "status");
--> statement-breakpoint
CREATE INDEX "idx_run_scheduling_permits_parent_kind_status" ON "run_scheduling_permits" USING btree ("parent_run_id", "permit_kind", "status");
--> statement-breakpoint
CREATE INDEX "idx_run_scheduling_permits_company_project" ON "run_scheduling_permits" USING btree ("company_id", "project_id");
--> statement-breakpoint
ALTER TABLE "run_scheduling_permits" ADD CONSTRAINT "run_scheduling_permits_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_scheduling_permits" ADD CONSTRAINT "run_scheduling_permits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_scheduling_permits" ADD CONSTRAINT "run_scheduling_permits_run_id_mission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "mission_runs" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Add child policy snapshot and admission slot columns to
-- run_step_assignments (VAL-SUB-087, VAL-SUB-108, VAL-SUB-086).
ALTER TABLE "run_step_assignments" ADD COLUMN "child_policy_snapshot_id" text;
--> statement-breakpoint
ALTER TABLE "run_step_assignments" ADD COLUMN "child_policy_content_hash" text;
--> statement-breakpoint
ALTER TABLE "run_step_assignments" ADD COLUMN "admission_slot_held" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "run_step_assignments" ADD CONSTRAINT "run_step_assignments_child_policy_snapshot_id_run_policy_snapshots_id_fk" FOREIGN KEY ("child_policy_snapshot_id") REFERENCES "run_policy_snapshots" ("id") ON DELETE set null ON UPDATE no action;
