import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb } from '../test-utils.js';

type AnyDb = ReturnType<typeof createTestDb> extends Promise<infer T> ? T : never;

/** Execute a SQL query and return typed rows (bypasses Drizzle's generic typing). */
async function execRows<T extends Record<string, unknown>>(
  db: AnyDb,
  query: ReturnType<typeof sql>,
): Promise<T[]> {
  const result = await db.drizzle.execute(query);
  return (result as unknown as { rows: T[] }).rows;
}

async function seedCompany(db: AnyDb, name: string) {
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "companies" ("id", "name", "status", "budget_monthly_cents", "spent_monthly_cents", "settings", "created_at", "updated_at")
    VALUES (${id}, ${name}, 'active', 100000, 0, '{}'::jsonb, ${now}, ${now})
  `);
  return id;
}

async function seedProject(db: AnyDb, companyId: string, name: string) {
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "projects" ("id", "company_id", "name", "status", "created_at", "updated_at")
    VALUES (${id}, ${companyId}, ${name}, 'active', ${now}, ${now})
  `);
  return id;
}

async function seedAgent(db: AnyDb, companyId: string, name: string) {
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "agents" ("id", "company_id", "name", "role", "provider", "model", "status", "capabilities", "config", "metadata", "permissions", "tools_enabled", "skills_enabled", "routine_policy", "session_policy", "allowed_domains", "max_concurrent_tasks", "heartbeat_interval_seconds", "execution_timeout_seconds", "auto_assign_tasks", "budget_monthly_cents", "spent_monthly_cents", "created_at", "updated_at")
    VALUES (${id}, ${companyId}, ${name}, 'engineer', 'anthropic', 'claude-sonnet-4-6', 'idle', '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 1, 0, 600, 0, 0, 0, ${now}, ${now})
  `);
  return id;
}

async function seedTask(db: AnyDb, companyId: string) {
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "tasks" ("id", "company_id", "title", "type", "status", "priority", "dependencies", "tags", "created_at", "updated_at")
    VALUES (${id}, ${companyId}, 'Test task', 'feature', 'todo', 'medium', '[]'::jsonb, '[]'::jsonb, ${now}, ${now})
  `);
  return id;
}

