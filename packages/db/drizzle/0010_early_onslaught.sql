ALTER TABLE "agent_files" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "agent_files" ADD CONSTRAINT "agent_files_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Best-effort backfill: populate project_id from the linked task's project_id
-- where a task link already exists. Rows without a task link (or whose task has
-- no project_id) remain NULL (unscoped / backward compatible).
UPDATE "agent_files"
SET "project_id" = (SELECT "project_id" FROM "tasks" WHERE "tasks"."id" = "agent_files"."task_id")
WHERE "task_id" IS NOT NULL
  AND (SELECT "project_id" FROM "tasks" WHERE "tasks"."id" = "agent_files"."task_id") IS NOT NULL;