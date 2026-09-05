CREATE TABLE "run_projection_links" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"surface" text NOT NULL,
	"surface_id" text NOT NULL,
	"surface_key" text NOT NULL,
	"event_type" text,
	"event_sequence" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	"error_message" text,
	"trace_id" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_projection_links" ADD CONSTRAINT "run_projection_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_projection_links" ADD CONSTRAINT "run_projection_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_projection_links" ADD CONSTRAINT "run_projection_links_run_id_mission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mission_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_projection_links_surface_key" ON "run_projection_links" USING btree ("company_id","run_id","surface","surface_key");--> statement-breakpoint
CREATE INDEX "idx_run_projection_links_run" ON "run_projection_links" USING btree ("run_id","surface");--> statement-breakpoint
CREATE INDEX "idx_run_projection_links_status" ON "run_projection_links" USING btree ("company_id","run_id","status");