ALTER TABLE "agent_executions" ALTER COLUMN "started_at" TYPE timestamp (3) with time zone USING "started_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "agent_executions" ALTER COLUMN "started_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "agent_executions" ALTER COLUMN "completed_at" TYPE timestamp (3) with time zone USING "completed_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "agent_executions" ALTER COLUMN "created_at" TYPE timestamp (3) with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "agent_executions" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "agent_executions" ADD COLUMN "updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_executions" ADD COLUMN "retry_attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_executions" ADD COLUMN "retry_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_executions" ADD COLUMN "retry_due_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "agent_executions" ADD COLUMN "failure_category" text;--> statement-breakpoint
ALTER TABLE "agent_executions" ADD COLUMN "last_event_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "agent_executions" ADD COLUMN "execution_mode" text DEFAULT 'single' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_executions"
  ADD CONSTRAINT "agent_executions_execution_mode_check"
  CHECK ("execution_mode" IN ('single', 'agentic-loop', 'manual', 'recovery'));--> statement-breakpoint
ALTER TABLE "agent_executions" ADD COLUMN "environment_id" text;--> statement-breakpoint
ALTER TABLE "agent_executions"
  ADD CONSTRAINT "agent_executions_retry_status_check"
  CHECK ("retry_status" IN ('none', 'scheduled', 'retrying', 'exhausted', 'released'));--> statement-breakpoint

ALTER TABLE "agent_executions"
  ADD CONSTRAINT "agent_executions_environment_id_execution_environments_id_fk"
  FOREIGN KEY ("environment_id") REFERENCES "public"."execution_environments"("id")
  ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "idx_agent_executions_retry" ON "agent_executions" USING btree ("company_id","retry_status","retry_due_at")
  WHERE "retry_status" IN ('scheduled', 'retrying');--> statement-breakpoint
CREATE INDEX "idx_agent_executions_environment" ON "agent_executions" USING btree ("environment_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION set_agent_executions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- Requires migration role privileges to create triggers on agent_executions.
DROP TRIGGER IF EXISTS "agent_executions_set_updated_at" ON "agent_executions";--> statement-breakpoint
CREATE TRIGGER "agent_executions_set_updated_at"
BEFORE UPDATE ON "agent_executions"
FOR EACH ROW
EXECUTE FUNCTION set_agent_executions_updated_at();
