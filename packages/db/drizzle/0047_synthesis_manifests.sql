-- Synthesis manifests for composite runs: require-all/best-effort outcomes
-- and exactly-once synthesis (m4-f08-partial-result-synthesis).
--
-- Forward-only and additive: a new table. No changes to existing enums or
-- constraints.
--
-- run_synthesis_manifests: immutable synthesis manifest records for
-- composite runs. Each composite commits exactly one ordered manifest
-- when its direct children are all terminal. The manifest is ordered by
-- direct-child ordinal/step key and contains accepted result revision/hash
-- or typed unavailable reason (VAL-SUB-051, 052, 053, 064, 065, 066, 111).
--
-- Exactly-once is enforced by a unique constraint on the deterministic key
-- (run_id, approved_plan_revision_id, approved_content_hash,
-- synthesis_ordinal) so concurrent settlement/recovery commits at most one
-- manifest/result/event/terminal outcome (VAL-SUB-065, 111).

CREATE TABLE "run_synthesis_manifests" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"root_run_id" text NOT NULL,
	"approved_plan_revision_id" text NOT NULL,
	"approved_content_hash" text NOT NULL,
	"synthesis_ordinal" integer NOT NULL DEFAULT 1,
	"manifest" jsonb NOT NULL,
	"manifest_hash" text NOT NULL,
	"synthesis_result" jsonb,
	"disclosed_gaps" jsonb,
	"status" text NOT NULL DEFAULT 'started',
	"failure_category" text,
	"failure_code" text,
	"safe_error_message" text,
	"started_event_sequence" bigint,
	"completed_event_sequence" bigint,
	"created_at" timestamp (3) with time zone NOT NULL,
	"completed_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_synthesis_manifests_company_id" ON "run_synthesis_manifests" USING btree ("company_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_synthesis_manifests_key" ON "run_synthesis_manifests" USING btree ("run_id", "approved_plan_revision_id", "approved_content_hash", "synthesis_ordinal");
--> statement-breakpoint
CREATE INDEX "idx_run_synthesis_manifests_run" ON "run_synthesis_manifests" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "idx_run_synthesis_manifests_root" ON "run_synthesis_manifests" USING btree ("root_run_id");
--> statement-breakpoint
CREATE INDEX "idx_run_synthesis_manifests_company_project" ON "run_synthesis_manifests" USING btree ("company_id", "project_id");
--> statement-breakpoint
ALTER TABLE "run_synthesis_manifests" ADD CONSTRAINT "run_synthesis_manifests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_synthesis_manifests" ADD CONSTRAINT "run_synthesis_manifests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_synthesis_manifests" ADD CONSTRAINT "run_synthesis_manifests_run_id_mission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "mission_runs" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_synthesis_manifests" ADD CONSTRAINT "run_synthesis_manifests_approved_plan_revision_id_run_plan_revisions_id_fk" FOREIGN KEY ("approved_plan_revision_id") REFERENCES "run_plan_revisions" ("id") ON DELETE cascade ON UPDATE no action;
