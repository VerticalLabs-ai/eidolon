import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '@eidolon/db';
import { createTestApp, createTestDb } from '../test-utils.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = PgDatabase<any, any>;

const sourceMigrations = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/drizzle',
);

/**
 * Create a temporary migrations folder containing migrations up to and
 * including the given migration number. Used for backfill tests that need
 * to seed data BEFORE migration 0011 runs.
 */
async function createMigrationsFolderThrough(lastMigrationNumber: number): Promise<string> {
  const migrationsFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'eidolon-mig-0011-'));
  await fs.mkdir(path.join(migrationsFolder, 'meta'));
  const journal = JSON.parse(
    await fs.readFile(path.join(sourceMigrations, 'meta/_journal.json'), 'utf8'),
  ) as { version: string; dialect: string; entries: Array<Record<string, unknown>> };
  const migrationFiles = (await fs.readdir(sourceMigrations))
    .filter((file) => /^\d{4}_.*\.sql$/.test(file) && Number(file.slice(0, 4)) <= lastMigrationNumber)
    .sort();
  await Promise.all(
    migrationFiles.map((file) =>
      fs.copyFile(path.join(sourceMigrations, file), path.join(migrationsFolder, file)),
    ),
  );
  await fs.writeFile(
    path.join(migrationsFolder, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, lastMigrationNumber + 1) }, null, 2),
  );
  return migrationsFolder;
}

/**
 * Copy migration 0011 into the temp folder and update the journal so the
 * next `migrate()` call applies it.
 */
async function addMigration0011(migrationsFolder: string): Promise<void> {
  const journal = JSON.parse(
    await fs.readFile(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
  ) as { version: string; dialect: string; entries: Array<Record<string, unknown>> };
  const sourceJournal = JSON.parse(
    await fs.readFile(path.join(sourceMigrations, 'meta/_journal.json'), 'utf8'),
  ) as { version: string; dialect: string; entries: Array<Record<string, unknown>> };

  const migration0011File = (await fs.readdir(sourceMigrations)).find(
    (file) => file.startsWith('0011_') && file.endsWith('.sql'),
  );
  if (!migration0011File) {
    throw new Error('Migration 0011 SQL file not found. Run drizzle-kit generate first.');
  }
  await fs.copyFile(
    path.join(sourceMigrations, migration0011File),
    path.join(migrationsFolder, migration0011File),
  );

  const snapshot0011 = (await fs.readdir(path.join(sourceMigrations, 'meta'))).find(
    (file) => file.startsWith('0011_') && file.endsWith('_snapshot.json'),
  );
  if (snapshot0011) {
    await fs.copyFile(
      path.join(sourceMigrations, 'meta', snapshot0011),
      path.join(migrationsFolder, 'meta', snapshot0011),
    );
  }

  await fs.writeFile(
    path.join(migrationsFolder, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: sourceJournal.entries.slice(0, 12) }, null, 2),
  );
}

// ---------------------------------------------------------------------------
// Helpers for seeding common test entities
// ---------------------------------------------------------------------------

/** Execute a SQL query and return typed rows (bypasses Drizzle's generic typing). */
async function execRows<T extends Record<string, unknown>>(db: AnyDb, query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await db.execute(query);
  return (result as unknown as { rows: T[] }).rows;
}