async function seedExecution(db: AnyDb, companyId: string, agentId: string) {
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "agent_executions" ("id", "company_id", "agent_id", "status", "started_at", "execution_mode", "created_at", "updated_at")
    VALUES (${id}, ${companyId}, ${agentId}, 'running', ${now}, 'single', ${now}, ${now})
  `);
  return id;
}

// ---------------------------------------------------------------------------
// automation_runs table structure
// ---------------------------------------------------------------------------

describe('migration 0016: automation_runs table structure', () => {
  it('automation_runs table exists with all expected columns', async () => {
    const db = await createTestDb();
    const columns = await execRows<{ column_name: string; data_type: string; is_nullable: string }>(
      db,
      sql`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'automation_runs'
        ORDER BY ordinal_position
      `,
    );

    const columnNames = columns.map((c) => c.column_name);
    const expected = [
      'id',
      'company_id',
      'project_id',
      'automation_type',
      'automation_id',
      'automation_name',
      'trigger_type',
      'trigger_payload',
      'status',
      'task_id',
      'execution_id',
      'session_id',
      'message_id',
      'outcome',
      'error',
      'started_at',
      'completed_at',
      'created_at',
      'updated_at',
    ];
    for (const col of expected) {
      expect(columnNames, `automation_runs should have column ${col}`).toContain(col);
    }
    expect(columns.length, 'automation_runs should have exactly 19 columns').toBe(19);
  });

  it('company_id is NOT NULL text', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ is_nullable: string; data_type: string }>(db, sql`
      SELECT is_nullable, data_type
      FROM information_schema.columns
      WHERE table_name = 'automation_runs' AND column_name = 'company_id'
    `);
    expect(rows[0].is_nullable).toBe('NO');
    expect(rows[0].data_type).toBe('text');
  });

  it('project_id is nullable text', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ is_nullable: string; data_type: string }>(db, sql`
      SELECT is_nullable, data_type
      FROM information_schema.columns
      WHERE table_name = 'automation_runs' AND column_name = 'project_id'
    `);
    expect(rows[0].is_nullable).toBe('YES');
    expect(rows[0].data_type).toBe('text');
  });

  it('trigger_payload is jsonb NOT NULL with default {}', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ is_nullable: string; data_type: string; column_default: string }>(
      db,
      sql`
        SELECT is_nullable, data_type, column_default
        FROM information_schema.columns
        WHERE table_name = 'automation_runs' AND column_name = 'trigger_payload'
      `,
    );
    expect(rows[0].is_nullable).toBe('NO');
    expect(rows[0].data_type).toBe('jsonb');
    expect(rows[0].column_default).toContain('{}');
  });

  it('status defaults to queued and is NOT NULL', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ is_nullable: string; column_default: string }>(db, sql`
      SELECT is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'automation_runs' AND column_name = 'status'
    `);
    expect(rows[0].is_nullable).toBe('NO');
    expect(rows[0].column_default).toContain('queued');
  });

  it('nullable fields (task_id, execution_id, session_id, message_id, outcome, error, started_at, completed_at) are nullable', async () => {
    const db = await createTestDb();
    const nullableCols = [
      'task_id',
      'execution_id',
      'session_id',
      'message_id',
      'outcome',
      'error',
      'started_at',
      'completed_at',
    ];
    for (const col of nullableCols) {
      const rows = await execRows<{ is_nullable: string }>(db, sql`
        SELECT is_nullable
        FROM information_schema.columns
        WHERE table_name = 'automation_runs' AND column_name = ${col}
      `);
      expect(rows[0].is_nullable, `${col} should be nullable`).toBe('YES');
    }
  });

  it('required text fields (automation_type, automation_id, automation_name, trigger_type) are NOT NULL', async () => {
    const db = await createTestDb();
    const requiredCols = ['automation_type', 'automation_id', 'automation_name', 'trigger_type'];
    for (const col of requiredCols) {
      const rows = await execRows<{ is_nullable: string; data_type: string }>(db, sql`
        SELECT is_nullable, data_type
        FROM information_schema.columns
        WHERE table_name = 'automation_runs' AND column_name = ${col}
      `);
      expect(rows[0].is_nullable, `${col} should NOT be nullable`).toBe('NO');
      expect(rows[0].data_type, `${col} should be text`).toBe('text');
    }
  });

  it('timestamps (started_at, completed_at, created_at, updated_at) use timestamp(3) with time zone', async () => {
    const db = await createTestDb();
    const tsCols = ['started_at', 'completed_at', 'created_at', 'updated_at'];
    for (const col of tsCols) {
      const rows = await execRows<{ data_type: string; datetime_precision: string }>(db, sql`
        SELECT data_type, datetime_precision
        FROM information_schema.columns
        WHERE table_name = 'automation_runs' AND column_name = ${col}
      `);
      expect(rows[0].data_type, `${col} should be timestamp with time zone`).toBe(
        'timestamp with time zone',
      );
      expect(Number(rows[0].datetime_precision), `${col} should have precision 3`).toBe(3);
    }
  });
});

// ---------------------------------------------------------------------------
// automation_runs FK constraints
// ---------------------------------------------------------------------------

describe('migration 0016: automation_runs FK constraints', () => {
  it('company_id FK references companies.id ON DELETE cascade', async () => {
    const db = await createTestDb();
    const rows = await execRows<{
      constraint_name: string;
      referenced_table: string;
      on_delete: string;
    }>(db, sql`
      SELECT con.conname AS constraint_name,
             cls.relname AS referenced_table,
             con.confdeltype AS on_delete
      FROM pg_constraint con
      JOIN pg_class cls ON con.confrelid = cls.oid
      WHERE con.contype = 'f'
        AND con.conname = 'automation_runs_company_id_companies_id_fk'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].referenced_table).toBe('companies');
    // confdeltype 'c' = cascade
    expect(rows[0].on_delete).toBe('c');
  });

  it('project_id FK references projects.id ON DELETE set null', async () => {
    const db = await createTestDb();
    const rows = await execRows<{
      referenced_table: string;
      on_delete: string;
    }>(db, sql`
      SELECT cls.relname AS referenced_table,
             con.confdeltype AS on_delete
      FROM pg_constraint con
      JOIN pg_class cls ON con.confrelid = cls.oid
      WHERE con.contype = 'f'
        AND con.conname = 'automation_runs_project_id_projects_id_fk'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].referenced_table).toBe('projects');
    // confdeltype 'n' = set null
    expect(rows[0].on_delete).toBe('n');
  });

  it('task_id FK references tasks.id ON DELETE set null', async () => {
    const db = await createTestDb();
    const rows = await execRows<{
      referenced_table: string;
      on_delete: string;
    }>(db, sql`
      SELECT cls.relname AS referenced_table,
             con.confdeltype AS on_delete
      FROM pg_constraint con
      JOIN pg_class cls ON con.confrelid = cls.oid
      WHERE con.contype = 'f'
        AND con.conname = 'automation_runs_task_id_tasks_id_fk'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].referenced_table).toBe('tasks');
    expect(rows[0].on_delete).toBe('n');
  });

  it('execution_id FK references agent_executions.id ON DELETE set null', async () => {
    const db = await createTestDb();
    const rows = await execRows<{
      referenced_table: string;
      on_delete: string;
    }>(db, sql`
      SELECT cls.relname AS referenced_table,
             con.confdeltype AS on_delete
      FROM pg_constraint con
      JOIN pg_class cls ON con.confrelid = cls.oid
      WHERE con.contype = 'f'
        AND con.conname = 'automation_runs_execution_id_agent_executions_id_fk'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].referenced_table).toBe('agent_executions');
    expect(rows[0].on_delete).toBe('n');
  });

  it('rejects a non-existent company_id via FK constraint', async () => {
    const db = await createTestDb();
    const fakeCompanyId = randomUUID();
    await expect(
      db.drizzle.execute(sql`
        INSERT INTO "automation_runs" ("id", "company_id", "automation_type", "automation_id", "automation_name", "trigger_type")
        VALUES (${randomUUID()}, ${fakeCompanyId}, 'routine', 'r1', 'Test', 'manual')
      `),
    ).rejects.toThrow();
  });

  it('rejects a non-existent project_id via FK constraint', async () => {
    const db = await createTestDb();
    const companyId = await seedCompany(db, 'FK Test Corp');
    const fakeProjectId = randomUUID();
    await expect(
      db.drizzle.execute(sql`
        INSERT INTO "automation_runs" ("id", "company_id", "project_id", "automation_type", "automation_id", "automation_name", "trigger_type")
        VALUES (${randomUUID()}, ${companyId}, ${fakeProjectId}, 'routine', 'r1', 'Test', 'manual')
      `),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// automation_runs indexes
// ---------------------------------------------------------------------------

describe('migration 0016: automation_runs indexes', () => {
  it('idx_automation_runs_company_project_status_created exists with correct columns', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ indexdef: string }>(db, sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'automation_runs' AND indexname = 'idx_automation_runs_company_project_status_created'
    `);
    expect(rows.length).toBe(1);
    const def = rows[0].indexdef;
    expect(def).toContain('company_id');
    expect(def).toContain('project_id');
    expect(def).toContain('status');
    expect(def).toContain('created_at');
    // Extract just the column list (within parentheses) to avoid matching the index name
    const colList = def.slice(def.lastIndexOf('(') + 1, def.lastIndexOf(')'));
    const companyPos = colList.indexOf('company_id');
    const projectPos = colList.indexOf('project_id');
    const statusPos = colList.indexOf('status');
    const createdPos = colList.indexOf('created_at');
    expect(companyPos).toBeLessThan(projectPos);
    expect(projectPos).toBeLessThan(statusPos);
    expect(statusPos).toBeLessThan(createdPos);
  });

  it('idx_automation_runs_company_type_id_created exists with correct columns', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ indexdef: string }>(db, sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'automation_runs' AND indexname = 'idx_automation_runs_company_type_id_created'
    `);
    expect(rows.length).toBe(1);
    const def = rows[0].indexdef;
    expect(def).toContain('company_id');
    expect(def).toContain('automation_type');
    expect(def).toContain('automation_id');
    expect(def).toContain('created_at');
    // Extract just the column list (within parentheses) to avoid matching the index name
    const colList = def.slice(def.lastIndexOf('(') + 1, def.lastIndexOf(')'));
    const companyPos = colList.indexOf('company_id');
    const typePos = colList.indexOf('automation_type');
    const idPos = colList.indexOf('automation_id');
    const createdPos = colList.indexOf('created_at');
    expect(companyPos).toBeLessThan(typePos);
    expect(typePos).toBeLessThan(idPos);
    expect(idPos).toBeLessThan(createdPos);
  });
});

// ---------------------------------------------------------------------------
// automation_runs CRUD: insert and query
// ---------------------------------------------------------------------------

describe('migration 0016: automation_runs insert and query', () => {
  it('can insert a row with all required fields and query it back', async () => {
    const db = await createTestDb();
    const companyId = await seedCompany(db, 'Run Corp');
    const runId = randomUUID();
    const now = new Date();

    await db.drizzle.execute(sql`
      INSERT INTO "automation_runs" ("id", "company_id", "automation_type", "automation_id", "automation_name", "trigger_type", "status", "created_at", "updated_at")
      VALUES (${runId}, ${companyId}, 'routine', 'r1', 'Morning Briefing', 'manual', 'running', ${now}, ${now})
    `);

    const rows = await execRows<{
      automation_type: string;
      automation_id: string;
      automation_name: string;
      trigger_type: string;
      status: string;
    }>(db, sql`
      SELECT automation_type, automation_id, automation_name, trigger_type, status
      FROM "automation_runs" WHERE "id" = ${runId}
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].automation_type).toBe('routine');
    expect(rows[0].automation_id).toBe('r1');
    expect(rows[0].automation_name).toBe('Morning Briefing');
    expect(rows[0].trigger_type).toBe('manual');
    expect(rows[0].status).toBe('running');
  });

  it('defaults trigger_payload to {} and status to queued', async () => {
    const db = await createTestDb();
    const companyId = await seedCompany(db, 'Defaults Corp');
    const runId = randomUUID();
    const now = new Date();

    await db.drizzle.execute(sql`
      INSERT INTO "automation_runs" ("id", "company_id", "automation_type", "automation_id", "automation_name", "trigger_type", "created_at", "updated_at")
      VALUES (${runId}, ${companyId}, 'webhook', 'w1', 'Webhook Run', 'webhook', ${now}, ${now})
    `);

    const rows = await execRows<{ status: string; trigger_payload: string }>(db, sql`
      SELECT status, trigger_payload::text FROM "automation_runs" WHERE "id" = ${runId}
    `);
    expect(rows[0].status).toBe('queued');
    expect(JSON.parse(rows[0].trigger_payload)).toEqual({});
  });

  it('can link task_id and execution_id', async () => {
    const db = await createTestDb();
    const companyId = await seedCompany(db, 'Links Corp');
    const agentId = await seedAgent(db, companyId, 'Link Agent');
    const taskId = await seedTask(db, companyId);
    const executionId = await seedExecution(db, companyId, agentId);
    const runId = randomUUID();
    const now = new Date();

    await db.drizzle.execute(sql`
      INSERT INTO "automation_runs" ("id", "company_id", "automation_type", "automation_id", "automation_name", "trigger_type", "status", "task_id", "execution_id", "session_id", "message_id", "outcome", "created_at", "updated_at")
      VALUES (${runId}, ${companyId}, 'routine', 'r1', 'Linked Run', 'manual', 'completed', ${taskId}, ${executionId}, 'sess-1', 'msg-1', 'task_created', ${now}, ${now})
    `);

    const rows = await execRows<{
      task_id: string;
      execution_id: string;
      session_id: string;
      message_id: string;
      outcome: string;
    }>(db, sql`
      SELECT task_id, execution_id, session_id, message_id, outcome
      FROM "automation_runs" WHERE "id" = ${runId}
    `);
    expect(rows[0].task_id).toBe(taskId);
    expect(rows[0].execution_id).toBe(executionId);
    expect(rows[0].session_id).toBe('sess-1');
    expect(rows[0].message_id).toBe('msg-1');
    expect(rows[0].outcome).toBe('task_created');
  });
});

