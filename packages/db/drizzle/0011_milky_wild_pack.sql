ALTER TABLE "activity_log" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "agent_executions" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "task_thread_items" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_executions" ADD CONSTRAINT "agent_executions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_thread_items" ADD CONSTRAINT "task_thread_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_activity_log_company_project" ON "activity_log" USING btree ("company_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_executions_company_project" ON "agent_executions" USING btree ("company_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_knowledge_docs_company_project" ON "knowledge_documents" USING btree ("company_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_messages_company_project" ON "messages" USING btree ("company_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_routines_company_project" ON "routines" USING btree ("company_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_task_thread_items_company_project" ON "task_thread_items" USING btree ("company_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_workflows_company_project" ON "workflows" USING btree ("company_id","project_id","created_at");--> statement-breakpoint
-- Backfill task_thread_items.project_id from tasks.project_id via same-company join
-- through projects. tasks.project_id has no FK constraint, so it can hold ids that
-- no longer exist in projects; joining through projects keeps the backfill from
-- violating the new FK, and matching company_id across all three tables keeps
-- cross-tenant references from being locked in. Rows whose task has no
-- resolvable same-company project remain NULL (unscoped / backward compatible).
UPDATE "task_thread_items"
SET "project_id" = "p"."id"
FROM "tasks" "t"
JOIN "projects" "p"
  ON "p"."id" = "t"."project_id"
 AND "p"."company_id" = "t"."company_id"
WHERE "task_thread_items"."task_id" = "t"."id"
  AND "task_thread_items"."company_id" = "t"."company_id"
  AND "task_thread_items"."project_id" IS NULL;--> statement-breakpoint
-- Backfill agent_executions.project_id from tasks.project_id where a task link
-- exists, using the same same-company join pattern. Executions without a task_id
-- or whose task has no resolvable same-company project remain NULL.
UPDATE "agent_executions"
SET "project_id" = "p"."id"
FROM "tasks" "t"
JOIN "projects" "p"
  ON "p"."id" = "t"."project_id"
 AND "p"."company_id" = "t"."company_id"
WHERE "agent_executions"."task_id" = "t"."id"
  AND "agent_executions"."company_id" = "t"."company_id"
  AND "agent_executions"."project_id" IS NULL;--> statement-breakpoint
-- Best-effort backfill activity_log.project_id from metadata->>'projectId'
-- where the extracted id resolves to a project in the same company. Rows with
-- missing, malformed, unresolved, or cross-company metadata remain NULL.
UPDATE "activity_log"
SET "project_id" = "p"."id"
FROM "projects" "p"
WHERE "p"."id" = "activity_log"."metadata"->>'projectId'
  AND "p"."company_id" = "activity_log"."company_id"
  AND "activity_log"."project_id" IS NULL;