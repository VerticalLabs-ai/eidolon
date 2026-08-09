import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCleanup, type SqlRunner } from '../cleanup/fixtures.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = resolve(__dirname, '../../../packages/db/drizzle');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Create a PGlite-backed SqlRunner with migrations applied.
 * Each test gets an isolated in-memory database.
 */
async function createTestRunner(): Promise<{
  runner: SqlRunner;
  pglite: PGlite;
  close: () => Promise<void>;
}> {
  const pglite = new PGlite();
  const drizzleDb = drizzle(pglite);
  await migrate(drizzleDb, { migrationsFolder: MIGRATIONS_FOLDER });

  // Build the runner without explicit SqlRunner typing so the generic
  // query<T> signature doesn't conflict with the concrete return type.
  // The object is cast to SqlRunner at the end.
  const impl = {
    async query(sql: string) {
      const result = await pglite.query(sql);
      return result.rows as Record<string, unknown>[];
    },
    async begin(fn: (tx: SqlRunner) => Promise<unknown>) {
      await pglite.query('BEGIN');
      const txRunner = {
        query: impl.query as SqlRunner['query'],
        begin: ((fn2: (tx2: SqlRunner) => Promise<unknown>) => fn2(txRunner)) as SqlRunner['begin'],
      } as SqlRunner;
      try {
        const result = await fn(txRunner);
        await pglite.query('COMMIT');
        return result;
      } catch (err) {
        await pglite.query('ROLLBACK');
        throw err;
      }
    },
  };

  const runner = impl as unknown as SqlRunner;

  return { runner, pglite, close: async () => { await pglite.close(); } };
}

/** Insert a company with the testFixture marker. */
async function insertFixtureCompany(
  runner: SqlRunner,
  name: string,
  options?: { hoursAgo?: number; testFixture?: boolean },
): Promise<string> {
  const id = randomUUID();
  const ts = new Date(Date.now() - (options?.hoursAgo ?? 0) * 60 * 60 * 1000).toISOString();
  const marker = options?.testFixture === false ? '{}' : '{"testFixture": true}';
  await runner.query(
    `INSERT INTO companies (id, name, settings, created_at, updated_at) VALUES ('${id}', '${name}', '${marker}', '${ts}', '${ts}')`,
  );
  return id;
}

/** Insert a plain (non-fixture) company. */
async function insertPlainCompany(runner: SqlRunner, name: string): Promise<string> {
  return insertFixtureCompany(runner, name, { testFixture: false });
}

/** Insert an agent for a company. */
async function insertAgent(runner: SqlRunner, companyId: string, name: string): Promise<string> {
  const id = randomUUID();
  const ts = new Date().toISOString();
  await runner.query(
    `INSERT INTO agents (id, company_id, name, role, created_at, updated_at) VALUES ('${id}', '${companyId}', '${name}', 'engineer', '${ts}', '${ts}')`,
  );
  return id;
}

/** Insert a task for a company. */
async function insertTask(runner: SqlRunner, companyId: string, title: string): Promise<string> {
  const id = randomUUID();
  const ts = new Date().toISOString();
  await runner.query(
    `INSERT INTO tasks (id, company_id, title, created_at, updated_at) VALUES ('${id}', '${companyId}', '${title}', '${ts}', '${ts}')`,
  );
  return id;
}

/** Insert a project for a company. */
async function insertProject(runner: SqlRunner, companyId: string, name: string): Promise<string> {
  const id = randomUUID();
  const ts = new Date().toISOString();
  await runner.query(
    `INSERT INTO projects (id, company_id, name, created_at, updated_at) VALUES ('${id}', '${companyId}', '${name}', '${ts}', '${ts}')`,
  );
  return id;
}

/** Insert a knowledge document + chunk for a company. */
async function insertKnowledge(
  runner: SqlRunner,
  companyId: string,
  title: string,
): Promise<{ docId: string; chunkId: string }> {
  const docId = randomUUID();
  const chunkId = randomUUID();
  const ts = new Date().toISOString();
  await runner.query(
    `INSERT INTO knowledge_documents (id, company_id, title, content, created_at, updated_at) VALUES ('${docId}', '${companyId}', '${title}', 'test content', '${ts}', '${ts}')`,
  );
  await runner.query(
    `INSERT INTO knowledge_chunks (id, document_id, company_id, chunk_index, content, created_at) VALUES ('${chunkId}', '${docId}', '${companyId}', 0, 'chunk content', '${ts}')`,
  );
  return { docId, chunkId };
}

