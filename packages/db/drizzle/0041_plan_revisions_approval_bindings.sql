-- Create run_plan_revisions and run_plan_approval_bindings tables for
-- atomic plan publication and the governance gate (VAL-PLAN-024, 025, 026,
-- 027, 102, 103, 106, 114, 121, 130).
--
-- The run_plan_approval_bindings table includes is_current_authorization
-- (boolean, NOT NULL, default false) and a partial unique index
-- uq_run_plan_approval_bindings_run_current on (run_id) WHERE
-- is_current_authorization = true, so at most one binding per run is the
-- current execution authorization while any number of historical approved
-- bindings coexist as immutable governance records.
--
-- Forward-only and additive; new tables with nullable FKs from
-- mission_runs.current_plan_revision_id and approved_plan_revision_id to
-- run_plan_revisions.id so the existing pointer columns become
-- referentially sound. No changes to existing table enums or constraints.
CREATE TABLE "run_plan_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"revision" integer NOT NULL,
	"parent_revision_id" text,
	"status" text NOT NULL DEFAULT 'proposed',
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"generated_by" jsonb DEFAULT '{}'::jsonb,
	"feedback" text,
	"estimates" jsonb DEFAULT '{}'::jsonb,
	"decided_by_user_id" text,
	"decided_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_plan_revisions_company_id" ON "run_plan_revisions" USING btree ("company_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_plan_revisions_run_revision" ON "run_plan_revisions" USING btree ("run_id", "revision");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_plan_revisions_run_hash" ON "run_plan_revisions" USING btree ("run_id", "content_hash");
--> statement-breakpoint
CREATE INDEX "idx_run_plan_revisions_run_revision" ON "run_plan_revisions" USING btree ("run_id", "revision");
--> statement-breakpoint
CREATE INDEX "idx_run_plan_revisions_company_project" ON "run_plan_revisions" USING btree ("company_id", "project_id");
--> statement-breakpoint
ALTER TABLE "run_plan_revisions" ADD CONSTRAINT "run_plan_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_plan_revisions" ADD CONSTRAINT "run_plan_revisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_plan_revisions" ADD CONSTRAINT "run_plan_revisions_run_id_mission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "mission_runs" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_plan_revisions" ADD CONSTRAINT "run_plan_revisions_parent_revision_id_run_plan_revisions_id_fk" FOREIGN KEY ("parent_revision_id") REFERENCES "run_plan_revisions" ("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "run_plan_approval_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"plan_revision_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"approval_id" text NOT NULL,
	"decision" text,
	"deciding_user_id" text,
	"is_current_authorization" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"decided_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_plan_approval_bindings_company_id" ON "run_plan_approval_bindings" USING btree ("company_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_plan_approval_bindings_approval_id" ON "run_plan_approval_bindings" USING btree ("approval_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_plan_approval_bindings_run_current" ON "run_plan_approval_bindings" USING btree ("run_id") WHERE "is_current_authorization" = true;
--> statement-breakpoint
CREATE INDEX "idx_run_plan_approval_bindings_run" ON "run_plan_approval_bindings" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "idx_run_plan_approval_bindings_revision" ON "run_plan_approval_bindings" USING btree ("plan_revision_id");
--> statement-breakpoint
ALTER TABLE "run_plan_approval_bindings" ADD CONSTRAINT "run_plan_approval_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_plan_approval_bindings" ADD CONSTRAINT "run_plan_approval_bindings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_plan_approval_bindings" ADD CONSTRAINT "run_plan_approval_bindings_run_id_mission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "mission_runs" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_plan_approval_bindings" ADD CONSTRAINT "run_plan_approval_bindings_plan_revision_id_run_plan_revisions_id_fk" FOREIGN KEY ("plan_revision_id") REFERENCES "run_plan_revisions" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_plan_approval_bindings" ADD CONSTRAINT "run_plan_approval_bindings_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "approvals" ("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_runs" ADD CONSTRAINT "mission_runs_current_plan_revision_id_run_plan_revisions_id_fk" FOREIGN KEY ("current_plan_revision_id") REFERENCES "run_plan_revisions" ("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_runs" ADD CONSTRAINT "mission_runs_approved_plan_revision_id_run_plan_revisions_id_fk" FOREIGN KEY ("approved_plan_revision_id") REFERENCES "run_plan_revisions" ("id") ON DELETE no action ON UPDATE no action;
