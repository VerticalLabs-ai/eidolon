-- Create run_question_answers table for all-or-nothing answer validation
-- and exact-context resume (VAL-MODEQ-055, 056, 057, 062, 063, 064, 065,
-- 066, 067, 069).
--
-- Forward-only and additive; new table with no changes to existing table
-- enums or constraints. Answer rows are immutable and keyed by
-- (question_set_id, question_id, answer_revision).
CREATE TABLE "run_question_answers" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"question_set_id" text NOT NULL,
	"question_id" text NOT NULL,
	"question_key" text NOT NULL,
	"answer_revision" integer NOT NULL DEFAULT 1,
	"value" jsonb,
	"content_hash" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_question_answers_company_id" ON "run_question_answers" USING btree ("company_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_question_answers_set_q_rev" ON "run_question_answers" USING btree ("question_set_id", "question_id", "answer_revision");
--> statement-breakpoint
CREATE INDEX "idx_run_question_answers_set" ON "run_question_answers" USING btree ("question_set_id", "question_key");
--> statement-breakpoint
CREATE INDEX "idx_run_question_answers_run" ON "run_question_answers" USING btree ("run_id");
--> statement-breakpoint
ALTER TABLE "run_question_answers" ADD CONSTRAINT "run_question_answers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_question_answers" ADD CONSTRAINT "run_question_answers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_question_answers" ADD CONSTRAINT "run_question_answers_run_id_mission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "mission_runs" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_question_answers" ADD CONSTRAINT "run_question_answers_question_set_id_run_question_sets_id_fk" FOREIGN KEY ("question_set_id") REFERENCES "run_question_sets" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_question_answers" ADD CONSTRAINT "run_question_answers_question_id_run_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "run_questions" ("id") ON DELETE cascade ON UPDATE no action;