async function seedCompany(db: AnyDb, name: string) {
  const id = randomUUID();
  const now = new Date();
  await db.insert(schema.companies).values({
    id,
    name,
    status: 'active',
    budgetMonthlyCents: 100_000,
    spentMonthlyCents: 0,
    settings: {},
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function seedAgent(db: AnyDb, companyId: string, name: string) {
  const id = randomUUID();
  const now = new Date();
  await db.insert(schema.agents).values({
    id,
    companyId,
    name,
    role: 'engineer',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    status: 'idle',
    capabilities: [],
    config: {},
    metadata: {},
    permissions: [],
    toolsEnabled: [],
    skillsEnabled: [],
    routinePolicy: {},
    sessionPolicy: {},
    allowedDomains: [],
    maxConcurrentTasks: 1,
    heartbeatIntervalSeconds: 0,
    executionTimeoutSeconds: 600,
    autoAssignTasks: 0,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function seedProject(db: AnyDb, companyId: string, name: string) {
  const id = randomUUID();
  const now = new Date();
  await db.insert(schema.projects).values({
    id,
    companyId,
    name,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function seedTask(
  db: AnyDb,
  companyId: string,
  projectId: string | null,
  agentId?: string,
) {
  const id = randomUUID();
  const now = new Date();
  await db.insert(schema.tasks).values({
    id,
    companyId,
    projectId: projectId ?? undefined,
    title: 'Test task',
    type: 'feature',
    status: 'todo',
    priority: 'medium',
    assigneeAgentId: agentId,
    dependencies: [],
    tags: [],
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

// ---------------------------------------------------------------------------
// VAL-MIG-001: All ownership columns are nullable project foreign keys
// ---------------------------------------------------------------------------

describe('VAL-MIG-001: nullable project_id FK on all 7 tables', () => {
  it('has nullable text project_id column on each of the 7 tables', async () => {
    const db = await createTestDb();
    const tables = [
      'knowledge_documents',
      'messages',
      'task_thread_items',
      'agent_executions',
      'workflows',
      'routines',
      'activity_log',
    ];
    for (const table of tables) {
      const rows = await execRows<{ is_nullable: string; data_type: string }>(db.drizzle, sql`
        SELECT is_nullable, data_type
        FROM information_schema.columns
        WHERE table_name = ${table} AND column_name = 'project_id'
      `);
      expect(rows.length, `${table} should have a project_id column`).toBe(1);
      expect(rows[0].is_nullable, `${table}.project_id must be nullable`).toBe('YES');
      expect(rows[0].data_type, `${table}.project_id must be text`).toBe('text');
    }
  });

  it('rejects a non-existent project_id via the FK constraint on each table', async () => {
    const db = await createTestDb();
    const companyId = await seedCompany(db.drizzle, 'FK Test Corp');
    const agentId = await seedAgent(db.drizzle, companyId, 'FK Agent');
    const taskId = await seedTask(db.drizzle, companyId, null, agentId);
    const fakeProjectId = randomUUID();

    // knowledge_documents
    await expect(
      db.drizzle.execute(sql`
        INSERT INTO "knowledge_documents" ("id", "company_id", "title", "content", "project_id")
        VALUES (${randomUUID()}, ${companyId}, 'test', 'test', ${fakeProjectId})
      `),
    ).rejects.toThrow();

    // messages
    await expect(
      db.drizzle.execute(sql`
        INSERT INTO "messages" ("id", "company_id", "from_agent_id", "to_agent_id", "content", "project_id")
        VALUES (${randomUUID()}, ${companyId}, ${agentId}, ${agentId}, 'test', ${fakeProjectId})
      `),
    ).rejects.toThrow();

    // task_thread_items
    await expect(
      db.drizzle.execute(sql`
        INSERT INTO "task_thread_items" ("id", "company_id", "task_id", "kind", "project_id")
        VALUES (${randomUUID()}, ${companyId}, ${taskId}, 'comment', ${fakeProjectId})
      `),
    ).rejects.toThrow();

    // agent_executions
    await expect(
      db.drizzle.execute(sql`
        INSERT INTO "agent_executions" ("id", "company_id", "agent_id", "task_id", "status", "started_at", "execution_mode", "project_id")
        VALUES (${randomUUID()}, ${companyId}, ${agentId}, ${taskId}, 'running', now(), 'single', ${fakeProjectId})
      `),
    ).rejects.toThrow();

    // workflows
    await expect(
      db.drizzle.execute(sql`
        INSERT INTO "workflows" ("id", "company_id", "name", "project_id")
        VALUES (${randomUUID()}, ${companyId}, 'test', ${fakeProjectId})
      `),
    ).rejects.toThrow();

    // routines
    await expect(
      db.drizzle.execute(sql`
        INSERT INTO "routines" ("id", "company_id", "name", "prompt", "project_id")
        VALUES (${randomUUID()}, ${companyId}, 'test', 'test', ${fakeProjectId})
      `),
    ).rejects.toThrow();

    // activity_log
    await expect(
      db.drizzle.execute(sql`
        INSERT INTO "activity_log" ("id", "company_id", "actor_type", "action", "entity_type", "project_id")
        VALUES (${randomUUID()}, ${companyId}, 'system', 'test', 'test', ${fakeProjectId})
      `),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// VAL-MIG-006: Composite ownership indexes exist on every migrated table
// ---------------------------------------------------------------------------

describe('VAL-MIG-006: composite (company_id, project_id, created_at) indexes', () => {
  it('has a composite index on each of the 7 tables with correct column order', async () => {
    const db = await createTestDb();
    const expectedIndexes: Record<string, string> = {
      knowledge_documents: 'idx_knowledge_docs_company_project',
      messages: 'idx_messages_company_project',
      task_thread_items: 'idx_task_thread_items_company_project',
      agent_executions: 'idx_agent_executions_company_project',
      workflows: 'idx_workflows_company_project',
      routines: 'idx_routines_company_project',
      activity_log: 'idx_activity_log_company_project',
    };

    for (const [table, indexName] of Object.entries(expectedIndexes)) {
      const rows = await execRows<{ indexdef: string }>(db.drizzle, sql`
        SELECT indexdef FROM pg_indexes
        WHERE tablename = ${table} AND indexname = ${indexName}
      `);
      expect(rows.length, `${table} should have index ${indexName}`).toBe(1);
      const def = rows[0].indexdef;
      expect(def, `${table} index should include company_id, project_id, created_at`).toContain('company_id');
      expect(def, `${table} index should include project_id`).toContain('project_id');
      expect(def, `${table} index should include created_at`).toContain('created_at');
      // Verify column order: company_id before project_id before created_at
      const companyPos = def.indexOf('company_id');
      const projectPos = def.indexOf('project_id');
      const createdPos = def.indexOf('created_at');
      expect(companyPos, `${table}: company_id must come before project_id`).toBeLessThan(projectPos);
      expect(projectPos, `${table}: project_id must come before created_at`).toBeLessThan(createdPos);
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-MIG-004 & VAL-CROSS-002: Unscoped records remain readable
// ---------------------------------------------------------------------------

describe('VAL-MIG-004 / VAL-CROSS-002: unscoped records remain readable', () => {
  it('records with NULL project_id are returned by company-scoped queries', async () => {
    const db = await createTestDb();
    const app = createTestApp(db);
    const companyId = await seedCompany(db.drizzle, 'Unscoped Corp');

    // Create an unscoped knowledge document via existing API (backward compatible)
    const doc = await request(app)
      .post(`/api/companies/${companyId}/knowledge`)
      .send({ title: 'Unscoped doc', content: 'content' })
      .expect(201);

    // Verify project_id is NULL in the database
    const rows = await execRows<{ project_id: string | null }>(db.drizzle, sql`
      SELECT project_id FROM "knowledge_documents" WHERE "id" = ${doc.body.data.id}
    `);
    expect(rows[0].project_id).toBeNull();

    // List without project filter — should include the unscoped doc (readable)
    const list = await request(app).get(`/api/companies/${companyId}/knowledge`).expect(200);
    expect(list.body.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: doc.body.data.id })]),
    );
  });

  it('records from other companies are excluded', async () => {
    const db = await createTestDb();
    const app = createTestApp(db);
    const companyA = await seedCompany(db.drizzle, 'Company A');
    const companyB = await seedCompany(db.drizzle, 'Company B');

    await request(app)
      .post(`/api/companies/${companyA}/knowledge`)
      .send({ title: 'A doc', content: 'content' })
      .expect(201);
    await request(app)
      .post(`/api/companies/${companyB}/knowledge`)
      .send({ title: 'B doc', content: 'content' })
      .expect(201);

    const listA = await request(app).get(`/api/companies/${companyA}/knowledge`).expect(200);
    expect(listA.body.data.every((d: { companyId: string }) => d.companyId === companyA)).toBe(true);
    expect(listA.body.data).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// VAL-MIG-005 & VAL-CROSS-003: Project deletion nullifies ownership
// ---------------------------------------------------------------------------

describe('VAL-MIG-005 / VAL-CROSS-003: project deletion nullifies project_id', () => {
  it('deleting a project sets project_id to NULL on all referencing rows', async () => {
    const db = await createTestDb();
    const companyId = await seedCompany(db.drizzle, 'Deletion Corp');
    const agentId = await seedAgent(db.drizzle, companyId, 'Deletion Agent');
    const projectId = await seedProject(db.drizzle, companyId, 'Doomed Project');
    const taskId = await seedTask(db.drizzle, companyId, projectId, agentId);
    const now = new Date();

    // Insert records with project_id into all 7 tables
    const knowledgeId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "knowledge_documents" ("id", "company_id", "title", "content", "project_id", "created_at", "updated_at")
      VALUES (${knowledgeId}, ${companyId}, 'test', 'test', ${projectId}, ${now}, ${now})
    `);

    const messageId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "messages" ("id", "company_id", "from_agent_id", "to_agent_id", "content", "project_id", "created_at")
      VALUES (${messageId}, ${companyId}, ${agentId}, ${agentId}, 'test', ${projectId}, ${now})
    `);

    const threadItemId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "task_thread_items" ("id", "company_id", "task_id", "kind", "project_id", "created_at", "updated_at")
      VALUES (${threadItemId}, ${companyId}, ${taskId}, 'comment', ${projectId}, ${now}, ${now})
    `);

    const executionId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "agent_executions" ("id", "company_id", "agent_id", "task_id", "status", "started_at", "execution_mode", "project_id", "created_at", "updated_at")
      VALUES (${executionId}, ${companyId}, ${agentId}, ${taskId}, 'running', ${now}, 'single', ${projectId}, ${now}, ${now})
    `);

    const workflowId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "workflows" ("id", "company_id", "name", "project_id", "created_at", "updated_at")
      VALUES (${workflowId}, ${companyId}, 'test', ${projectId}, ${now}, ${now})
    `);

    const routineId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "routines" ("id", "company_id", "name", "prompt", "project_id", "created_at", "updated_at")
      VALUES (${routineId}, ${companyId}, 'test', 'test', ${projectId}, ${now}, ${now})
    `);

    const activityId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "activity_log" ("id", "company_id", "actor_type", "action", "entity_type", "project_id", "created_at")
      VALUES (${activityId}, ${companyId}, 'system', 'test', 'test', ${projectId}, ${now})
    `);

    // Delete the project
    await db.drizzle.execute(sql`DELETE FROM "projects" WHERE "id" = ${projectId}`);

    // Verify all records still exist with null project_id
    const checks: Array<{ table: string; id: string }> = [
      { table: 'knowledge_documents', id: knowledgeId },
      { table: 'messages', id: messageId },
      { table: 'task_thread_items', id: threadItemId },
      { table: 'agent_executions', id: executionId },
      { table: 'workflows', id: workflowId },
      { table: 'routines', id: routineId },
      { table: 'activity_log', id: activityId },
    ];

    for (const { table, id } of checks) {
      const rows = await execRows<{ project_id: string | null }>(db.drizzle, sql`
        SELECT project_id FROM "${sql.raw(table)}" WHERE "id" = ${id}
      `);
      expect(rows.length, `${table} row should still exist after project deletion`).toBe(1);
      expect(rows[0].project_id, `${table} project_id should be NULL after deletion`).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Backfill tests — require temp migrations folder
// ---------------------------------------------------------------------------

describe('migration 0011 backfill', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  // -------------------------------------------------------------------------
  // VAL-MIG-002: task_thread_items inherit their task project during backfill
  // -------------------------------------------------------------------------

  it('VAL-MIG-002: backfills task_thread_items.project_id from same-company task', async () => {
    const migrationsFolder = await createMigrationsFolderThrough(10);
    tempDirs.push(migrationsFolder);

    const client = new PGlite();
    const db = drizzle(client);
    try {
      await migrate(db, { migrationsFolder });

      const companyA = await seedCompany(db, 'Backfill Company A');
      const companyB = await seedCompany(db, 'Backfill Company B');
      const projectA = await seedProject(db, companyA, 'Project A');
      const projectB = await seedProject(db, companyB, 'Project B');
      const agentA = await seedAgent(db, companyA, 'Agent A');
      const taskA = await seedTask(db, companyA, projectA, agentA);
      const taskB = await seedTask(db, companyB, projectB);

      // Same-company thread item — should be backfilled
      const threadItemA = randomUUID();
      const now = new Date();
      await db.execute(sql`
        INSERT INTO "task_thread_items" ("id", "company_id", "task_id", "kind", "created_at", "updated_at")
        VALUES (${threadItemA}, ${companyA}, ${taskA}, 'comment', ${now}, ${now})
      `);

      // Cross-company thread item — taskB belongs to companyB but we insert with companyA
      // This should NOT be backfilled because company_id mismatch
      const threadItemCross = randomUUID();
      await db.execute(sql`
        INSERT INTO "task_thread_items" ("id", "company_id", "task_id", "kind", "created_at", "updated_at")
        VALUES (${threadItemCross}, ${companyA}, ${taskB}, 'comment', ${now}, ${now})
      `);

      // Apply migration 0011
      await addMigration0011(migrationsFolder);
      await migrate(db, { migrationsFolder });

      // Same-company should be backfilled
      const [rowA] = await db.execute<{ project_id: string | null }>(sql`
        SELECT project_id FROM "task_thread_items" WHERE "id" = ${threadItemA}
      `).then((r) => r.rows as Array<{ project_id: string | null }>);
      expect(rowA.project_id).toBe(projectA);

      // Cross-company should NOT be backfilled (company mismatch prevents join)
      const [rowCross] = await db.execute<{ project_id: string | null }>(sql`
        SELECT project_id FROM "task_thread_items" WHERE "id" = ${threadItemCross}
      `).then((r) => r.rows as Array<{ project_id: string | null }>);
      expect(rowCross.project_id).toBeNull();
    } finally {
      await client.close();
    }
  });

  // -------------------------------------------------------------------------
  // VAL-MIG-003: agent_executions inherit their task project during backfill
  // -------------------------------------------------------------------------

  it('VAL-MIG-003: backfills agent_executions.project_id from same-company task', async () => {
    const migrationsFolder = await createMigrationsFolderThrough(10);
    tempDirs.push(migrationsFolder);

    const client = new PGlite();
    const db = drizzle(client);
    try {
      await migrate(db, { migrationsFolder });

      const companyA = await seedCompany(db, 'Exec Company A');
      const companyB = await seedCompany(db, 'Exec Company B');
      const projectA = await seedProject(db, companyA, 'Exec Project A');
      const projectB = await seedProject(db, companyB, 'Exec Project B');
      const agentA = await seedAgent(db, companyA, 'Exec Agent A');
      const taskA = await seedTask(db, companyA, projectA, agentA);
      const taskB = await seedTask(db, companyB, projectB);

      const now = new Date();

      // Same-company execution with task — should be backfilled
      const execA = randomUUID();
      await db.execute(sql`
        INSERT INTO "agent_executions" ("id", "company_id", "agent_id", "task_id", "status", "started_at", "execution_mode", "created_at", "updated_at")
        VALUES (${execA}, ${companyA}, ${agentA}, ${taskA}, 'running', ${now}, 'single', ${now}, ${now})
      `);

      // Cross-company execution (companyA with taskB) — should NOT be backfilled
      const execCross = randomUUID();
      await db.execute(sql`
        INSERT INTO "agent_executions" ("id", "company_id", "agent_id", "task_id", "status", "started_at", "execution_mode", "created_at", "updated_at")
        VALUES (${execCross}, ${companyA}, ${agentA}, ${taskB}, 'running', ${now}, 'single', ${now}, ${now})
      `);

      // Execution without task_id — should NOT be backfilled
      const execNoTask = randomUUID();
      await db.execute(sql`
        INSERT INTO "agent_executions" ("id", "company_id", "agent_id", "status", "started_at", "execution_mode", "created_at", "updated_at")
        VALUES (${execNoTask}, ${companyA}, ${agentA}, 'running', ${now}, 'single', ${now}, ${now})
      `);

      // Apply migration 0011
      await addMigration0011(migrationsFolder);
      await migrate(db, { migrationsFolder });

      const [rowA] = await db.execute<{ project_id: string | null }>(sql`
        SELECT project_id FROM "agent_executions" WHERE "id" = ${execA}
      `).then((r) => r.rows as Array<{ project_id: string | null }>);
      expect(rowA.project_id).toBe(projectA);

      const [rowCross] = await db.execute<{ project_id: string | null }>(sql`
        SELECT project_id FROM "agent_executions" WHERE "id" = ${execCross}
      `).then((r) => r.rows as Array<{ project_id: string | null }>);
      expect(rowCross.project_id).toBeNull();

      const [rowNoTask] = await db.execute<{ project_id: string | null }>(sql`
        SELECT project_id FROM "agent_executions" WHERE "id" = ${execNoTask}
      `).then((r) => r.rows as Array<{ project_id: string | null }>);
      expect(rowNoTask.project_id).toBeNull();
    } finally {
      await client.close();
    }
  });

  // -------------------------------------------------------------------------
  // VAL-MIG-007: Activity metadata receives best-effort project backfill
  // -------------------------------------------------------------------------

  it('VAL-MIG-007: backfills activity_log.project_id from metadata->>projectId (same-company only)', async () => {
    const migrationsFolder = await createMigrationsFolderThrough(10);
    tempDirs.push(migrationsFolder);

    const client = new PGlite();
    const db = drizzle(client);
    try {
      await migrate(db, { migrationsFolder });

      const companyA = await seedCompany(db, 'Activity Company A');
      const companyB = await seedCompany(db, 'Activity Company B');
      const projectA = await seedProject(db, companyA, 'Activity Project A');
      const projectB = await seedProject(db, companyB, 'Activity Project B');

      const now = new Date();

      // Row 1: metadata has valid same-company projectId → should be backfilled
      const activityValid = randomUUID();
      await db.execute(sql`
        INSERT INTO "activity_log" ("id", "company_id", "actor_type", "action", "entity_type", "metadata", "created_at")
        VALUES (${activityValid}, ${companyA}, 'system', 'test', 'test', ${JSON.stringify({ projectId: projectA })}::jsonb, ${now})
      `);

      // Row 2: metadata has cross-company projectId → should NOT be backfilled
      const activityCross = randomUUID();
      await db.execute(sql`
        INSERT INTO "activity_log" ("id", "company_id", "actor_type", "action", "entity_type", "metadata", "created_at")
        VALUES (${activityCross}, ${companyA}, 'system', 'test', 'test', ${JSON.stringify({ projectId: projectB })}::jsonb, ${now})
      `);

      // Row 3: metadata has no projectId → should NOT be backfilled
      const activityNoProject = randomUUID();
      await db.execute(sql`
        INSERT INTO "activity_log" ("id", "company_id", "actor_type", "action", "entity_type", "metadata", "created_at")
        VALUES (${activityNoProject}, ${companyA}, 'system', 'test', 'test', ${JSON.stringify({ foo: 'bar' })}::jsonb, ${now})
      `);

      // Row 4: metadata has non-existent projectId → should NOT be backfilled
      const activityNonExistent = randomUUID();
      await db.execute(sql`
        INSERT INTO "activity_log" ("id", "company_id", "actor_type", "action", "entity_type", "metadata", "created_at")
        VALUES (${activityNonExistent}, ${companyA}, 'system', 'test', 'test', ${JSON.stringify({ projectId: randomUUID() })}::jsonb, ${now})
      `);

      // Apply migration 0011
      await addMigration0011(migrationsFolder);
      await migrate(db, { migrationsFolder });

      const [rowValid] = await db.execute<{ project_id: string | null }>(sql`
        SELECT project_id FROM "activity_log" WHERE "id" = ${activityValid}
      `).then((r) => r.rows as Array<{ project_id: string | null }>);
      expect(rowValid.project_id).toBe(projectA);

      const [rowCross] = await db.execute<{ project_id: string | null }>(sql`
        SELECT project_id FROM "activity_log" WHERE "id" = ${activityCross}
      `).then((r) => r.rows as Array<{ project_id: string | null }>);
      expect(rowCross.project_id).toBeNull();

      const [rowNoProject] = await db.execute<{ project_id: string | null }>(sql`
        SELECT project_id FROM "activity_log" WHERE "id" = ${activityNoProject}
      `).then((r) => r.rows as Array<{ project_id: string | null }>);
      expect(rowNoProject.project_id).toBeNull();

      const [rowNonExistent] = await db.execute<{ project_id: string | null }>(sql`
        SELECT project_id FROM "activity_log" WHERE "id" = ${activityNonExistent}
      `).then((r) => r.rows as Array<{ project_id: string | null }>);
      expect(rowNonExistent.project_id).toBeNull();
    } finally {
      await client.close();
    }
  });

  // -------------------------------------------------------------------------
  // VAL-MIG-008: Taskless-project tasks do not produce an ownership value
  // -------------------------------------------------------------------------

  it('VAL-MIG-008: null-project tasks yield null project_id on derived tables', async () => {
    const migrationsFolder = await createMigrationsFolderThrough(10);
    tempDirs.push(migrationsFolder);

    const client = new PGlite();
    const db = drizzle(client);
    try {
      await migrate(db, { migrationsFolder });

      const companyA = await seedCompany(db, 'Null Project Corp');
      const agentA = await seedAgent(db, companyA, 'Null Project Agent');
      // Task with null project_id
      const taskNull = await seedTask(db, companyA, null, agentA);

      const now = new Date();

      // Thread item linked to a null-project task
      const threadItem = randomUUID();
      await db.execute(sql`
        INSERT INTO "task_thread_items" ("id", "company_id", "task_id", "kind", "created_at", "updated_at")
        VALUES (${threadItem}, ${companyA}, ${taskNull}, 'comment', ${now}, ${now})
      `);

      // Execution linked to a null-project task
      const execution = randomUUID();
      await db.execute(sql`
        INSERT INTO "agent_executions" ("id", "company_id", "agent_id", "task_id", "status", "started_at", "execution_mode", "created_at", "updated_at")
        VALUES (${execution}, ${companyA}, ${agentA}, ${taskNull}, 'running', ${now}, 'single', ${now}, ${now})
      `);

      // Apply migration 0011
      await addMigration0011(migrationsFolder);
      await migrate(db, { migrationsFolder });

      const [threadRow] = await db.execute<{ project_id: string | null }>(sql`
        SELECT project_id FROM "task_thread_items" WHERE "id" = ${threadItem}
      `).then((r) => r.rows as Array<{ project_id: string | null }>);
      expect(threadRow.project_id).toBeNull();

      const [execRow] = await db.execute<{ project_id: string | null }>(sql`
        SELECT project_id FROM "agent_executions" WHERE "id" = ${execution}
      `).then((r) => r.rows as Array<{ project_id: string | null }>);
      expect(execRow.project_id).toBeNull();
    } finally {
      await client.close();
    }
  });
});
