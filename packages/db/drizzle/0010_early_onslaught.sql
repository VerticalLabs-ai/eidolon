ALTER TABLE "agent_files" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "agent_files" ADD CONSTRAINT "agent_files_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_files_company_project" ON "agent_files" USING btree ("company_id","project_id","created_at");--> statement-breakpoint
-- Best-effort backfill: populate project_id from the linked task's project_id
-- where a task link already exists. tasks.project_id has no FK constraint, so it
-- can hold ids that no longer exist in projects; joining through projects keeps
-- the backfill from violating the new FK, and matching company_id across
-- agent_files/tasks/projects keeps cross-tenant references from being locked in.
-- Rows without a task link (or whose task has no resolvable same-company project)
-- remain NULL (unscoped / backward compatible).
UPDATE "agent_files"
SET "project_id" = "p"."id"
FROM "tasks" "t"
JOIN "projects" "p"
  ON "p"."id" = "t"."project_id"
 AND "p"."company_id" = "t"."company_id"
WHERE "agent_files"."task_id" = "t"."id"
  AND "agent_files"."company_id" = "t"."company_id"
  AND "agent_files"."project_id" IS NULL;