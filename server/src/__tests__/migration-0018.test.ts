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
// artifacts table structure
// ---------------------------------------------------------------------------

describe('migration 0018: artifacts table', () => {
  const expectedColumns: Record<string, { nullable: string; dataType: string }> = {
    id: { nullable: 'NO', dataType: 'text' },
    company_id: { nullable: 'NO', dataType: 'text' },
    project_id: { nullable: 'YES', dataType: 'text' },
    folder_id: { nullable: 'YES', dataType: 'text' },
    type: { nullable: 'NO', dataType: 'USER-DEFINED' },
    title: { nullable: 'NO', dataType: 'text' },
    content: { nullable: 'NO', dataType: 'jsonb' },
    content_schema_version: { nullable: 'NO', dataType: 'integer' },
    status: { nullable: 'NO', dataType: 'USER-DEFINED' },
    created_by_user_id: { nullable: 'YES', dataType: 'text' },
    created_by_agent_id: { nullable: 'YES', dataType: 'text' },
    last_edited_by_user_id: { nullable: 'YES', dataType: 'text' },
    last_edited_by_agent_id: { nullable: 'YES', dataType: 'text' },
    version: { nullable: 'NO', dataType: 'integer' },
    created_at: { nullable: 'NO', dataType: 'timestamp with time zone' },
    updated_at: { nullable: 'NO', dataType: 'timestamp with time zone' },
    deleted_at: { nullable: 'YES', dataType: 'timestamp with time zone' },
  };

  it.each(Object.entries(expectedColumns))(
    'artifacts has column %s with correct type + nullability',
    async (col, expected) => {
      const db = await createTestDb();
      const rows = await execRows<{ is_nullable: string; data_type: string }>(db, sql`
        SELECT is_nullable, data_type
        FROM information_schema.columns
        WHERE table_name = 'artifacts' AND column_name = ${col}
      `);
      expect(rows.length, `artifacts should have column ${col}`).toBe(1);
      expect(rows[0].is_nullable).toBe(expected.nullable);
      expect(rows[0].data_type).toBe(expected.dataType);
    },
  );

  it('content defaults to empty jsonb object', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ column_default: string }>(db, sql`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'artifacts' AND column_name = 'content'
    `);
    expect(rows[0].column_default).toContain("'{}'::jsonb");
  });

  it('content_schema_version defaults to 1', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ column_default: string }>(db, sql`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'artifacts' AND column_name = 'content_schema_version'
    `);
    expect(rows[0].column_default).toContain('1');
  });

  it('status defaults to active', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ column_default: string }>(db, sql`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'artifacts' AND column_name = 'status'
    `);
    expect(rows[0].column_default).toContain('active');
  });

  it('version defaults to 1', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ column_default: string }>(db, sql`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'artifacts' AND column_name = 'version'
    `);
    expect(rows[0].column_default).toContain('1');
  });
});

// ---------------------------------------------------------------------------
// artifact_revisions table structure
// ---------------------------------------------------------------------------

describe('migration 0018: artifact_revisions table', () => {
  const expectedColumns: Record<string, { nullable: string; dataType: string }> = {
    id: { nullable: 'NO', dataType: 'text' },
    artifact_id: { nullable: 'NO', dataType: 'text' },
    version: { nullable: 'NO', dataType: 'integer' },
    content: { nullable: 'NO', dataType: 'jsonb' },
    edited_by_user_id: { nullable: 'YES', dataType: 'text' },
    edited_by_agent_id: { nullable: 'YES', dataType: 'text' },
    edit_source: { nullable: 'NO', dataType: 'USER-DEFINED' },
    message: { nullable: 'YES', dataType: 'text' },
    created_at: { nullable: 'NO', dataType: 'timestamp with time zone' },
  };

  it.each(Object.entries(expectedColumns))(
    'artifact_revisions has column %s with correct type + nullability',
    async (col, expected) => {
      const db = await createTestDb();
      const rows = await execRows<{ is_nullable: string; data_type: string }>(db, sql`
        SELECT is_nullable, data_type
        FROM information_schema.columns
        WHERE table_name = 'artifact_revisions' AND column_name = ${col}
      `);
      expect(rows.length, `artifact_revisions should have column ${col}`).toBe(1);
      expect(rows[0].is_nullable).toBe(expected.nullable);
      expect(rows[0].data_type).toBe(expected.dataType);
    },
  );

  it('unique index on (artifact_id, version) exists', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ indexdef: string }>(db, sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'artifact_revisions' AND indexname = 'uq_artifact_revisions_artifact_version'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].indexdef).toContain('UNIQUE');
    expect(rows[0].indexdef).toContain('artifact_id');
    expect(rows[0].indexdef).toContain('version');
  });
});

