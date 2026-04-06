CREATE TABLE `activity_log` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`description` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_collaborations` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`type` text DEFAULT 'delegation' NOT NULL,
	`from_agent_id` text NOT NULL,
	`to_agent_id` text NOT NULL,
	`task_id` text,
	`parent_collaboration_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`request_content` text NOT NULL,
	`response_content` text,
	`priority` text DEFAULT 'medium' NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`from_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_agent_collabs_company` ON `agent_collaborations` (`company_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_collabs_to` ON `agent_collaborations` (`to_agent_id`,`status`);--> statement-breakpoint
CREATE TABLE `agent_config_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`changed_by` text,
	`changed_keys` text DEFAULT '[]' NOT NULL,
	`before_config` text DEFAULT '{}' NOT NULL,
	`after_config` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_agent_config_revisions_agent` ON `agent_config_revisions` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`execution_id` text,
	`task_id` text,
	`quality_score` integer,
	`speed_score` integer,
	`cost_efficiency_score` integer,
	`overall_score` integer,
	`evaluator` text DEFAULT 'system' NOT NULL,
	`feedback` text,
	`metrics` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_agent_evaluations_agent` ON `agent_evaluations` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_evaluations_company` ON `agent_evaluations` (`company_id`);--> statement-breakpoint
CREATE TABLE `agent_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`task_id` text,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_cents` integer DEFAULT 0 NOT NULL,
	`model_used` text,
	`provider` text,
	`summary` text,
	`error` text,
	`log` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_agent_executions_company` ON `agent_executions` (`company_id`,`agent_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_files` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`agent_id` text,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`mime_type` text DEFAULT 'text/plain' NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`content` text,
	`storage_type` text DEFAULT 'inline' NOT NULL,
	`parent_id` text,
	`is_directory` integer DEFAULT false NOT NULL,
	`task_id` text,
	`execution_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_agent_files_agent` ON `agent_files` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_files_company` ON `agent_files` (`company_id`);--> statement-breakpoint
CREATE TABLE `agent_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`memory_type` text DEFAULT 'observation' NOT NULL,
	`content` text NOT NULL,
	`importance` integer DEFAULT 5 NOT NULL,
	`source_task_id` text,
	`source_execution_id` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_agent_memories_agent` ON `agent_memories` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_memories_company` ON `agent_memories` (`company_id`,`agent_id`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`title` text,
	`provider` text DEFAULT 'anthropic' NOT NULL,
	`model` text DEFAULT 'claude-sonnet-4-6' NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`reports_to` text,
	`capabilities` text DEFAULT '[]' NOT NULL,
	`system_prompt` text,
	`api_key_encrypted` text,
	`api_key_provider` text,
	`instructions` text,
	`instructions_format` text DEFAULT 'markdown',
	`temperature` real DEFAULT 0.7,
	`max_tokens` integer DEFAULT 4096,
	`tools_enabled` text DEFAULT '[]' NOT NULL,
	`allowed_domains` text DEFAULT '[]' NOT NULL,
	`max_concurrent_tasks` integer DEFAULT 1 NOT NULL,
	`heartbeat_interval_seconds` integer DEFAULT 300 NOT NULL,
	`auto_assign_tasks` integer DEFAULT 0 NOT NULL,
	`budget_monthly_cents` integer DEFAULT 0 NOT NULL,
	`spent_monthly_cents` integer DEFAULT 0 NOT NULL,
	`last_heartbeat_at` integer,
	`config` text DEFAULT '{}' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`permissions` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reports_to`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_agents_company_status` ON `agents` (`company_id`,`status`);--> statement-breakpoint
CREATE TABLE `budget_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`agent_id` text,
	`threshold_percent` integer NOT NULL,
	`triggered` integer DEFAULT false NOT NULL,
	`triggered_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `companies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`mission` text,
	`status` text DEFAULT 'active' NOT NULL,
	`budget_monthly_cents` integer DEFAULT 0 NOT NULL,
	`spent_monthly_cents` integer DEFAULT 0 NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`brand_color` text,
	`logo_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `company_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`category` text DEFAULT 'general' NOT NULL,
	`author` text,
	`version` text DEFAULT '1.0.0' NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`agent_count` integer DEFAULT 0 NOT NULL,
	`is_public` integer DEFAULT 0 NOT NULL,
	`download_count` integer DEFAULT 0 NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`preview_image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_company_templates_category` ON `company_templates` (`category`);--> statement-breakpoint
CREATE TABLE `cost_events` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`task_id` text,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_cents` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`level` text DEFAULT 'company' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`parent_id` text,
	`owner_agent_id` text,
	`progress` integer DEFAULT 0 NOT NULL,
	`target_date` integer,
	`metrics` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `heartbeats` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`company_id` text NOT NULL,
	`status` text NOT NULL,
	`task_id` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`token_usage` text DEFAULT '{}' NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`provider` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`credentials_encrypted` text,
	`status` text DEFAULT 'active' NOT NULL,
	`last_used_at` integer,
	`usage_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_integrations_company` ON `integrations` (`company_id`);--> statement-breakpoint
CREATE TABLE `knowledge_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`company_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`content` text NOT NULL,
	`token_count` integer DEFAULT 0 NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `knowledge_documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_knowledge_chunks_doc` ON `knowledge_chunks` (`document_id`);--> statement-breakpoint
CREATE INDEX `idx_knowledge_chunks_company` ON `knowledge_chunks` (`company_id`);--> statement-breakpoint
CREATE TABLE `knowledge_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`content_type` text DEFAULT 'markdown' NOT NULL,
	`source` text DEFAULT 'manual',
	`source_url` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`chunk_count` integer DEFAULT 0 NOT NULL,
	`embedding_status` text DEFAULT 'pending' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_knowledge_docs_company` ON `knowledge_documents` (`company_id`);--> statement-breakpoint
CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`transport` text DEFAULT 'stdio' NOT NULL,
	`command` text,
	`args` text DEFAULT '[]' NOT NULL,
	`env` text DEFAULT '{}' NOT NULL,
	`url` text,
	`status` text DEFAULT 'disconnected' NOT NULL,
	`available_tools` text DEFAULT '[]' NOT NULL,
	`available_resources` text DEFAULT '[]' NOT NULL,
	`last_connected_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_mcp_servers_company` ON `mcp_servers` (`company_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`from_agent_id` text NOT NULL,
	`to_agent_id` text NOT NULL,
	`type` text DEFAULT 'directive' NOT NULL,
	`subject` text,
	`content` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`thread_id` text,
	`parent_message_id` text,
	`read_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'planning' NOT NULL,
	`repo_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `prompt_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text,
	`name` text NOT NULL,
	`description` text,
	`category` text DEFAULT 'general' NOT NULL,
	`content` text NOT NULL,
	`variables` text DEFAULT '[]' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`is_global` integer DEFAULT 0 NOT NULL,
	`usage_count` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_prompt_templates_company` ON `prompt_templates` (`company_id`);--> statement-breakpoint
CREATE TABLE `prompt_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`version` integer NOT NULL,
	`content` text NOT NULL,
	`change_note` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `prompt_templates`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_prompt_versions_template` ON `prompt_versions` (`template_id`);--> statement-breakpoint
CREATE TABLE `secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`value_encrypted` text NOT NULL,
	`provider` text DEFAULT 'local' NOT NULL,
	`description` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_secrets_company_name` ON `secrets` (`company_id`,`name`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`project_id` text,
	`goal_id` text,
	`parent_id` text,
	`title` text NOT NULL,
	`description` text,
	`type` text DEFAULT 'feature' NOT NULL,
	`status` text DEFAULT 'backlog' NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`assignee_agent_id` text,
	`created_by_agent_id` text,
	`created_by_user_id` text,
	`task_number` integer,
	`identifier` text,
	`dependencies` text DEFAULT '[]' NOT NULL,
	`estimated_tokens` integer,
	`actual_tokens` integer,
	`tags` text DEFAULT '[]' NOT NULL,
	`due_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignee_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_company_status` ON `tasks` (`company_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_company_assignee` ON `tasks` (`company_id`,`assignee_agent_id`);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`secret` text NOT NULL,
	`target_agent_id` text,
	`event_type` text DEFAULT 'task.create' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_triggered_at` integer,
	`trigger_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_webhooks_company` ON `webhooks` (`company_id`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`nodes` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
