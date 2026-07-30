ALTER TABLE "agent_executions"
  ADD COLUMN IF NOT EXISTS "updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION set_agent_executions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS "agent_executions_set_updated_at" ON "agent_executions";--> statement-breakpoint
CREATE TRIGGER "agent_executions_set_updated_at"
BEFORE UPDATE ON "agent_executions"
FOR EACH ROW
EXECUTE FUNCTION set_agent_executions_updated_at();
