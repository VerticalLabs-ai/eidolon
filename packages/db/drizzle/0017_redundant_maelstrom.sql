ALTER TABLE "integrations" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "health_status" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "last_health_check_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "health_error" text;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "health_check_method" text;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_integrations_company_project" ON "integrations" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "idx_integrations_company_health" ON "integrations" USING btree ("company_id","health_status");