// ---------------------------------------------------------------------------
// webhooks project_id column
// ---------------------------------------------------------------------------

describe('migration 0016: webhooks project_id column', () => {
  it('webhooks table has project_id column as nullable text', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ is_nullable: string; data_type: string }>(db, sql`
      SELECT is_nullable, data_type
      FROM information_schema.columns
      WHERE table_name = 'webhooks' AND column_name = 'project_id'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].is_nullable).toBe('YES');
    expect(rows[0].data_type).toBe('text');
  });

  it('webhooks project_id FK references projects.id ON DELETE set null', async () => {
    const db = await createTestDb();
    const rows = await execRows<{
      referenced_table: string;
      on_delete: string;
    }>(db, sql`
      SELECT cls.relname AS referenced_table,
             con.confdeltype AS on_delete
      FROM pg_constraint con
      JOIN pg_class cls ON con.confrelid = cls.oid
      WHERE con.contype = 'f'
        AND con.conname = 'webhooks_project_id_projects_id_fk'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].referenced_table).toBe('projects');
    expect(rows[0].on_delete).toBe('n');
  });

  it('idx_webhooks_company_project index exists with correct columns', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ indexdef: string }>(db, sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'webhooks' AND indexname = 'idx_webhooks_company_project'
    `);
    expect(rows.length).toBe(1);
    const def = rows[0].indexdef;
    expect(def).toContain('company_id');
    expect(def).toContain('project_id');
    expect(def).toContain('created_at');
    // Verify column order
    const companyPos = def.indexOf('company_id');
    const projectPos = def.indexOf('project_id');
    const createdPos = def.indexOf('created_at');
    expect(companyPos).toBeLessThan(projectPos);
    expect(projectPos).toBeLessThan(createdPos);
  });

  it('rejects a non-existent project_id on webhooks via FK constraint', async () => {
    const db = await createTestDb();
    const companyId = await seedCompany(db, 'Webhook FK Corp');
    const fakeProjectId = randomUUID();
    await expect(
      db.drizzle.execute(sql`
        INSERT INTO "webhooks" ("id", "company_id", "name", "secret", "project_id")
        VALUES (${randomUUID()}, ${companyId}, 'test', 'secret', ${fakeProjectId})
      `),
    ).rejects.toThrow();
  });

  it('deleting a project sets webhooks.project_id to NULL', async () => {
    const db = await createTestDb();
    const companyId = await seedCompany(db, 'Webhook Del Corp');
    const projectId = await seedProject(db, companyId, 'Doomed Webhook Project');
    const webhookId = randomUUID();
    const now = new Date();

    await db.drizzle.execute(sql`
      INSERT INTO "webhooks" ("id", "company_id", "name", "secret", "project_id", "created_at", "updated_at")
      VALUES (${webhookId}, ${companyId}, 'test', 'secret', ${projectId}, ${now}, ${now})
    `);

    // Verify project_id is set
    const before = await execRows<{ project_id: string | null }>(db, sql`
      SELECT project_id FROM "webhooks" WHERE "id" = ${webhookId}
    `);
    expect(before[0].project_id).toBe(projectId);

    // Delete the project
    await db.drizzle.execute(sql`DELETE FROM "projects" WHERE "id" = ${projectId}`);

    // Verify project_id is now NULL and the webhook still exists
    const after = await execRows<{ project_id: string | null }>(db, sql`
      SELECT project_id FROM "webhooks" WHERE "id" = ${webhookId}
    `);
    expect(after.length).toBe(1);
    expect(after[0].project_id).toBeNull();
  });
});
