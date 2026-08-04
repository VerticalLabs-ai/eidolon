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

// ---------------------------------------------------------------------------
// integrations new columns
// ---------------------------------------------------------------------------

describe('migration 0017: integrations new columns', () => {
  it('integrations table has all new columns', async () => {
    const db = await createTestDb();
    const newCols = [
      'project_id',
      'health_status',
      'last_health_check_at',
      'health_error',
      'health_check_method',
    ];
    for (const col of newCols) {
      const rows = await execRows<{ column_name: string }>(db, sql`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'integrations' AND column_name = ${col}
      `);
      expect(rows.length, `integrations should have column ${col}`).toBe(1);
    }
  });

  it('project_id is nullable text', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ is_nullable: string; data_type: string }>(db, sql`
      SELECT is_nullable, data_type
      FROM information_schema.columns
      WHERE table_name = 'integrations' AND column_name = 'project_id'
    `);
    expect(rows[0].is_nullable).toBe('YES');
    expect(rows[0].data_type).toBe('text');
  });

  it('health_status is NOT NULL text with default unknown', async () => {
    const db = await createTestDb();
    const rows = await execRows<{
      is_nullable: string;
      data_type: string;
      column_default: string;
    }>(db, sql`
      SELECT is_nullable, data_type, column_default
      FROM information_schema.columns
      WHERE table_name = 'integrations' AND column_name = 'health_status'
    `);
    expect(rows[0].is_nullable).toBe('NO');
    expect(rows[0].data_type).toBe('text');
    expect(rows[0].column_default).toContain('unknown');
  });

  it('last_health_check_at is nullable timestamp(3) with time zone', async () => {
    const db = await createTestDb();
    const rows = await execRows<{
      is_nullable: string;
      data_type: string;
      datetime_precision: string;
    }>(db, sql`
      SELECT is_nullable, data_type, datetime_precision
      FROM information_schema.columns
      WHERE table_name = 'integrations' AND column_name = 'last_health_check_at'
    `);
    expect(rows[0].is_nullable).toBe('YES');
    expect(rows[0].data_type).toBe('timestamp with time zone');
    expect(Number(rows[0].datetime_precision)).toBe(3);
  });

  it('health_error is nullable text', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ is_nullable: string; data_type: string }>(db, sql`
      SELECT is_nullable, data_type
      FROM information_schema.columns
      WHERE table_name = 'integrations' AND column_name = 'health_error'
    `);
    expect(rows[0].is_nullable).toBe('YES');
    expect(rows[0].data_type).toBe('text');
  });

  it('health_check_method is nullable text', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ is_nullable: string; data_type: string }>(db, sql`
      SELECT is_nullable, data_type
      FROM information_schema.columns
      WHERE table_name = 'integrations' AND column_name = 'health_check_method'
    `);
    expect(rows[0].is_nullable).toBe('YES');
    expect(rows[0].data_type).toBe('text');
  });
});

// ---------------------------------------------------------------------------
// integrations health_status default
// ---------------------------------------------------------------------------

describe('migration 0017: health_status default behavior', () => {
  it('inserting a row without health_status defaults to unknown', async () => {
    const db = await createTestDb();
    const companyId = await seedCompany(db, 'Default Health Corp');
    const integrationId = randomUUID();
    const now = new Date();

    await db.drizzle.execute(sql`
      INSERT INTO "integrations" ("id", "company_id", "name", "type", "provider", "status", "created_at", "updated_at")
      VALUES (${integrationId}, ${companyId}, 'Test Integration', 'custom_api', 'custom', 'active', ${now}, ${now})
    `);

    const rows = await execRows<{ health_status: string }>(db, sql`
      SELECT health_status FROM "integrations" WHERE "id" = ${integrationId}
    `);
    expect(rows[0].health_status).toBe('unknown');
  });

  it('can insert health_status values from the enum', async () => {
    const db = await createTestDb();
    const companyId = await seedCompany(db, 'Enum Health Corp');
    const now = new Date();
    const values = ['healthy', 'degraded', 'error', 'unknown'];

    for (const status of values) {
      const id = randomUUID();
      await db.drizzle.execute(sql`
        INSERT INTO "integrations" ("id", "company_id", "name", "type", "provider", "status", "health_status", "created_at", "updated_at")
        VALUES (${id}, ${companyId}, ${'Integration ' + status}, 'custom_api', 'custom', 'active', ${status}, ${now}, ${now})
      `);
      const rows = await execRows<{ health_status: string }>(db, sql`
        SELECT health_status FROM "integrations" WHERE "id" = ${id}
      `);
      expect(rows[0].health_status).toBe(status);
    }
  });
});

// ---------------------------------------------------------------------------
// integrations FK constraints
// ---------------------------------------------------------------------------

