CREATE TABLE "automation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"automation_type" text NOT NULL,
	"automation_id" text NOT NULL,
	"automation_name" text NOT NULL,
	"trigger_type" text NOT NULL,
	"trigger_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"task_id" text,
	"execution_id" text,
	"session_id" text,
	"message_id" text,
	"outcome" text,
	"error" text,
	"started_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_execution_id_agent_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."agent_executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_automation_runs_company_project_status_created" ON "automation_runs" USING btree ("company_id","project_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_automation_runs_company_type_id_created" ON "automation_runs" USING btree ("company_id","automation_type","automation_id","created_at");--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_webhooks_company_project" ON "webhooks" USING btree ("company_id","project_id","created_at");