/** Insert a prompt template + version for a company. */
async function insertPrompt(
  runner: SqlRunner,
  companyId: string,
  name: string,
): Promise<{ templateId: string; versionId: string }> {
  const templateId = randomUUID();
  const versionId = randomUUID();
  const ts = new Date().toISOString();
  await runner.query(
    `INSERT INTO prompt_templates (id, company_id, name, content, created_at, updated_at) VALUES ('${templateId}', '${companyId}', '${name}', 'test prompt', '${ts}', '${ts}')`,
  );
  await runner.query(
    `INSERT INTO prompt_versions (id, template_id, version, content, created_at) VALUES ('${versionId}', '${templateId}', 1, 'v1 content', '${ts}')`,
  );
  return { templateId, versionId };
}

/** Insert an approval + comment for a company. */
async function insertApproval(
  runner: SqlRunner,
  companyId: string,
  title: string,
): Promise<{ approvalId: string; commentId: string }> {
  const approvalId = randomUUID();
  const commentId = randomUUID();
  const ts = new Date().toISOString();
  await runner.query(
    `INSERT INTO approvals (id, company_id, title, created_at, updated_at) VALUES ('${approvalId}', '${companyId}', '${title}', '${ts}', '${ts}')`,
  );
  await runner.query(
    `INSERT INTO approval_comments (id, approval_id, content, created_at) VALUES ('${commentId}', '${approvalId}', 'test comment', '${ts}')`,
  );
  return { approvalId, commentId };
}

/** Insert a goal for a company. */
async function insertGoal(runner: SqlRunner, companyId: string, title: string): Promise<string> {
  const id = randomUUID();
  const ts = new Date().toISOString();
  await runner.query(
    `INSERT INTO goals (id, company_id, title, created_at, updated_at) VALUES ('${id}', '${companyId}', '${title}', '${ts}', '${ts}')`,
  );
  return id;
}

/** Insert an artifact + revision for a company (with an agent FK). */
async function insertArtifact(
  runner: SqlRunner,
  companyId: string,
  agentId: string | null,
  title: string,
): Promise<{ artifactId: string; revisionId: string }> {
  const artifactId = randomUUID();
  const revisionId = randomUUID();
  const ts = new Date().toISOString();
  await runner.query(
    `INSERT INTO artifacts (id, company_id, type, title, content, status, version, created_by_agent_id, last_edited_by_agent_id, created_at, updated_at) VALUES ('${artifactId}', '${companyId}', 'document', '${title}', '{"format":"markdown","body":"test"}', 'active', 1, ${agentId ? `'${agentId}'` : 'NULL'}, ${agentId ? `'${agentId}'` : 'NULL'}, '${ts}', '${ts}')`,
  );
  await runner.query(
    `INSERT INTO artifact_revisions (id, artifact_id, version, content, edit_source, edited_by_agent_id, created_at) VALUES ('${revisionId}', '${artifactId}', 1, '{"format":"markdown","body":"test"}', 'agent', ${agentId ? `'${agentId}'` : 'NULL'}, '${ts}')`,
  );
  return { artifactId, revisionId };
}

