-- Create run_question_sets and run_questions tables for atomic question
-- publication, replacement, limits, and deadlines (VAL-MODEQ-044, 059, 128,
-- 130, 135, 142, 147, 150).
--
-- Forward-only and additive; new tables with no changes to existing table
-- enums or constraints. A nullable FK from mission_runs.current_question_set_id
-- to run_question_sets.id is added so the pointer is referentially sound.
CREATE TABLE "run_question_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"version" integer NOT NULL DEFAULT 1,
	"status" text NOT NULL DEFAULT 'open',
	"invalidation_reason" text,
	"prompt_context_hash" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"answered_at" timestamp (3) with time zone,
	"invalidated_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_question_sets_company_id" ON "run_question_sets" USING btree ("company_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_question_sets_run_ordinal" ON "run_question_sets" USING btree ("run_id", "ordinal");
--> statement-breakpoint
CREATE INDEX "idx_run_question_sets_run" ON "run_question_sets" USING btree ("run_id", "ordinal");
--> statement-breakpoint
CREATE INDEX "idx_run_question_sets_company_project" ON "run_question_sets" USING btree ("company_id", "project_id");
--> statement-breakpoint
ALTER TABLE "run_question_sets" ADD CONSTRAINT "run_question_sets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_question_sets" ADD CONSTRAINT "run_question_sets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_question_sets" ADD CONSTRAINT "run_question_sets_run_id_mission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "mission_runs" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "run_questions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"question_set_id" text NOT NULL,
	"question_key" text NOT NULL,
	"order" integer NOT NULL,
	"type" text NOT NULL,
	"label" text NOT NULL,
	"help" text,
	"required" integer NOT NULL DEFAULT 0,
	"default_value" jsonb,
	"options" jsonb,
	"validation" jsonb,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_questions_company_id" ON "run_questions" USING btree ("company_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_questions_set_key" ON "run_questions" USING btree ("question_set_id", "question_key");
--> statement-breakpoint
CREATE INDEX "idx_run_questions_set_order" ON "run_questions" USING btree ("question_set_id", "order");
--> statement-breakpoint
CREATE INDEX "idx_run_questions_run" ON "run_questions" USING btree ("run_id");
--> statement-breakpoint
ALTER TABLE "run_questions" ADD CONSTRAINT "run_questions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_questions" ADD CONSTRAINT "run_questions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_questions" ADD CONSTRAINT "run_questions_run_id_mission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "mission_runs" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_questions" ADD CONSTRAINT "run_questions_question_set_id_run_question_sets_id_fk" FOREIGN KEY ("question_set_id") REFERENCES "run_question_sets" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Add FK from mission_runs.current_question_set_id to run_question_sets.
-- Nullable; only set when the run is awaiting_input with an open set.
ALTER TABLE "mission_runs" ADD CONSTRAINT "mission_runs_current_question_set_id_run_question_sets_id_fk" FOREIGN KEY ("current_question_set_id") REFERENCES "run_question_sets" ("id") ON DELETE set null ON UPDATE no action;
