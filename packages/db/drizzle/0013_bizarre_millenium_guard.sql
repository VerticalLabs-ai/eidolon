CREATE TABLE "project_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"type" text DEFAULT 'conversation' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_thread_items" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "task_thread_items" ADD COLUMN "project_thread_id" text;--> statement-breakpoint
ALTER TABLE "project_threads" ADD CONSTRAINT "project_threads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_threads" ADD CONSTRAINT "project_threads_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_threads" ADD CONSTRAINT "project_threads_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_project_threads_company_project_created" ON "project_threads" USING btree ("company_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_project_threads_company_project_status" ON "project_threads" USING btree ("company_id","project_id","status");--> statement-breakpoint
ALTER TABLE "task_thread_items" ADD CONSTRAINT "task_thread_items_project_thread_id_project_threads_id_fk" FOREIGN KEY ("project_thread_id") REFERENCES "public"."project_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_task_thread_items_project_thread" ON "task_thread_items" USING btree ("company_id","project_thread_id","created_at");--> statement-breakpoint
ALTER TABLE "task_thread_items" ADD CONSTRAINT "chk_task_thread_items_task_or_project" CHECK (("task_id" IS NOT NULL) <> ("project_thread_id" IS NOT NULL));