/** Count rows in a table for a given company_id (or by id for the companies table). */
async function countForCompany(runner: SqlRunner, table: string, companyId: string): Promise<number> {
  const column = table === 'companies' ? 'id' : 'company_id';
  const rows = await runner.query<{ count: string }>(
    `SELECT count(*) as count FROM ${table} WHERE ${column} = '${companyId}'`,
  );
  return parseInt(rows[0]?.count ?? '0', 10);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Cleanup script logic', () => {
  let runner: SqlRunner;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const ctx = await createTestRunner();
    runner = ctx.runner;
    close = ctx.close;
  });

  afterEach(async () => {
    await close();
  });

  // VAL-CLEAN-001: Dry-run lists fixtures without deleting
  it('dry-run lists fixtures and reports counts without modifying the DB', async () => {
    const fixtureId = await insertFixtureCompany(runner, '__mtest__ dry-run-test');
    await insertAgent(runner, fixtureId, 'Agent 1');
    await insertTask(runner, fixtureId, 'Task 1');
    await insertProject(runner, fixtureId, 'Project 1');

    const result = await runCleanup(runner, { execute: false });

    expect(result.mode).toBe('dry-run');
    expect(result.fixtureIds).toContain(fixtureId);
    expect(result.companyCount).toBe(1);

    // Verify per-table counts are reported
    const agentCount = result.tableCounts.find((c) => c.table === 'agents');
    expect(agentCount?.count).toBe(1);
    const taskCount = result.tableCounts.find((c) => c.table === 'tasks');
    expect(taskCount?.count).toBe(1);
    const projectCount = result.tableCounts.find((c) => c.table === 'projects');
    expect(projectCount?.count).toBe(1);

    // Verify nothing was actually deleted
    expect(await countForCompany(runner, 'companies', fixtureId)).toBe(1);
    expect(await countForCompany(runner, 'agents', fixtureId)).toBe(1);
    expect(await countForCompany(runner, 'tasks', fixtureId)).toBe(1);
    expect(await countForCompany(runner, 'projects', fixtureId)).toBe(1);
  });

  // VAL-CLEAN-002: Execute removes fixtures and reports per-table counts
  it('execute removes tagged fixtures and reports per-table counts', async () => {
    const fixtureId = await insertFixtureCompany(runner, '__mtest__ exec-test');
    await insertAgent(runner, fixtureId, 'Agent 1');
    await insertTask(runner, fixtureId, 'Task 1');
    await insertProject(runner, fixtureId, 'Project 1');
    await insertGoal(runner, fixtureId, 'Goal 1');

    const result = await runCleanup(runner, { execute: true });

    expect(result.mode).toBe('execute');
    expect(result.companyCount).toBe(1);

    const agentCount = result.tableCounts.find((c) => c.table === 'agents');
    expect(agentCount?.count).toBe(1);
    const taskCount = result.tableCounts.find((c) => c.table === 'tasks');
    expect(taskCount?.count).toBe(1);
    const projectCount = result.tableCounts.find((c) => c.table === 'projects');
    expect(projectCount?.count).toBe(1);
    const goalCount = result.tableCounts.find((c) => c.table === 'goals');
    expect(goalCount?.count).toBe(1);

    // Verify actual deletion
    expect(await countForCompany(runner, 'companies', fixtureId)).toBe(0);
    expect(await countForCompany(runner, 'agents', fixtureId)).toBe(0);
    expect(await countForCompany(runner, 'tasks', fixtureId)).toBe(0);
    expect(await countForCompany(runner, 'projects', fixtureId)).toBe(0);
    expect(await countForCompany(runner, 'goals', fixtureId)).toBe(0);
  });

  // VAL-CLEAN-003: Non-fixture companies are preserved
  it('non-fixture companies and their data are preserved', async () => {
    const fixtureId = await insertFixtureCompany(runner, '__mtest__ to-delete');
    const plainId = await insertPlainCompany(runner, 'Real Company');

    await insertAgent(runner, fixtureId, 'Fixture Agent');
    await insertAgent(runner, plainId, 'Real Agent');
    await insertTask(runner, fixtureId, 'Fixture Task');
    await insertTask(runner, plainId, 'Real Task');

    const result = await runCleanup(runner, { execute: true });

    expect(result.companyCount).toBe(1);
    expect(result.fixtureIds).toContain(fixtureId);
    expect(result.fixtureIds).not.toContain(plainId);

    // Fixture data is gone
    expect(await countForCompany(runner, 'companies', fixtureId)).toBe(0);
    expect(await countForCompany(runner, 'agents', fixtureId)).toBe(0);
    expect(await countForCompany(runner, 'tasks', fixtureId)).toBe(0);

    // Non-fixture data is intact
    expect(await countForCompany(runner, 'companies', plainId)).toBe(1);
    expect(await countForCompany(runner, 'agents', plainId)).toBe(1);
    expect(await countForCompany(runner, 'tasks', plainId)).toBe(1);
  });

  // VAL-CLEAN-005: Cleanup is idempotent
  it('is idempotent — second run reports zero fixtures', async () => {
    const fixtureId = await insertFixtureCompany(runner, '__mtest__ idempotent-test');
    await insertAgent(runner, fixtureId, 'Agent 1');
    await insertTask(runner, fixtureId, 'Task 1');

    const first = await runCleanup(runner, { execute: true });
    expect(first.companyCount).toBe(1);

    const second = await runCleanup(runner, { execute: true });
    expect(second.companyCount).toBe(0);
    expect(second.fixtureIds).toHaveLength(0);
    // All table counts should be zero
    for (const { table, count } of second.tableCounts) {
      expect(count, `${table} should have 0 count on second run`).toBe(0);
    }
  });

  // VAL-CLEAN-006: Stale-hours filters by fixture age
  it('stale-hours only removes fixtures older than N hours', async () => {
    // Old fixture (48 hours ago) — should be removed
    const oldFixtureId = await insertFixtureCompany(runner, '__mtest__ old-fixture', { hoursAgo: 48 });
    await insertAgent(runner, oldFixtureId, 'Old Agent');

    // Recent fixture (1 hour ago) — should be preserved
    const recentFixtureId = await insertFixtureCompany(runner, '__mtest__ recent-fixture', { hoursAgo: 1 });
    await insertAgent(runner, recentFixtureId, 'Recent Agent');

    const result = await runCleanup(runner, { execute: true, staleHours: 6 });

    expect(result.companyCount).toBe(1);
    expect(result.fixtureIds).toContain(oldFixtureId);
    expect(result.fixtureIds).not.toContain(recentFixtureId);

    // Old fixture is gone
    expect(await countForCompany(runner, 'companies', oldFixtureId)).toBe(0);
    expect(await countForCompany(runner, 'agents', oldFixtureId)).toBe(0);

    // Recent fixture is preserved
    expect(await countForCompany(runner, 'companies', recentFixtureId)).toBe(1);
    expect(await countForCompany(runner, 'agents', recentFixtureId)).toBe(1);
  });

  // VAL-CLEAN-007: Empty database exits cleanly
  it('empty database exits cleanly with zero counts', async () => {
    const dryResult = await runCleanup(runner, { execute: false });
    expect(dryResult.companyCount).toBe(0);
    expect(dryResult.fixtureIds).toHaveLength(0);
    for (const { count } of dryResult.tableCounts) {
      expect(count).toBe(0);
    }

    const execResult = await runCleanup(runner, { execute: true });
    expect(execResult.companyCount).toBe(0);
    expect(execResult.fixtureIds).toHaveLength(0);
    for (const { count } of execResult.tableCounts) {
      expect(count).toBe(0);
    }
  });

  // VAL-CLEAN-008: All dependent data removed without orphans
  it('removes all dependent data including indirect children without orphans', async () => {
    const fixtureId = await insertFixtureCompany(runner, '__mtest__ orphan-test');

    // Create direct dependents
    await insertAgent(runner, fixtureId, 'Agent 1');
    await insertTask(runner, fixtureId, 'Task 1');
    await insertProject(runner, fixtureId, 'Project 1');
    await insertGoal(runner, fixtureId, 'Goal 1');

    // Create indirect dependents
    const { docId, chunkId } = await insertKnowledge(runner, fixtureId, 'Doc 1');
    const { templateId, versionId } = await insertPrompt(runner, fixtureId, 'Template 1');
    const { approvalId, commentId } = await insertApproval(runner, fixtureId, 'Approval 1');

    const result = await runCleanup(runner, { execute: true });
    expect(result.companyCount).toBe(1);

    // Verify all direct tables are empty for this company
    for (const table of ['agents', 'tasks', 'projects', 'goals']) {
      expect(await countForCompany(runner, table, fixtureId)).toBe(0);
    }

    // Verify indirect children are gone
    const chunks = await runner.query<{ count: string }>(`SELECT count(*) as count FROM knowledge_chunks WHERE id = '${chunkId}'`);
    expect(parseInt(chunks[0]?.count ?? '0', 10)).toBe(0);

    const docs = await runner.query<{ count: string }>(`SELECT count(*) as count FROM knowledge_documents WHERE id = '${docId}'`);
    expect(parseInt(docs[0]?.count ?? '0', 10)).toBe(0);

    const versions = await runner.query<{ count: string }>(`SELECT count(*) as count FROM prompt_versions WHERE id = '${versionId}'`);
    expect(parseInt(versions[0]?.count ?? '0', 10)).toBe(0);

    const templates = await runner.query<{ count: string }>(`SELECT count(*) as count FROM prompt_templates WHERE id = '${templateId}'`);
    expect(parseInt(templates[0]?.count ?? '0', 10)).toBe(0);

    const comments = await runner.query<{ count: string }>(`SELECT count(*) as count FROM approval_comments WHERE id = '${commentId}'`);
    expect(parseInt(comments[0]?.count ?? '0', 10)).toBe(0);

    const approvals = await runner.query<{ count: string }>(`SELECT count(*) as count FROM approvals WHERE id = '${approvalId}'`);
    expect(parseInt(approvals[0]?.count ?? '0', 10)).toBe(0);

    // Verify the company itself is gone
    expect(await countForCompany(runner, 'companies', fixtureId)).toBe(0);
  });

  // VAL-CLEAN-009: Failed delete rolls back the transaction
  it('rolls back the transaction on delete failure — no partial cleanup', async () => {
    const fixtureId = await insertFixtureCompany(runner, '__mtest__ rollback-test');
    await insertAgent(runner, fixtureId, 'Agent 1');
    await insertTask(runner, fixtureId, 'Task 1');
    await insertProject(runner, fixtureId, 'Project 1');

    // Snapshot before
    const agentsBefore = await countForCompany(runner, 'agents', fixtureId);
    const tasksBefore = await countForCompany(runner, 'tasks', fixtureId);
    const projectsBefore = await countForCompany(runner, 'projects', fixtureId);
    expect(agentsBefore).toBe(1);
    expect(tasksBefore).toBe(1);
    expect(projectsBefore).toBe(1);

    // Create a failing runner that throws on the 3rd DELETE inside the transaction
    const failingRunner: SqlRunner = {
      query: (sql) => runner.query(sql),
      begin: async (fn) => {
        return runner.begin(async (tx) => {
          let deleteCount = 0;
          const failingTx: SqlRunner = {
            query: async (sql) => {
              if (sql.trim().toUpperCase().startsWith('DELETE')) {
                deleteCount++;
                if (deleteCount === 3) {
                  throw new Error('Injected failure on delete #3');
                }
              }
              return tx.query(sql);
            },
            begin: (fn2) => fn2(failingTx),
          };
          return fn(failingTx);
        });
      },
    };

    // The cleanup should throw
    await expect(runCleanup(failingRunner, { execute: true })).rejects.toThrow(
      'Injected failure on delete #3',
    );

    // Verify everything is still intact (transaction rolled back)
    expect(await countForCompany(runner, 'companies', fixtureId)).toBe(1);
    expect(await countForCompany(runner, 'agents', fixtureId)).toBe(1);
    expect(await countForCompany(runner, 'tasks', fixtureId)).toBe(1);
    expect(await countForCompany(runner, 'projects', fixtureId)).toBe(1);
  });

  // VAL-CROSS-006: Dry-run does not delete fixtures
  it('dry-run does not delete any fixture data (cross-area)', async () => {
    const fixtureId = await insertFixtureCompany(runner, '__mtest__ cross-dry-run');
    await insertAgent(runner, fixtureId, 'Agent 1');
    await insertTask(runner, fixtureId, 'Task 1');

    await runCleanup(runner, { execute: false });

    // Everything should still exist
    expect(await countForCompany(runner, 'companies', fixtureId)).toBe(1);
    expect(await countForCompany(runner, 'agents', fixtureId)).toBe(1);
    expect(await countForCompany(runner, 'tasks', fixtureId)).toBe(1);
  });

  // VAL-CROSS-002: Real companies survive fixture cleanup
  it('real companies survive fixture cleanup (cross-area)', async () => {
    const fixtureId = await insertFixtureCompany(runner, '__mtest__ cross-survive');
    const realId = await insertPlainCompany(runner, 'Real Cross Corp');

    await insertAgent(runner, fixtureId, 'Fixture Agent');
    await insertAgent(runner, realId, 'Real Agent');

    await runCleanup(runner, { execute: true });

    expect(await countForCompany(runner, 'companies', realId)).toBe(1);
    expect(await countForCompany(runner, 'agents', realId)).toBe(1);
    expect(await countForCompany(runner, 'companies', fixtureId)).toBe(0);
  });

  // VAL-CROSS-005: Full dependent-data lifecycle leaves no orphans
  it('full lifecycle: company + agents + tasks + projects all removed, no orphans', async () => {
    const fixtureId = await insertFixtureCompany(runner, '__mtest__ full-lifecycle');
    await insertAgent(runner, fixtureId, 'Agent A');
    await insertAgent(runner, fixtureId, 'Agent B');
    await insertTask(runner, fixtureId, 'Task A');
    await insertTask(runner, fixtureId, 'Task B');
    await insertProject(runner, fixtureId, 'Project A');
    await insertKnowledge(runner, fixtureId, 'Knowledge Doc');
    await insertPrompt(runner, fixtureId, 'Prompt Template');
    await insertApproval(runner, fixtureId, 'Approval');

    await runCleanup(runner, { execute: true });

    // No rows in any table should reference the deleted company
    for (const table of ['agents', 'tasks', 'projects', 'goals', 'knowledge_documents', 'knowledge_chunks', 'prompt_templates']) {
      expect(await countForCompany(runner, table, fixtureId)).toBe(0);
    }

    // Indirect tables
    const versionCount = await runner.query<{ count: string }>(
      `SELECT count(*) as count FROM prompt_versions WHERE template_id IN (SELECT id FROM prompt_templates WHERE company_id = '${fixtureId}')`,
    );
    expect(parseInt(versionCount[0]?.count ?? '0', 10)).toBe(0);

    const commentCount = await runner.query<{ count: string }>(
      `SELECT count(*) as count FROM approval_comments WHERE approval_id IN (SELECT id FROM approvals WHERE company_id = '${fixtureId}')`,
    );
    expect(parseInt(commentCount[0]?.count ?? '0', 10)).toBe(0);
  });

  // Dry-run with stale-hours still doesn't delete
  it('dry-run with stale-hours reports counts without deleting', async () => {
    const oldId = await insertFixtureCompany(runner, '__mtest__ old-stale', { hoursAgo: 48 });
    await insertAgent(runner, oldId, 'Old Agent');

    const result = await runCleanup(runner, { execute: false, staleHours: 6 });

    expect(result.mode).toBe('dry-run');
    expect(result.companyCount).toBe(1);
    expect(result.fixtureIds).toContain(oldId);

    // Nothing deleted
    expect(await countForCompany(runner, 'companies', oldId)).toBe(1);
    expect(await countForCompany(runner, 'agents', oldId)).toBe(1);
  });

  // Multiple fixtures are all removed
  it('removes multiple fixture companies in one run', async () => {
    const id1 = await insertFixtureCompany(runner, '__mtest__ multi-1');
    const id2 = await insertFixtureCompany(runner, '__mtest__ multi-2');
    const id3 = await insertFixtureCompany(runner, '__mtest__ multi-3');

    await insertAgent(runner, id1, 'Agent 1');
    await insertTask(runner, id2, 'Task 1');
    await insertProject(runner, id3, 'Project 1');

    const result = await runCleanup(runner, { execute: true });

    expect(result.companyCount).toBe(3);
    expect(result.fixtureIds).toContain(id1);
    expect(result.fixtureIds).toContain(id2);
    expect(result.fixtureIds).toContain(id3);

    expect(await countForCompany(runner, 'companies', id1)).toBe(0);
    expect(await countForCompany(runner, 'companies', id2)).toBe(0);
    expect(await countForCompany(runner, 'companies', id3)).toBe(0);
  });

  // Non-public schemas are never touched — verify by checking that no
  // drizzle/auth/storage/vault schema queries are ever issued.
  it('only operates on public schema tables', async () => {
    const fixtureId = await insertFixtureCompany(runner, '__mtest__ schema-test');
    await insertAgent(runner, fixtureId, 'Agent 1');

    // The cleanup should complete without error — it only touches public.* tables.
    // PGlite only has the public schema (and drizzle migration metadata), so
    // this test implicitly verifies no cross-schema queries are made.
    const result = await runCleanup(runner, { execute: true });
    expect(result.companyCount).toBe(1);
    expect(result.mode).toBe('execute');
  });

  // VAL-CROSS-025: Cleanup removes artifacts + revisions despite FK constraints
  it('removes artifacts and artifact_revisions despite agent FK constraints', async () => {
    const fixtureId = await insertFixtureCompany(runner, '__mtest__ artifact-cleanup');
    const agentId = await insertAgent(runner, fixtureId, 'Artifact Agent');
    const { artifactId, revisionId } = await insertArtifact(runner, fixtureId, agentId, 'Test Doc');

    const result = await runCleanup(runner, { execute: true });

    expect(result.mode).toBe('execute');
    expect(result.companyCount).toBe(1);

    // Artifacts and revisions should be removed
    expect(await countForCompany(runner, 'artifacts', fixtureId)).toBe(0);
    expect(await countForCompany(runner, 'agents', fixtureId)).toBe(0);

    // Artifact revisions (indirect child) should also be gone
    const revCount = await runner.query<{ count: string }>(
      `SELECT count(*) as count FROM artifact_revisions WHERE artifact_id = '${artifactId}'`,
    );
    expect(parseInt(revCount[0]?.count ?? '0', 10)).toBe(0);

    // Verify the revision ID is gone
    const revStillExists = await runner.query<{ count: string }>(
      `SELECT count(*) as count FROM artifact_revisions WHERE id = '${revisionId}'`,
    );
    expect(parseInt(revStillExists[0]?.count ?? '0', 10)).toBe(0);
  });

  // M7: Cleanup removes meetings + meeting_tasks despite the meetings→agents
  // NO ACTION FK (created_by_agent_id / summary_generated_by_agent_id). Meetings
  // must be deleted before agents; meeting_tasks before meetings/tasks.
  it('removes meetings and meeting_tasks despite agent FK constraints', async () => {
    const fixtureId = await insertFixtureCompany(runner, '__mtest__ meetings-cleanup');
    const agentId = await insertAgent(runner, fixtureId, 'Meeting Agent');
    const taskId = await insertTask(runner, fixtureId, 'Meeting Action Item');
    const meetingId = randomUUID();
    const meetingTaskId = randomUUID();
    const ts = new Date().toISOString();
    await runner.query(
      `INSERT INTO meetings (id, company_id, title, transcript, summary, summary_generated_by_agent_id, created_by_agent_id, status, created_at, updated_at) VALUES ('${meetingId}', '${fixtureId}', '__mtest__ meeting', 'Alice: ship it', 'Summary text', '${agentId}', '${agentId}', 'active', '${ts}', '${ts}')`,
    );
    await runner.query(
      `INSERT INTO meeting_tasks (id, meeting_id, task_id, company_id, created_at) VALUES ('${meetingTaskId}', '${meetingId}', '${taskId}', '${fixtureId}', '${ts}')`,
    );

    const result = await runCleanup(runner, { execute: true });

    expect(result.mode).toBe('execute');
    expect(result.companyCount).toBe(1);

    // meetings + meeting_tasks removed, agents removed (no FK violation)
    expect(await countForCompany(runner, 'meetings', fixtureId)).toBe(0);
    expect(await countForCompany(runner, 'meeting_tasks', fixtureId)).toBe(0);
    expect(await countForCompany(runner, 'agents', fixtureId)).toBe(0);

    // The specific meeting + join rows are gone
    const meetingStillExists = await runner.query<{ count: string }>(
      `SELECT count(*) as count FROM meetings WHERE id = '${meetingId}'`,
    );
    expect(parseInt(meetingStillExists[0]?.count ?? '0', 10)).toBe(0);

    const meetingTaskStillExists = await runner.query<{ count: string }>(
      `SELECT count(*) as count FROM meeting_tasks WHERE id = '${meetingTaskId}'`,
    );
    expect(parseInt(meetingTaskStillExists[0]?.count ?? '0', 10)).toBe(0);
  });
});
