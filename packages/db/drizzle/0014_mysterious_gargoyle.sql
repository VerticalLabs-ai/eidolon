CREATE TABLE "project_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" text,
	"decided_at" timestamp (3) with time zone,
	"rationale" text,
	"plan_id" text,
	"plan_step_id" text,
	"superseded_by_id" text,
	"created_by_user_id" text,
	"created_by_agent_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_plan_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"company_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"step_order" integer NOT NULL,
	"step_type" text DEFAULT 'action' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"gate_approval_id" text,
	"gate_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"completed_by_user_id" text,
	"completed_by_agent_id" text,
	"completed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"task_id" text,
	"created_by_user_id" text,
	"created_by_agent_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "plan_step_id" text;--> statement-breakpoint
ALTER TABLE "project_decisions" ADD CONSTRAINT "project_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_decisions" ADD CONSTRAINT "project_decisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_decisions" ADD CONSTRAINT "project_decisions_plan_id_project_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."project_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_decisions" ADD CONSTRAINT "project_decisions_plan_step_id_project_plan_steps_id_fk" FOREIGN KEY ("plan_step_id") REFERENCES "public"."project_plan_steps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_decisions" ADD CONSTRAINT "project_decisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_plan_steps" ADD CONSTRAINT "project_plan_steps_plan_id_project_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."project_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_plan_steps" ADD CONSTRAINT "project_plan_steps_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_plan_steps" ADD CONSTRAINT "project_plan_steps_gate_approval_id_approvals_id_fk" FOREIGN KEY ("gate_approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_plan_steps" ADD CONSTRAINT "project_plan_steps_completed_by_agent_id_agents_id_fk" FOREIGN KEY ("completed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_plans" ADD CONSTRAINT "project_plans_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_plans" ADD CONSTRAINT "project_plans_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_plans" ADD CONSTRAINT "project_plans_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_plans" ADD CONSTRAINT "project_plans_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_project_decisions_company_project_status" ON "project_decisions" USING btree ("company_id","project_id","status");--> statement-breakpoint
CREATE INDEX "idx_project_decisions_company_project_created" ON "project_decisions" USING btree ("company_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_project_decisions_plan" ON "project_decisions" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "idx_project_plan_steps_plan_order" ON "project_plan_steps" USING btree ("plan_id","step_order");--> statement-breakpoint
CREATE INDEX "idx_project_plan_steps_company_gate" ON "project_plan_steps" USING btree ("company_id","gate_approval_id");--> statement-breakpoint
CREATE INDEX "idx_project_plans_company_project_status" ON "project_plans" USING btree ("company_id","project_id","status");--> statement-breakpoint
CREATE INDEX "idx_project_plans_company_project_created" ON "project_plans" USING btree ("company_id","project_id","created_at");--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_approvals_company_project_status" ON "approvals" USING btree ("company_id","project_id","status");--> statement-breakpoint
CREATE INDEX "idx_approvals_plan_step" ON "approvals" USING btree ("plan_step_id");--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_plan_step_id_project_plan_steps_id_fk" FOREIGN KEY ("plan_step_id") REFERENCES "public"."project_plan_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_decisions" ADD CONSTRAINT "project_decisions_superseded_by_id_project_decisions_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."project_decisions"("id") ON DELETE set null ON UPDATE no action;