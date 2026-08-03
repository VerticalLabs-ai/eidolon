CREATE TABLE "project_outcomes" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reference_url" text,
	"reference_id" text,
	"task_id" text,
	"plan_id" text,
	"plan_step_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" text,
	"completed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_outcomes" ADD CONSTRAINT "project_outcomes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_outcomes" ADD CONSTRAINT "project_outcomes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_outcomes" ADD CONSTRAINT "project_outcomes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_outcomes" ADD CONSTRAINT "project_outcomes_plan_id_project_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."project_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_outcomes" ADD CONSTRAINT "project_outcomes_plan_step_id_project_plan_steps_id_fk" FOREIGN KEY ("plan_step_id") REFERENCES "public"."project_plan_steps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_outcomes" ADD CONSTRAINT "project_outcomes_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_project_outcomes_company_project_type_status" ON "project_outcomes" USING btree ("company_id","project_id","type","status");--> statement-breakpoint
CREATE INDEX "idx_project_outcomes_company_project_created" ON "project_outcomes" USING btree ("company_id","project_id","created_at");