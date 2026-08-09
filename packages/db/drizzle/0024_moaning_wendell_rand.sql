CREATE TYPE "public"."meeting_status" AS ENUM('active', 'archived', 'deleted');--> statement-breakpoint
CREATE TABLE "meeting_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"meeting_id" text NOT NULL,
	"task_id" text NOT NULL,
	"company_id" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"title" text NOT NULL,
	"transcript" text,
	"summary" text,
	"summary_generated_at" timestamp (3) with time zone,
	"summary_generated_by_agent_id" text,
	"occurred_at" timestamp (3) with time zone,
	"status" "meeting_status" DEFAULT 'active' NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	CONSTRAINT "chk_meetings_title_nonempty" CHECK (length(btrim("meetings"."title")) > 0)
);
--> statement-breakpoint
ALTER TABLE "meeting_tasks" ADD CONSTRAINT "meeting_tasks_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_tasks" ADD CONSTRAINT "meeting_tasks_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_tasks" ADD CONSTRAINT "meeting_tasks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_summary_generated_by_agent_id_agents_id_fk" FOREIGN KEY ("summary_generated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_meeting_tasks_meeting_task" ON "meeting_tasks" USING btree ("meeting_id","task_id");--> statement-breakpoint
CREATE INDEX "idx_meeting_tasks_meeting" ON "meeting_tasks" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "idx_meeting_tasks_task" ON "meeting_tasks" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_meeting_tasks_company" ON "meeting_tasks" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "idx_meetings_company_status_updated" ON "meetings" USING btree ("company_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_meetings_company_project" ON "meetings" USING btree ("company_id","project_id");