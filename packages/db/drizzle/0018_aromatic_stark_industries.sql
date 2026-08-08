CREATE TYPE "public"."artifact_edit_source" AS ENUM('user', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."artifact_status" AS ENUM('active', 'archived', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."artifact_type" AS ENUM('document', 'sheet', 'board', 'slide_deck', 'timeline', 'gallery', 'dashboard', 'app', 'code');--> statement-breakpoint
CREATE TABLE "artifact_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"artifact_id" text NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"edited_by_user_id" text,
	"edited_by_agent_id" text,
	"edit_source" "artifact_edit_source" NOT NULL,
	"message" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_artifact_revisions_version_positive" CHECK ("artifact_revisions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"folder_id" text,
	"type" "artifact_type" NOT NULL,
	"title" text NOT NULL,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_schema_version" integer DEFAULT 1 NOT NULL,
	"status" "artifact_status" DEFAULT 'active' NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" text,
	"last_edited_by_user_id" text,
	"last_edited_by_agent_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	CONSTRAINT "chk_artifacts_version_positive" CHECK ("artifacts"."version" > 0),
	CONSTRAINT "chk_artifacts_schema_version_positive" CHECK ("artifacts"."content_schema_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "task_thread_items" ADD COLUMN "mentions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "artifact_revisions" ADD CONSTRAINT "artifact_revisions_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_revisions" ADD CONSTRAINT "artifact_revisions_edited_by_agent_id_agents_id_fk" FOREIGN KEY ("edited_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_last_edited_by_agent_id_agents_id_fk" FOREIGN KEY ("last_edited_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_artifact_revisions_artifact_version" ON "artifact_revisions" USING btree ("artifact_id","version");--> statement-breakpoint
CREATE INDEX "idx_artifact_revisions_artifact_created" ON "artifact_revisions" USING btree ("artifact_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_artifacts_company_status_updated" ON "artifacts" USING btree ("company_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_artifacts_company_project" ON "artifacts" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "idx_artifacts_company_type" ON "artifacts" USING btree ("company_id","type");