// ---------------------------------------------------------------------------
// enums
// ---------------------------------------------------------------------------

describe('migration 0018: artifact enums', () => {
  it('artifact_type enum has all 9 values', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ enumlabel: string }>(db, sql`
      SELECT e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'artifact_type'
      ORDER BY e.enumsortorder
    `);
    const labels = rows.map((r) => r.enumlabel);
    expect(labels).toEqual([
      'document', 'sheet', 'board', 'slide_deck', 'timeline',
      'gallery', 'dashboard', 'app', 'code',
    ]);
  });

  it('artifact_status enum has active, archived, deleted', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ enumlabel: string }>(db, sql`
      SELECT e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'artifact_status'
      ORDER BY e.enumsortorder
    `);
    expect(rows.map((r) => r.enumlabel)).toEqual(['active', 'archived', 'deleted']);
  });

  it('artifact_edit_source enum has user, agent, system', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ enumlabel: string }>(db, sql`
      SELECT e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'artifact_edit_source'
      ORDER BY e.enumsortorder
    `);
    expect(rows.map((r) => r.enumlabel)).toEqual(['user', 'agent', 'system']);
  });
});

// ---------------------------------------------------------------------------
// check constraints + version invariants
// ---------------------------------------------------------------------------

describe('migration 0018: check constraints', () => {
  it('artifacts.version > 0 check exists', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ consrc: string }>(db, sql`
      SELECT pg_get_constraintdef(oid) AS consrc
      FROM pg_constraint
      WHERE conname = 'chk_artifacts_version_positive'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].consrc).toContain('version > 0');
  });

  it('artifacts.content_schema_version > 0 check exists', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ consrc: string }>(db, sql`
      SELECT pg_get_constraintdef(oid) AS consrc
      FROM pg_constraint
      WHERE conname = 'chk_artifacts_schema_version_positive'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].consrc).toContain('content_schema_version > 0');
  });

  it('artifact_revisions.version > 0 check exists', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ consrc: string }>(db, sql`
      SELECT pg_get_constraintdef(oid) AS consrc
      FROM pg_constraint
      WHERE conname = 'chk_artifact_revisions_version_positive'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].consrc).toContain('version > 0');
  });

  it('rejects artifact insert with version 0', async () => {
    const db = await createTestDb();
    const companyId = await seedCompany(db, 'Check Constraint Corp');
    await expect(
      db.drizzle.execute(sql`
        INSERT INTO "artifacts" ("id", "company_id", "type", "title", "version")
        VALUES (${randomUUID()}, ${companyId}, 'document', 'Bad Version', 0)
      `),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// FK constraints
// ---------------------------------------------------------------------------

describe('migration 0018: FK constraints', () => {
  it('artifacts.company_id FK references companies.id ON DELETE cascade', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ referenced_table: string; on_delete: string }>(db, sql`
      SELECT cls.relname AS referenced_table, con.confdeltype AS on_delete
      FROM pg_constraint con
      JOIN pg_class cls ON con.confrelid = cls.oid
      WHERE con.contype = 'f' AND con.conname = 'artifacts_company_id_companies_id_fk'
    `);
    expect(rows[0].referenced_table).toBe('companies');
    // confdeltype 'c' = cascade
    expect(rows[0].on_delete).toBe('c');
  });

  it('artifacts.project_id FK references projects.id ON DELETE set null', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ referenced_table: string; on_delete: string }>(db, sql`
      SELECT cls.relname AS referenced_table, con.confdeltype AS on_delete
      FROM pg_constraint con
      JOIN pg_class cls ON con.confrelid = cls.oid
      WHERE con.contype = 'f' AND con.conname = 'artifacts_project_id_projects_id_fk'
    `);
    expect(rows[0].referenced_table).toBe('projects');
    // confdeltype 'n' = set null
    expect(rows[0].on_delete).toBe('n');
  });

  it('artifact_revisions.artifact_id FK references artifacts.id ON DELETE cascade', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ referenced_table: string; on_delete: string }>(db, sql`
      SELECT cls.relname AS referenced_table, con.confdeltype AS on_delete
      FROM pg_constraint con
      JOIN pg_class cls ON con.confrelid = cls.oid
      WHERE con.contype = 'f' AND con.conname = 'artifact_revisions_artifact_id_artifacts_id_fk'
    `);
    expect(rows[0].referenced_table).toBe('artifacts');
    expect(rows[0].on_delete).toBe('c');
  });

  it('deleting a company cascades to its artifacts', async () => {
    const db = await createTestDb();
    const companyId = await seedCompany(db, 'Cascade Corp');
    const artifactId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "artifacts" ("id", "company_id", "type", "title")
      VALUES (${artifactId}, ${companyId}, 'document', 'Doomed Doc')
    `);
    await db.drizzle.execute(sql`DELETE FROM "companies" WHERE "id" = ${companyId}`);
    const rows = await execRows<{ id: string }>(db, sql`
      SELECT id FROM "artifacts" WHERE "id" = ${artifactId}
    `);
    expect(rows.length).toBe(0);
  });

  it('deleting a project sets artifact.project_id to NULL (artifacts preserved)', async () => {
    const db = await createTestDb();
    const companyId = await seedCompany(db, 'Project Del Corp');
    const projectId = await seedProject(db, companyId, 'Doomed Project');
    const artifactId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "artifacts" ("id", "company_id", "project_id", "type", "title")
      VALUES (${artifactId}, ${companyId}, ${projectId}, 'document', 'Scoped Doc')
    `);
    await db.drizzle.execute(sql`DELETE FROM "projects" WHERE "id" = ${projectId}`);
    const rows = await execRows<{ project_id: string | null; status: string }>(db, sql`
      SELECT project_id, status FROM "artifacts" WHERE "id" = ${artifactId}
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].project_id).toBeNull();
    expect(rows[0].status).toBe('active');
  });

  it('deleting an artifact cascades to its revisions', async () => {
    const db = await createTestDb();
    const companyId = await seedCompany(db, 'Revision Cascade Corp');
    const artifactId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "artifacts" ("id", "company_id", "type", "title")
      VALUES (${artifactId}, ${companyId}, 'document', 'Rev Doc')
    `);
    const revisionId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "artifact_revisions" ("id", "artifact_id", "version", "content", "edit_source")
      VALUES (${revisionId}, ${artifactId}, 1, '{}'::jsonb, 'user')
    `);
    await db.drizzle.execute(sql`DELETE FROM "artifacts" WHERE "id" = ${artifactId}`);
    const rows = await execRows<{ id: string }>(db, sql`
      SELECT id FROM "artifact_revisions" WHERE "id" = ${revisionId}
    `);
    expect(rows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// indexes
// ---------------------------------------------------------------------------

describe('migration 0018: indexes', () => {
  it('idx_artifacts_company_status_updated exists', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ indexdef: string }>(db, sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'artifacts' AND indexname = 'idx_artifacts_company_status_updated'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].indexdef).toContain('company_id');
    expect(rows[0].indexdef).toContain('status');
    expect(rows[0].indexdef).toContain('updated_at');
  });

  it('idx_artifacts_company_project exists', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ indexdef: string }>(db, sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'artifacts' AND indexname = 'idx_artifacts_company_project'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].indexdef).toContain('company_id');
    expect(rows[0].indexdef).toContain('project_id');
  });

  it('idx_artifacts_company_type exists', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ indexdef: string }>(db, sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'artifacts' AND indexname = 'idx_artifacts_company_type'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].indexdef).toContain('company_id');
    expect(rows[0].indexdef).toContain('type');
  });

  it('idx_artifact_revisions_artifact_created exists', async () => {
    const db = await createTestDb();
    const rows = await execRows<{ indexdef: string }>(db, sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'artifact_revisions' AND indexname = 'idx_artifact_revisions_artifact_created'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].indexdef).toContain('artifact_id');
    expect(rows[0].indexdef).toContain('created_at');
  });
});

