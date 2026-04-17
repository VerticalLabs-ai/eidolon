CREATE TABLE "activity_log" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"description" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_collaborations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"type" text DEFAULT 'delegation' NOT NULL,
	"from_agent_id" text NOT NULL,
	"to_agent_id" text NOT NULL,
	"task_id" text,
	"parent_collaboration_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"request_content" text NOT NULL,
	"response_content" text,
	"priority" text DEFAULT 'medium' NOT NULL,
	"created_at" timestamp (3) NOT NULL,
	"completed_at" timestamp (3)
);
--> statement-breakpoint
CREATE TABLE "agent_config_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"changed_by" text,
	"changed_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"before_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"after_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"execution_id" text,
	"task_id" text,
	"quality_score" integer,
	"speed_score" integer,
	"cost_efficiency_score" integer,
	"overall_score" integer,
	"evaluator" text DEFAULT 'system' NOT NULL,
	"feedback" text,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"task_id" text,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp (3) NOT NULL,
	"completed_at" timestamp (3),
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"model_used" text,
	"provider" text,
	"summary" text,
	"error" text,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_files" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"agent_id" text,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"mime_type" text DEFAULT 'text/plain' NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"content" text,
	"storage_type" text DEFAULT 'inline' NOT NULL,
	"parent_id" text,
	"is_directory" boolean DEFAULT false NOT NULL,
	"task_id" text,
	"execution_id" text,
	"created_at" timestamp (3) NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_memories" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"memory_type" text DEFAULT 'observation' NOT NULL,
	"content" text NOT NULL,
	"importance" integer DEFAULT 5 NOT NULL,
	"source_task_id" text,
	"source_execution_id" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp (3),
	"created_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"title" text,
	"provider" text DEFAULT 'anthropic' NOT NULL,
	"model" text DEFAULT 'claude-sonnet-4-6' NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"reports_to" text,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"system_prompt" text,
	"api_key_encrypted" text,
	"api_key_provider" text,
	"instructions" text,
	"instructions_format" text DEFAULT 'markdown',
	"temperature" double precision DEFAULT 0.7,
	"max_tokens" integer DEFAULT 4096,
	"tools_enabled" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_concurrent_tasks" integer DEFAULT 1 NOT NULL,
	"heartbeat_interval_seconds" integer DEFAULT 300 NOT NULL,
	"execution_timeout_seconds" integer DEFAULT 600 NOT NULL,
	"auto_assign_tasks" integer DEFAULT 0 NOT NULL,
	"budget_monthly_cents" integer DEFAULT 0 NOT NULL,
	"spent_monthly_cents" integer DEFAULT 0 NOT NULL,
	"last_heartbeat_at" timestamp (3),
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp (3) NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"approval_id" text NOT NULL,
	"author_user_id" text,
	"author_agent_id" text,
	"content" text NOT NULL,
	"created_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"kind" text DEFAULT 'custom' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"requested_by_user_id" text,
	"requested_by_agent_id" text,
	"resolved_by_user_id" text,
	"resolution_note" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"task_id" text,
	"created_at" timestamp (3) NOT NULL,
	"updated_at" timestamp (3) NOT NULL,
	"resolved_at" timestamp (3)
);
--> statement-breakpoint
CREATE TABLE "budget_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"agent_id" text,
	"threshold_percent" integer NOT NULL,
	"triggered" boolean DEFAULT false NOT NULL,
	"triggered_at" timestamp (3),
	"created_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"mission" text,
	"status" text DEFAULT 'active' NOT NULL,
	"budget_monthly_cents" integer DEFAULT 0 NOT NULL,
	"spent_monthly_cents" integer DEFAULT 0 NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"brand_color" text,
	"logo_url" text,
	"created_at" timestamp (3) NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text DEFAULT 'general' NOT NULL,
	"author" text,
	"version" text DEFAULT '1.0.0' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"agent_count" integer DEFAULT 0 NOT NULL,
	"is_public" integer DEFAULT 0 NOT NULL,
	"download_count" integer DEFAULT 0 NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preview_image" text,
	"created_at" timestamp (3) NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_events" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"task_id" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"level" text DEFAULT 'company' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"parent_id" text,
	"owner_agent_id" text,
	"progress" integer DEFAULT 0 NOT NULL,
	"target_date" timestamp (3),
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "heartbeats" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"company_id" text NOT NULL,
	"status" text NOT NULL,
	"task_id" text,
	"started_at" timestamp (3) NOT NULL,
	"completed_at" timestamp (3),
	"token_usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_read_states" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"company_id" text NOT NULL,
	"item_id" text NOT NULL,
	"read_at" timestamp (3) NOT NULL,
	"created_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"config" text DEFAULT '{}' NOT NULL,
	"credentials_encrypted" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_used_at" timestamp (3),
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"company_id" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"content_type" text DEFAULT 'markdown' NOT NULL,
	"source" text DEFAULT 'manual',
	"source_url" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"embedding_status" text DEFAULT 'pending' NOT NULL,
	"created_by" text,
	"created_at" timestamp (3) NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"transport" text DEFAULT 'stdio' NOT NULL,
	"command" text,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"env" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"url" text,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"available_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"available_resources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_connected_at" timestamp (3),
	"created_at" timestamp (3) NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"from_agent_id" text NOT NULL,
	"to_agent_id" text NOT NULL,
	"type" text DEFAULT 'directive' NOT NULL,
	"subject" text,
	"content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"thread_id" text,
	"parent_message_id" text,
	"read_at" timestamp (3),
	"created_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'planning' NOT NULL,
	"repo_url" text,
	"created_at" timestamp (3) NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text,
	"name" text NOT NULL,
	"description" text,
	"category" text DEFAULT 'general' NOT NULL,
	"content" text NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_global" integer DEFAULT 0 NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp (3) NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"change_note" text,
	"created_by" text,
	"created_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"value_encrypted" text NOT NULL,
	"provider" text DEFAULT 'local' NOT NULL,
	"description" text,
	"created_by" text,
	"created_at" timestamp (3) NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"goal_id" text,
	"parent_id" text,
	"title" text NOT NULL,
	"description" text,
	"type" text DEFAULT 'feature' NOT NULL,
	"status" text DEFAULT 'backlog' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"assignee_agent_id" text,
	"created_by_agent_id" text,
	"created_by_user_id" text,
	"task_number" integer,
	"identifier" text,
	"dependencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"estimated_tokens" integer,
	"actual_tokens" integer,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"due_at" timestamp (3),
	"started_at" timestamp (3),
	"completed_at" timestamp (3),
	"created_at" timestamp (3) NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"secret" text NOT NULL,
	"target_agent_id" text,
	"event_type" text DEFAULT 'task.create' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_triggered_at" timestamp (3),
	"trigger_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"nodes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp (3) NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_collaborations" ADD CONSTRAINT "agent_collaborations_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_collaborations" ADD CONSTRAINT "agent_collaborations_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_collaborations" ADD CONSTRAINT "agent_collaborations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config_revisions" ADD CONSTRAINT "agent_config_revisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_evaluations" ADD CONSTRAINT "agent_evaluations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_executions" ADD CONSTRAINT "agent_executions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_executions" ADD CONSTRAINT "agent_executions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_files" ADD CONSTRAINT "agent_files_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_files" ADD CONSTRAINT "agent_files_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_reports_to_agents_id_fk" FOREIGN KEY ("reports_to") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_comments" ADD CONSTRAINT "approval_comments_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_comments" ADD CONSTRAINT "approval_comments_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_parent_id_goals_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeats" ADD CONSTRAINT "heartbeats_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeats" ADD CONSTRAINT "heartbeats_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeats" ADD CONSTRAINT "heartbeats_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_read_states" ADD CONSTRAINT "inbox_read_states_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_parent_message_id_messages_id_fk" FOREIGN KEY ("parent_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_template_id_prompt_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."prompt_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_id_tasks_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_collabs_company" ON "agent_collaborations" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "idx_agent_collabs_to" ON "agent_collaborations" USING btree ("to_agent_id","status");--> statement-breakpoint
CREATE INDEX "idx_agent_config_revisions_agent" ON "agent_config_revisions" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_evaluations_agent" ON "agent_evaluations" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_evaluations_company" ON "agent_evaluations" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "idx_agent_executions_company" ON "agent_executions" USING btree ("company_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_files_agent" ON "agent_files" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_files_company" ON "agent_files" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "idx_agent_memories_agent" ON "agent_memories" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_memories_company" ON "agent_memories" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE INDEX "idx_agents_company_status" ON "agents" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "idx_approval_comments_approval" ON "approval_comments" USING btree ("approval_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_approvals_company_status" ON "approvals" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "idx_approvals_task" ON "approvals" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_company_templates_category" ON "company_templates" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inbox_read_states_user_company_item" ON "inbox_read_states" USING btree ("user_id","company_id","item_id");--> statement-breakpoint
CREATE INDEX "idx_inbox_read_states_user_company" ON "inbox_read_states" USING btree ("user_id","company_id");--> statement-breakpoint
CREATE INDEX "idx_integrations_company" ON "integrations" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "idx_knowledge_chunks_doc" ON "knowledge_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "idx_knowledge_chunks_company" ON "knowledge_chunks" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "idx_knowledge_docs_company" ON "knowledge_documents" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_servers_company" ON "mcp_servers" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "idx_prompt_templates_company" ON "prompt_templates" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "idx_prompt_versions_template" ON "prompt_versions" USING btree ("template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_secrets_company_name" ON "secrets" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "idx_tasks_company_status" ON "tasks" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "idx_tasks_company_assignee" ON "tasks" USING btree ("company_id","assignee_agent_id");--> statement-breakpoint
CREATE INDEX "idx_webhooks_company" ON "webhooks" USING btree ("company_id");