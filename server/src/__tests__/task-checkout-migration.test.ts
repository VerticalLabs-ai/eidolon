import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '@eidolon/db';

const sourceMigrations = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/drizzle',
);

async function createMigrationsFolderThrough(lastMigrationNumber: number): Promise<string> {
  const migrationsFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'eidolon-migrations-'));
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

describe('task checkout lifecycle migration', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('repairs a production schema missing agent execution update timestamps', async () => {
    const migrationsThroughSeven = await createMigrationsFolderThrough(7);
    const migrationsThroughEight = await createMigrationsFolderThrough(8);
    tempDirs.push(migrationsThroughSeven, migrationsThroughEight);

    const client = new PGlite();
    const migrationDb = drizzle(client);
    try {
      await migrate(migrationDb, { migrationsFolder: migrationsThroughSeven });
      await migrationDb.execute(sql`
        DROP TRIGGER IF EXISTS "agent_executions_set_updated_at" ON "agent_executions"
      `);
      await migrationDb.execute(sql`
        ALTER TABLE "agent_executions" DROP COLUMN "updated_at"
      `);

      await migrate(migrationDb, { migrationsFolder: migrationsThroughEight });

      const columns = await migrationDb.execute<{
        data_type: string;
        datetime_precision: number | null;
        is_nullable: string;
        column_default: string | null;
      }>(sql`
        SELECT data_type, datetime_precision, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = 'agent_executions' AND column_name = 'updated_at'
      `);
      const triggers = await migrationDb.execute<{
        action_timing: string;
        event_manipulation: string;
        action_statement: string;
      }>(sql`
        SELECT action_timing, event_manipulation, action_statement
        FROM information_schema.triggers
        WHERE event_object_table = 'agent_executions'
          AND trigger_name = 'agent_executions_set_updated_at'
      `);

      expect(columns.rows).toEqual([
        expect.objectContaining({
          data_type: 'timestamp with time zone',
          datetime_precision: 3,
          is_nullable: 'NO',
          column_default: expect.stringContaining('now()'),
        }),
      ]);
      expect(triggers.rows).toEqual([
        expect.objectContaining({
          action_timing: 'BEFORE',
          event_manipulation: 'UPDATE',
          action_statement: expect.stringContaining('set_agent_executions_updated_at'),
        }),
      ]);

      // The trigger must actually maintain updated_at, not merely exist.
      const companyId = randomUUID();
      const agentId = randomUUID();
      const executionId = randomUUID();
      const staleTimestamp = new Date('2026-01-01T00:00:00.000Z');
      await migrationDb.insert(schema.companies).values({
        id: companyId,
        name: 'Repair Timestamps Corp',
        status: 'active',
        budgetMonthlyCents: 100_000,
        spentMonthlyCents: 0,
        settings: {},
        createdAt: staleTimestamp,
        updatedAt: staleTimestamp,
      });
      await migrationDb.insert(schema.agents).values({
        id: agentId,
        companyId,
        name: 'Repair Timestamps Worker',
        role: 'engineer',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        status: 'working',
        capabilities: [],
        config: {},
        metadata: {},
        permissions: [],
        toolsEnabled: [],
        allowedDomains: [],
        maxConcurrentTasks: 1,
        heartbeatIntervalSeconds: 0,
        executionTimeoutSeconds: 600,
        autoAssignTasks: 1,
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
        createdAt: staleTimestamp,
        updatedAt: staleTimestamp,
      });
      await migrationDb.execute(sql`
        INSERT INTO "agent_executions" ("id", "company_id", "agent_id", "status", "started_at", "execution_mode", "created_at", "updated_at")
        VALUES (${executionId}, ${companyId}, ${agentId}, 'running', ${staleTimestamp}, 'single', ${staleTimestamp}, ${staleTimestamp})
      `);

      await migrationDb.execute(sql`
        UPDATE "agent_executions" SET "status" = 'completed' WHERE "id" = ${executionId}
      `);

      const [execution] = await migrationDb.execute(sql`
        SELECT "updated_at" FROM "agent_executions" WHERE "id" = ${executionId}
      `).then((r) => r.rows as Array<{ updated_at: string }>);
      expect(new Date(execution.updated_at).getTime()).toBeGreaterThan(staleTimestamp.getTime());
    } finally {
      await client.close();
    }
  });

  it('reconciles terminal executions that already have active checkouts', async () => {
    const migrationsFolder = await createMigrationsFolderThrough(5);
    tempDirs.push(migrationsFolder);

    const journal = JSON.parse(
      await fs.readFile(path.join(sourceMigrations, 'meta/_journal.json'), 'utf8'),
    ) as { version: string; dialect: string; entries: Array<Record<string, unknown>> };

    const client = new PGlite();
    const migrationDb = drizzle(client);
    try {
      await migrate(migrationDb, { migrationsFolder });

      const companyId = randomUUID();
      const agentId = randomUUID();
      const taskId = randomUUID();
      const executionId = randomUUID();
      const checkoutId = randomUUID();
      const now = new Date();
      await migrationDb.insert(schema.companies).values({
        id: companyId,
        name: 'Upgrade Checkout Corp',
        status: 'active',
        budgetMonthlyCents: 100_000,
        spentMonthlyCents: 0,
        settings: {},
        createdAt: now,
        updatedAt: now,
      });
      await migrationDb.insert(schema.agents).values({
        id: agentId,
        companyId,
        name: 'Upgrade Worker',
        role: 'engineer',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        status: 'working',
        capabilities: [],
        config: {},
        metadata: {},
        permissions: [],
        toolsEnabled: [],
        allowedDomains: [],
        maxConcurrentTasks: 1,
        heartbeatIntervalSeconds: 0,
        executionTimeoutSeconds: 600,
        autoAssignTasks: 1,
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
        createdAt: now,
        updatedAt: now,
      });
      await migrationDb.insert(schema.tasks).values({
        id: taskId,
        companyId,
        title: 'Existing checked-out work',
        type: 'feature',
        status: 'in_progress',
        priority: 'high',
        assigneeAgentId: agentId,
        dependencies: [],
        tags: [],
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await migrationDb.execute(sql`
        INSERT INTO "agent_executions" ("id", "company_id", "agent_id", "task_id", "status", "started_at", "completed_at", "execution_mode", "created_at", "updated_at")
        VALUES (${executionId}, ${companyId}, ${agentId}, ${taskId}, 'completed', ${now}, ${now}, 'single', ${now}, ${now})
      `);
      await migrationDb.insert(schema.taskCheckouts).values({
        id: checkoutId,
        companyId,
        taskId,
        agentId,
        executionId,
        source: 'api',
        status: 'active',
        idempotencyKey: `upgrade:${executionId}`,
        claimedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      await fs.copyFile(
        path.join(sourceMigrations, '0006_task_checkout_lifecycle_guards.sql'),
        path.join(migrationsFolder, '0006_task_checkout_lifecycle_guards.sql'),
      );
      await fs.writeFile(
        path.join(migrationsFolder, 'meta/_journal.json'),
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, 7) }, null, 2),
      );
      await migrate(migrationDb, { migrationsFolder });

      const [[checkout], [task], [agent]] = await Promise.all([
        migrationDb
          .select()
          .from(schema.taskCheckouts)
          .where(eq(schema.taskCheckouts.id, checkoutId)),
        migrationDb.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)),
        migrationDb.select().from(schema.agents).where(eq(schema.agents.id, agentId)),
      ]);
      const evidenceResult = await migrationDb.execute(sql`
        SELECT "payload" FROM "task_thread_items"
        WHERE "task_id" = ${taskId} AND "related_execution_id" = ${executionId}
      `);
      const evidence = evidenceResult.rows as unknown as Array<{ payload: Record<string, unknown> }>;
      expect(checkout.status).toBe('released');
      expect(task.status).toBe('review');
      expect(agent.status).toBe('idle');
      expect(evidence).toHaveLength(1);
      expect(evidence[0].payload).toMatchObject({
        event: 'task_checkout_released',
        checkoutId,
        executionId,
      });
    } finally {
      await client.close();
    }
  });

  it('backfills lifecycle events for workspaces leased before migration 0007', async () => {
    const migrationsFolder = await createMigrationsFolderThrough(6);
    tempDirs.push(migrationsFolder);
    const journal = JSON.parse(
      await fs.readFile(path.join(sourceMigrations, 'meta/_journal.json'), 'utf8'),
    ) as { version: string; dialect: string; entries: Array<Record<string, unknown>> };
    const client = new PGlite();
    const migrationDb = drizzle(client);
    try {
      await migrate(migrationDb, { migrationsFolder });
      const companyId = randomUUID();
      const agentId = randomUUID();
      const executionId = randomUUID();
      const environmentId = randomUUID();
      const createdAt = new Date('2026-07-01T12:00:00.000Z');
      const leasedAt = new Date('2026-07-30T12:00:00.000Z');
      await migrationDb.insert(schema.companies).values({
        id: companyId,
        name: 'Upgrade Workspace Corp',
        status: 'active',
        budgetMonthlyCents: 100_000,
        spentMonthlyCents: 0,
        settings: {},
        createdAt,
        updatedAt: leasedAt,
      });
      await migrationDb.insert(schema.agents).values({
        id: agentId,
        companyId,
        name: 'Upgrade Workspace Agent',
        role: 'engineer',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        status: 'working',
        capabilities: [],
        config: {},
        metadata: {},
        permissions: [],
        toolsEnabled: [],
        allowedDomains: [],
        maxConcurrentTasks: 1,
        heartbeatIntervalSeconds: 0,
        executionTimeoutSeconds: 600,
        autoAssignTasks: 1,
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
        createdAt,
        updatedAt: leasedAt,
      });
      await migrationDb.execute(sql`
        INSERT INTO "agent_executions" ("id", "company_id", "agent_id", "status", "started_at", "execution_mode", "created_at", "updated_at")
        VALUES (${executionId}, ${companyId}, ${agentId}, 'running', ${leasedAt}, 'single', ${leasedAt}, ${leasedAt})
      `);
      await migrationDb.execute(sql`
        INSERT INTO "execution_environments" (
          "id",
          "company_id",
          "name",
          "provider",
          "status",
          "lease_owner_agent_id",
          "lease_owner_execution_id",
          "leased_at",
          "metadata",
          "created_at",
          "updated_at"
        ) VALUES (
          ${environmentId},
          ${companyId},
          'Existing Leased Workspace',
          'local',
          'leased',
          ${agentId},
          ${executionId},
          ${leasedAt},
          ${JSON.stringify({})}::jsonb,
          ${createdAt},
          ${leasedAt}
        )
      `);

      await fs.copyFile(
        path.join(sourceMigrations, '0007_good_tenebrous.sql'),
        path.join(migrationsFolder, '0007_good_tenebrous.sql'),
      );
      await fs.writeFile(
        path.join(migrationsFolder, 'meta/_journal.json'),
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, 8) }, null, 2),
      );
      await migrate(migrationDb, { migrationsFolder });

      const [[environment], events] = await Promise.all([
        migrationDb
          .select()
          .from(schema.executionEnvironments)
          .where(eq(schema.executionEnvironments.id, environmentId)),
        migrationDb
          .select()
          .from(schema.workspaceLifecycleEvents)
          .where(eq(schema.workspaceLifecycleEvents.environmentId, environmentId)),
      ]);
      expect(environment.leaseId).toEqual(expect.any(String));
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          eventType: 'created',
          leaseId: null,
          actorAgentId: null,
          actorExecutionId: null,
          metadata: { migration: '0007', backfilled: true },
        }),
        expect.objectContaining({
          eventType: 'leased',
          leaseId: environment.leaseId,
          actorAgentId: agentId,
          actorExecutionId: executionId,
          metadata: { migration: '0007', backfilled: true },
        }),
      ]));
      expect(events).toHaveLength(2);
    } finally {
      await client.close();
    }
  });
});