// ---------------------------------------------------------------------------
// task_thread_items.mentions column
// ---------------------------------------------------------------------------

describe('migration 0018: task_thread_items.mentions', () => {
  it('mentions column exists as jsonb NOT NULL with default []', async () => {
    const db = await createTestDb();
    const rows = await execRows<{
      is_nullable: string;
      data_type: string;
      column_default: string;
    }>(db, sql`
      SELECT is_nullable, data_type, column_default
      FROM information_schema.columns
      WHERE table_name = 'task_thread_items' AND column_name = 'mentions'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].data_type).toBe('jsonb');
    expect(rows[0].is_nullable).toBe('NO');
    expect(rows[0].column_default).toContain('[]');
  });
});

// ---------------------------------------------------------------------------
// insert round-trip
// ---------------------------------------------------------------------------

describe('migration 0018: artifact + revision insert round-trip', () => {
  it('can insert an artifact and a revision, then query them back', async () => {
    const db = await createTestDb();
    const companyId = await seedCompany(db, 'Round Trip Corp');
    const artifactId = randomUUID();
    const content = { format: 'markdown', body: '# Hello' };

    await db.drizzle.execute(sql`
      INSERT INTO "artifacts" ("id", "company_id", "type", "title", "content", "created_by_user_id")
      VALUES (${artifactId}, ${companyId}, 'document', 'Test Doc', ${JSON.stringify(content)}::jsonb, 'user-1')
    `);

    const artRows = await execRows<{
      type: string;
      title: string;
      version: number;
      status: string;
      content_schema_version: number;
    }>(db, sql`SELECT type, title, version, status, content_schema_version FROM "artifacts" WHERE "id" = ${artifactId}`);
    expect(artRows[0].type).toBe('document');
    expect(artRows[0].title).toBe('Test Doc');
    expect(artRows[0].version).toBe(1);
    expect(artRows[0].status).toBe('active');
    expect(artRows[0].content_schema_version).toBe(1);

    const revisionId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "artifact_revisions" ("id", "artifact_id", "version", "content", "edit_source", "edited_by_user_id", "message")
      VALUES (${revisionId}, ${artifactId}, 1, ${JSON.stringify(content)}::jsonb, 'user', 'user-1', 'initial')
    `);

    const revRows = await execRows<{
      version: number;
      edit_source: string;
      message: string;
    }>(db, sql`SELECT version, edit_source, message FROM "artifact_revisions" WHERE "id" = ${revisionId}`);
    expect(revRows[0].version).toBe(1);
    expect(revRows[0].edit_source).toBe('user');
    expect(revRows[0].message).toBe('initial');
  });

  it('unique(artifact_id, version) prevents duplicate revision versions', async () => {
    const db = await createTestDb();
    const companyId = await seedCompany(db, 'Dup Rev Corp');
    const artifactId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "artifacts" ("id", "company_id", "type", "title")
      VALUES (${artifactId}, ${companyId}, 'document', 'Dup Rev Doc')
    `);
    await db.drizzle.execute(sql`
      INSERT INTO "artifact_revisions" ("id", "artifact_id", "version", "content", "edit_source")
      VALUES (${randomUUID()}, ${artifactId}, 1, '{}'::jsonb, 'user')
    `);
    await expect(
      db.drizzle.execute(sql`
        INSERT INTO "artifact_revisions" ("id", "artifact_id", "version", "content", "edit_source")
        VALUES (${randomUUID()}, ${artifactId}, 1, '{}'::jsonb, 'agent')
      `),
    ).rejects.toThrow();
  });
});
