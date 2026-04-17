import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@eidolon/db';
import type { DbInstance } from './types.js';
import { createApp } from './app.js';

/**
 * Create an in-memory SQLite database for testing.
 * Each call returns a completely isolated database so tests do not interfere
 * with one another.
 */
export function createTestDb(): DbInstance {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  sqlite.exec(`
    CREATE TABLE companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      mission TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      budget_monthly_cents INTEGER NOT NULL DEFAULT 0,
      spent_monthly_cents INTEGER NOT NULL DEFAULT 0,
      settings TEXT NOT NULL DEFAULT '{}',
      brand_color TEXT,
      logo_url TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id),
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      title TEXT,
      provider TEXT NOT NULL DEFAULT 'anthropic',
      model TEXT NOT NULL DEFAULT 'claude-opus-4-7',
      status TEXT NOT NULL DEFAULT 'idle',
      reports_to TEXT,
      capabilities TEXT NOT NULL DEFAULT '[]',
      system_prompt TEXT,
      budget_monthly_cents INTEGER NOT NULL DEFAULT 0,
      spent_monthly_cents INTEGER NOT NULL DEFAULT 0,
      last_heartbeat_at INTEGER,
      config TEXT NOT NULL DEFAULT '{}',
      metadata TEXT NOT NULL DEFAULT '{}',
      permissions TEXT NOT NULL DEFAULT '[]',
      api_key_encrypted TEXT,
      api_key_provider TEXT,
      instructions TEXT,
      instructions_format TEXT DEFAULT 'markdown',
      temperature REAL DEFAULT 0.7,
      max_tokens INTEGER DEFAULT 4096,
      tools_enabled TEXT NOT NULL DEFAULT '[]',
      allowed_domains TEXT NOT NULL DEFAULT '[]',
      max_concurrent_tasks INTEGER NOT NULL DEFAULT 1,
      heartbeat_interval_seconds INTEGER NOT NULL DEFAULT 300,
      execution_timeout_seconds INTEGER NOT NULL DEFAULT 600,
      auto_assign_tasks INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_agents_company_status ON agents(company_id, status);

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id),
      project_id TEXT,
      goal_id TEXT,
      parent_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      type TEXT NOT NULL DEFAULT 'feature',
      status TEXT NOT NULL DEFAULT 'backlog',
      priority TEXT NOT NULL DEFAULT 'medium',
      assignee_agent_id TEXT REFERENCES agents(id),
      created_by_agent_id TEXT,
      created_by_user_id TEXT,
      task_number INTEGER,
      identifier TEXT,
      dependencies TEXT NOT NULL DEFAULT '[]',
      estimated_tokens INTEGER,
      actual_tokens INTEGER,
      tags TEXT NOT NULL DEFAULT '[]',
      due_at INTEGER,
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_tasks_company_status ON tasks(company_id, status);

    CREATE TABLE goals (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      level TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned',
      parent_id TEXT,
      owner_agent_id TEXT,
      progress REAL NOT NULL DEFAULT 0,
      target_date INTEGER,
      metrics TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      from_agent_id TEXT NOT NULL,
      to_agent_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      content TEXT NOT NULL,
      message_type TEXT NOT NULL DEFAULT 'text',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE activity_log (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      description TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_activity_log_company ON activity_log(company_id, created_at);

    CREATE TABLE secrets (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id),
      name TEXT NOT NULL,
      value_encrypted TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'local',
      description TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(company_id, name)
    );

    CREATE TABLE cost_events (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      category TEXT NOT NULL DEFAULT 'inference',
      description TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE workflows (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      nodes TEXT NOT NULL DEFAULT '[]',
      edges TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE budget_alerts (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      agent_id TEXT,
      threshold_pct INTEGER NOT NULL,
      channel TEXT NOT NULL DEFAULT 'in_app',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_triggered_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id),
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'planning',
      repo_url TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE heartbeats (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      company_id TEXT NOT NULL REFERENCES companies(id),
      status TEXT NOT NULL,
      task_id TEXT REFERENCES tasks(id),
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      token_usage TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE agent_config_revisions (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      changed_by TEXT,
      changed_keys TEXT NOT NULL DEFAULT '[]',
      before_config TEXT NOT NULL DEFAULT '{}',
      after_config TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE agent_executions (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      task_id TEXT REFERENCES tasks(id),
      status TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_cents INTEGER NOT NULL DEFAULT 0,
      model_used TEXT,
      provider TEXT,
      summary TEXT,
      error TEXT,
      log TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE agent_collaborations (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'delegation',
      from_agent_id TEXT NOT NULL REFERENCES agents(id),
      to_agent_id TEXT NOT NULL REFERENCES agents(id),
      task_id TEXT REFERENCES tasks(id),
      parent_collaboration_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      request_content TEXT NOT NULL,
      response_content TEXT,
      priority TEXT NOT NULL DEFAULT 'medium',
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX idx_agent_collabs_company ON agent_collaborations(company_id);

    CREATE TABLE approvals (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id),
      kind TEXT NOT NULL DEFAULT 'custom',
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT NOT NULL DEFAULT 'medium',
      requested_by_user_id TEXT,
      requested_by_agent_id TEXT REFERENCES agents(id),
      resolved_by_user_id TEXT,
      resolution_note TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      task_id TEXT REFERENCES tasks(id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX idx_approvals_company_status ON approvals(company_id, status);

    CREATE TABLE approval_comments (
      id TEXT PRIMARY KEY,
      approval_id TEXT NOT NULL REFERENCES approvals(id),
      author_user_id TEXT,
      author_agent_id TEXT REFERENCES agents(id),
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_approval_comments_approval ON approval_comments(approval_id, created_at);

    CREATE TABLE inbox_read_states (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      company_id TEXT NOT NULL REFERENCES companies(id),
      item_id TEXT NOT NULL,
      read_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, company_id, item_id)
    );
    CREATE INDEX idx_inbox_read_states_user_company ON inbox_read_states(user_id, company_id);
  `);

  const drizzleDb = drizzle(sqlite);

  return {
    drizzle: drizzleDb,
    schema,
  };
}

/**
 * Create an Express app wired to the given test database instance.
 */
export function createTestApp(db: DbInstance, authMode = 'local_trusted') {
  const previousAuthMode = process.env.AUTH_MODE;
  // CSRF middleware re-reads env per-request; set a dedicated disable flag
  // that outlives createApp's finally block so test supertest calls (which
  // never include an Origin header) aren't rejected as CSRF violations.
  // The CSRF test file overrides this explicitly when it needs enforcement.
  if (authMode === 'local_trusted') {
    process.env.EIDOLON_DISABLE_CSRF = '1';
  } else {
    delete process.env.EIDOLON_DISABLE_CSRF;
  }

  try {
    process.env.AUTH_MODE = authMode;
    return createApp(db);
  } finally {
    if (previousAuthMode === undefined) {
      delete process.env.AUTH_MODE;
    } else {
      process.env.AUTH_MODE = previousAuthMode;
    }
  }
}