describe('migration 0017: integrations FK constraints', () => {
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
        AND con.conname = 'integrations_project_id_projects_id_fk'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].referenced_table).toBe('projects');
    // confdeltype 'n' = set null
    expect(rows[0].on_delete).toBe('n');
  });

  it('rejects a non-existent project_id via FK constraint', async () => {
    const db = await createTestDb();
    const companyId = await seedCompany(db, 'FK Reject Corp');
    const fakeProjectId = randomUUID();
    const now = new Date();
    await expect(
      db.drizzle.execute(sql`
        INSERT INTO "integrations" ("id", "company_id", "project_id", "name", "type", "provider", "status", "created_at", "updated_at")
        VALUES (${randomUUID()}, ${companyId}, ${fakeProjectId}, 'Test', 'custom_api', 'custom', 'active', ${now}, ${now})
      `),
    ).rejects.toThrow();
  });

  it('deleting a project sets integrations.project_id to NULL', async () => {
    const db = await createTestDb();
    const companyId = await seedCompany(db, 'Del Project Corp');
    const projectId = await seedProject(db, companyId, 'Doomed Integration Project');
    const integrationId = randomUUID();
    const now = new Date();

    await db.drizzle.execute(sql`
      INSERT INTO "integrations" ("id", "company_id", "project_id", "name", "type", "provider", "status", "created_at", "updated_at")
      VALUES (${integrationId}, ${companyId}, ${projectId}, 'Test', 'custom_api', 'custom', 'active', ${now}, ${now})
    `);

    // Verify project_id is set
    const before = await execRows<{ project_id: string | null }>(db, sql`
      SELECT project_id FROM "integrations" WHERE "id" = ${integrationId}
    `);
    expect(before[0].project_id).toBe(projectId);

    // Delete the project
    await db.drizzle.execute(sql`DELETE FROM "projects" WHERE "id" = ${projectId}`);

    // Verify project_id is now NULL and the integration still exists
    const after = await execRows<{ project_id: string | null }>(db, sql`
      SELECT project_id FROM "integrations" WHERE "id" = ${integrationId}
    `);
    expect(after.length).toBe(1);
    expect(after[0].project_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// integrations indexes
// ---------------------------------------------------------------------------

describe('migration 0017: integrations indexes', () => {
  it('idx_integrations_company_project exists with correct columns', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ indexdef: string }>(db, sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'integrations' AND indexname = 'idx_integrations_company_project'
    `);
    expect(rows.length).toBe(1);
    const def = rows[0].indexdef;
    expect(def).toContain('company_id');
    expect(def).toContain('project_id');
    // Verify column order
    const colList = def.slice(def.lastIndexOf('(') + 1, def.lastIndexOf(')'));
    const companyPos = colList.indexOf('company_id');
    const projectPos = colList.indexOf('project_id');
    expect(companyPos).toBeLessThan(projectPos);
  });

  it('idx_integrations_company_health exists with correct columns', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ indexdef: string }>(db, sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'integrations' AND indexname = 'idx_integrations_company_health'
    `);
    expect(rows.length).toBe(1);
    const def = rows[0].indexdef;
    expect(def).toContain('company_id');
    expect(def).toContain('health_status');
    // Verify column order
    const colList = def.slice(def.lastIndexOf('(') + 1, def.lastIndexOf(')'));
    const companyPos = colList.indexOf('company_id');
    const healthPos = colList.indexOf('health_status');
    expect(companyPos).toBeLessThan(healthPos);
  });
});

// ---------------------------------------------------------------------------
// integrations insert with all health fields
// ---------------------------------------------------------------------------

describe('migration 0017: integrations insert with health fields', () => {
  it('can insert a row with all health fields populated and query them back', async () => {
    const db = await createTestDb();
    const companyId = await seedCompany(db, 'Health Fields Corp');
    const projectId = await seedProject(db, companyId, 'Health Project');
    const integrationId = randomUUID();
    const now = new Date();

    await db.drizzle.execute(sql`
      INSERT INTO "integrations" (
        "id", "company_id", "project_id", "name", "type", "provider", "status",
        "health_status", "last_health_check_at", "health_error", "health_check_method",
        "created_at", "updated_at"
      )
      VALUES (
        ${integrationId}, ${companyId}, ${projectId}, 'API Integration', 'custom_api', 'custom', 'active',
        'healthy', ${now}, NULL, 'http_head', ${now}, ${now}
      )
    `);

    const rows = await execRows<{
      health_status: string;
      health_check_method: string | null;
      health_error: string | null;
      project_id: string | null;
    }>(db, sql`
      SELECT health_status, health_check_method, health_error, project_id
      FROM "integrations" WHERE "id" = ${integrationId}
    `);
    expect(rows[0].health_status).toBe('healthy');
    expect(rows[0].health_check_method).toBe('http_head');
    expect(rows[0].health_error).toBeNull();
    expect(rows[0].project_id).toBe(projectId);
  });

  it('can insert a row with an error health status and error message', async () => {
    const db = await createTestDb();
    const companyId = await seedCompany(db, 'Error Health Corp');
    const integrationId = randomUUID();
    const now = new Date();

    await db.drizzle.execute(sql`
      INSERT INTO "integrations" (
        "id", "company_id", "name", "type", "provider", "status",
        "health_status", "health_error", "health_check_method",
        "created_at", "updated_at"
      )
      VALUES (
        ${integrationId}, ${companyId}, 'Failing Integration', 'custom_api', 'custom', 'active',
        'error', 'Connection refused', 'http_head', ${now}, ${now}
      )
    `);

    const rows = await execRows<{
      health_status: string;
      health_error: string | null;
      health_check_method: string | null;
    }>(db, sql`
      SELECT health_status, health_error, health_check_method
      FROM "integrations" WHERE "id" = ${integrationId}
    `);
    expect(rows[0].health_status).toBe('error');
    expect(rows[0].health_error).toBe('Connection refused');
    expect(rows[0].health_check_method).toBe('http_head');
  });
});
