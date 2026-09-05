-- Subthreads, context isolation, root mirrors, and repair links
-- (m4-f04-subthreads-context-isolation).
--
-- Forward-only and additive: a new table plus nullable columns on an
-- existing table. No changes to existing enums or constraints.
--
-- 1. run_descendant_mirrors: root-local descendant.progressed/v1 mirror
--    events. Each row records that a descendant source event was mirrored
--    to the root run journal as a `descendant.progressed` event. Uniqueness
--    on (root_run_id, descendant_run_id, source_sequence) prevents
--    duplicate mirrors and cycles (VAL-SUB-058, VAL-SUB-092).
--    The per-descendant watermark (MAX(source_sequence)) tracks how far
--    mirroring has progressed for each descendant; root synthesis and
--    terminalization must wait for all relevant terminal watermarks
--    (VAL-SUB-092, VAL-SUB-112).
--
-- 2. project_threads: add is_mission_subthread boolean (nullable, default
--    false) and mission_run_id text (nullable, references mission_runs) so
--    Mission child subthreads are identifiable, read-only guarded
--    (VAL-SUB-102), and excluded from default thread lists unless
--    includeMissionSubthreads=true.

CREATE TABLE "run_descendant_mirrors" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"root_run_id" text NOT NULL,
	"descendant_run_id" text NOT NULL,
	"source_sequence" bigint NOT NULL,
	"source_event_type" text NOT NULL,
	"root_event_sequence" bigint NOT NULL,
	"trace_id" text,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_descendant_mirrors_root_desc_source" ON "run_descendant_mirrors" USING btree ("root_run_id", "descendant_run_id", "source_sequence");
--> statement-breakpoint
CREATE INDEX "idx_run_descendant_mirrors_root_desc" ON "run_descendant_mirrors" USING btree ("root_run_id", "descendant_run_id");
--> statement-breakpoint
CREATE INDEX "idx_run_descendant_mirrors_company_project" ON "run_descendant_mirrors" USING btree ("company_id", "project_id");
--> statement-breakpoint
ALTER TABLE "run_descendant_mirrors" ADD CONSTRAINT "run_descendant_mirrors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_descendant_mirrors" ADD CONSTRAINT "run_descendant_mirrors_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_descendant_mirrors" ADD CONSTRAINT "run_descendant_mirrors_root_run_id_mission_runs_id_fk" FOREIGN KEY ("root_run_id") REFERENCES "mission_runs" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_descendant_mirrors" ADD CONSTRAINT "run_descendant_mirrors_descendant_run_id_mission_runs_id_fk" FOREIGN KEY ("descendant_run_id") REFERENCES "mission_runs" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_threads" ADD COLUMN "is_mission_subthread" boolean DEFAULT false;
--> statement-breakpoint
ALTER TABLE "project_threads" ADD COLUMN "mission_run_id" text;
--> statement-breakpoint
ALTER TABLE "project_threads" ADD CONSTRAINT "project_threads_mission_run_id_mission_runs_id_fk" FOREIGN KEY ("mission_run_id") REFERENCES "mission_runs" ("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_project_threads_mission_run" ON "project_threads" USING btree ("mission_run_id");
