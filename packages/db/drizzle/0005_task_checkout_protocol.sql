CREATE TABLE "task_checkouts" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "task_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "execution_id" text NOT NULL,
  "source" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "idempotency_key" text NOT NULL,
  "claimed_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
  "released_at" timestamp (3) with time zone,
  "release_reason" text,
  "created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "task_checkouts"
  ADD CONSTRAINT "task_checkouts_company_id_companies_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_checkouts"
  ADD CONSTRAINT "task_checkouts_task_id_tasks_id_fk"
  FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_checkouts"
  ADD CONSTRAINT "task_checkouts_agent_id_agents_id_fk"
  FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_checkouts"
  ADD CONSTRAINT "task_checkouts_execution_id_agent_executions_id_fk"
  FOREIGN KEY ("execution_id") REFERENCES "public"."agent_executions"("id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "uq_task_checkouts_active_task"
  ON "task_checkouts" USING btree ("company_id","task_id")
  WHERE "status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_task_checkouts_idempotency"
  ON "task_checkouts" USING btree ("company_id","task_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_task_checkouts_execution"
  ON "task_checkouts" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "idx_task_checkouts_agent"
  ON "task_checkouts" USING btree ("company_id","agent_id","status");--> statement-breakpoint

ALTER TABLE public.task_checkouts ENABLE ROW LEVEL SECURITY;
