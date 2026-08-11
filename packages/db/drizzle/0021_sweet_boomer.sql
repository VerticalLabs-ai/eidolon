CREATE TABLE "artifact_folders" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"parent_id" text,
	"name" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifact_folders" ADD CONSTRAINT "artifact_folders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_folders" ADD CONSTRAINT "artifact_folders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_artifact_folders_company" ON "artifact_folders" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "idx_artifact_folders_company_project" ON "artifact_folders" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "idx_artifact_folders_parent" ON "artifact_folders" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_artifact_folders_company_project_parent_name" ON "artifact_folders" USING btree ("company_id",COALESCE("project_id", '<none>'),COALESCE("parent_id", '<root>'),lower("name"));--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_folder_id_artifact_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."artifact_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_folders" ADD CONSTRAINT "artifact_folders_parent_id_artifact_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."artifact_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_artifacts_company_folder" ON "artifacts" USING btree ("company_id","folder_id");