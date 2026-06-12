ALTER TABLE "agents" ADD COLUMN "adapter_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "adapter_config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "skills_enabled" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "routine_policy" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "session_policy" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_executions" ADD COLUMN "runtime_session_id" text;--> statement-breakpoint

UPDATE "agents"
SET "adapter_id" = CASE
  WHEN "provider" = 'local' THEN 'provider:ollama'
  ELSE 'provider:' || "provider"
END
WHERE "adapter_id" IS NULL;--> statement-breakpoint

CREATE TABLE "agent_runtime_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "task_id" text,
  "execution_id" text,
  "environment_id" text,
  "run_id" text NOT NULL,
  "adapter_id" text NOT NULL,
  "adapter_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "mode" text DEFAULT 'on_demand' NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "resume_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "cancellation_reason" text,
  "finalize_required" boolean DEFAULT true NOT NULL,
  "finalized_at" timestamp (3) with time zone,
  "started_at" timestamp (3) with time zone,
  "completed_at" timestamp (3) with time zone,
  "created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "mcp_tool_calls" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "server_id" text NOT NULL,
  "session_id" text,
  "execution_id" text,
  "tool_name" text NOT NULL,
  "arguments" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "result" jsonb,
  "status" text DEFAULT 'started' NOT NULL,
  "is_error" boolean DEFAULT false NOT NULL,
  "error" text,
  "started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp (3) with time zone
);--> statement-breakpoint

CREATE TABLE "company_skills" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "name" text NOT NULL,
  "version" text DEFAULT '1.0.0' NOT NULL,
  "source" text DEFAULT 'manual' NOT NULL,
  "provenance" text DEFAULT 'manual' NOT NULL,
  "trust_level" text DEFAULT 'markdown_only' NOT NULL,
  "entrypoint" text,
  "content" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "installed_by_user_id" text,
  "created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "agent_skills" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "skill_id" text NOT NULL,
  "sync_status" text DEFAULT 'pending' NOT NULL,
  "materialized_path" text,
  "last_synced_at" timestamp (3) with time zone,
  "created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "routines" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "agent_id" text,
  "name" text NOT NULL,
  "mode" text DEFAULT 'scheduled' NOT NULL,
  "jarvis_mode" text DEFAULT 'custom' NOT NULL,
  "schedule" text,
  "prompt" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "workspace_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "last_triggered_at" timestamp (3) with time zone,
  "created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "agent_runtime_sessions"
  ADD CONSTRAINT "agent_runtime_sessions_company_id_companies_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_sessions"
  ADD CONSTRAINT "agent_runtime_sessions_agent_id_agents_id_fk"
  FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_sessions"
  ADD CONSTRAINT "agent_runtime_sessions_task_id_tasks_id_fk"
  FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id")
  ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_sessions"
  ADD CONSTRAINT "agent_runtime_sessions_execution_id_agent_executions_id_fk"
  FOREIGN KEY ("execution_id") REFERENCES "public"."agent_executions"("id")
  ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_sessions"
  ADD CONSTRAINT "agent_runtime_sessions_environment_id_execution_environments_id_fk"
  FOREIGN KEY ("environment_id") REFERENCES "public"."execution_environments"("id")
  ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_executions"
  ADD CONSTRAINT "agent_executions_runtime_session_id_agent_runtime_sessions_id_fk"
  FOREIGN KEY ("runtime_session_id") REFERENCES "public"."agent_runtime_sessions"("id")
  ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls"
  ADD CONSTRAINT "mcp_tool_calls_company_id_companies_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls"
  ADD CONSTRAINT "mcp_tool_calls_server_id_mcp_servers_id_fk"
  FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls"
  ADD CONSTRAINT "mcp_tool_calls_session_id_agent_runtime_sessions_id_fk"
  FOREIGN KEY ("session_id") REFERENCES "public"."agent_runtime_sessions"("id")
  ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls"
  ADD CONSTRAINT "mcp_tool_calls_execution_id_agent_executions_id_fk"
  FOREIGN KEY ("execution_id") REFERENCES "public"."agent_executions"("id")
  ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skills"
  ADD CONSTRAINT "company_skills_company_id_companies_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills"
  ADD CONSTRAINT "agent_skills_company_id_companies_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills"
  ADD CONSTRAINT "agent_skills_agent_id_agents_id_fk"
  FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills"
  ADD CONSTRAINT "agent_skills_skill_id_company_skills_id_fk"
  FOREIGN KEY ("skill_id") REFERENCES "public"."company_skills"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines"
  ADD CONSTRAINT "routines_company_id_companies_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines"
  ADD CONSTRAINT "routines_agent_id_agents_id_fk"
  FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id")
  ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "uq_agent_runtime_sessions_run_id" ON "agent_runtime_sessions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_agent_runtime_sessions_company_status" ON "agent_runtime_sessions" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "idx_agent_runtime_sessions_agent" ON "agent_runtime_sessions" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_runtime_sessions_environment" ON "agent_runtime_sessions" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "idx_agent_executions_runtime_session" ON "agent_executions" USING btree ("runtime_session_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_tool_calls_company" ON "mcp_tool_calls" USING btree ("company_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_mcp_tool_calls_session" ON "mcp_tool_calls" USING btree ("session_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_mcp_tool_calls_server" ON "mcp_tool_calls" USING btree ("server_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_company_skills_name_version" ON "company_skills" USING btree ("company_id","name","version");--> statement-breakpoint
CREATE INDEX "idx_company_skills_company" ON "company_skills" USING btree ("company_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_skills_agent_skill" ON "agent_skills" USING btree ("agent_id","skill_id");--> statement-breakpoint
CREATE INDEX "idx_agent_skills_company_agent" ON "agent_skills" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE INDEX "idx_routines_company_enabled" ON "routines" USING btree ("company_id","enabled");--> statement-breakpoint
CREATE INDEX "idx_routines_agent" ON "routines" USING btree ("agent_id");--> statement-breakpoint

ALTER TABLE public.agent_runtime_sessions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.mcp_tool_calls         ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.company_skills         ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.agent_skills           ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.routines               ENABLE ROW LEVEL SECURITY;
