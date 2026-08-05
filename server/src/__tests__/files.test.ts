import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { eq, and, sql } from 'drizzle-orm';
import { createTestServer, createTestDb } from '../test-utils.js';
import type { DbInstance } from '../types.js';

describe('Files API — project scoping', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;
  let projectId: string;
  let agentId: string;
  let otherCompanyId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: 'Files Test Corp' })
      .expect(201);
    companyId = company.body.data.id;

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: 'Other Files Corp' })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Scoped project' })
      .expect(201);
    projectId = project.body.data.id;

    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'File Agent', role: 'engineer' })
      .expect(201);
    agentId = agent.body.data.id;
  });

  // Helper: create a file via the API (returns the supertest Test for chaining)
  function createFile(body: Record<string, unknown>, company = companyId) {
    return request(app).post(`/api/companies/${company}/files`).send(body);
  }

  // Helper: insert a raw agent_files row bypassing the API (for backfill tests)
  async function insertRawFile(values: Record<string, unknown>): Promise<string> {
    const id = randomUUID();
    const now = new Date();
    await db.drizzle
      .insert(db.schema.agentFiles)
      .values({
        id,
        companyId: values.companyId as string,
        agentId: (values.agentId as string) ?? null,
        name: (values.name as string) ?? 'raw-file.txt',
        path: (values.path as string) ?? '/raw-file.txt',
        mimeType: 'text/plain',
        sizeBytes: 0,
        content: null,
        storageType: 'inline',
        parentId: null,
        isDirectory: false,
        taskId: (values.taskId as string) ?? null,
        executionId: null,
        projectId: (values.projectId as string) ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return id;
  }

  // -------------------------------------------------------------------------
  // VAL-FILES-001: GET /files filters by project when ?project= provided
  // -------------------------------------------------------------------------
  describe('VAL-FILES-001: filter by project', () => {
    it('returns only files with projectId === project when ?project= is provided', async () => {
      await createFile({ name: 'p1.txt', projectId });
      await createFile({ name: 'p2.txt', projectId });
      await createFile({ name: 'p3.txt', projectId });
      // unscoped files
      await createFile({ name: 'unscoped-1.txt' });
      await createFile({ name: 'unscoped-2.txt' });

      const res = await request(app)
        .get(`/api/companies/${companyId}/files`)
        .query({ project: projectId })
        .expect(200);

      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(3);
      for (const row of res.body.data) {
        expect(row.projectId).toBe(projectId);
        expect(row.companyId).toBe(companyId);
      }
    });
  });

  // -------------------------------------------------------------------------
  // VAL-FILES-002: GET /files without project is backward compatible
  // -------------------------------------------------------------------------
  describe('VAL-FILES-002: backward compatible unfiltered list', () => {
    it('returns all company files (scoped + null) without project param', async () => {
      await createFile({ name: 'scoped.txt', projectId });
      await createFile({ name: 'unscoped.txt' });

      const res = await request(app)
        .get(`/api/companies/${companyId}/files`)
        .expect(200);

      expect(res.body.data.length).toBeGreaterThanOrEqual(2);
      const projectIds = res.body.data.map((r: any) => r.projectId);
      expect(projectIds).toContain(projectId);
      expect(projectIds).toContain(null);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-FILES-003: files from another project excluded when filtered
  // -------------------------------------------------------------------------
  describe('VAL-FILES-003: other project files excluded', () => {
    it('excludes files from a different project in the same company', async () => {
      // Use two projects in the same company
      const projA = await request(app)
        .post(`/api/companies/${companyId}/projects`)
        .send({ name: 'Project A' })
        .expect(201);
      const projOther = await request(app)
        .post(`/api/companies/${companyId}/projects`)
        .send({ name: 'Project Other' })
        .expect(201);

      await createFile({ name: 'a1.txt', projectId: projA.body.data.id });
      await createFile({ name: 'a2.txt', projectId: projA.body.data.id });
      await createFile({ name: 'other1.txt', projectId: projOther.body.data.id });

      const res = await request(app)
        .get(`/api/companies/${companyId}/files`)
        .query({ project: projA.body.data.id })
        .expect(200);

      expect(res.body.data).toHaveLength(2);
      for (const row of res.body.data) {
        expect(row.projectId).toBe(projA.body.data.id);
      }
      expect(res.body.data.some((r: any) => r.projectId === projOther.body.data.id)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-FILES-004: unscoped files excluded when project filter applied
  // -------------------------------------------------------------------------
  describe('VAL-FILES-004: unscoped excluded under filter', () => {
    it('returns no null projectId rows when ?project= applied', async () => {
      await createFile({ name: 'scoped.txt', projectId });
      await createFile({ name: 'unscoped.txt' });

      const res = await request(app)
        .get(`/api/companies/${companyId}/files`)
        .query({ project: projectId })
        .expect(200);

      for (const row of res.body.data) {
        expect(row.projectId).not.toBeNull();
        expect(row.projectId).toBe(projectId);
      }
    });
  });

  // -------------------------------------------------------------------------
  // VAL-FILES-005: empty project returns zero files (not an error)
  // -------------------------------------------------------------------------
  describe('VAL-FILES-005: empty project', () => {
    it('returns 200 with an empty array for a project with no files', async () => {
      const emptyProj = await request(app)
        .post(`/api/companies/${companyId}/projects`)
        .send({ name: 'Empty project' })
        .expect(201);

      const res = await request(app)
        .get(`/api/companies/${companyId}/files`)
        .query({ project: emptyProj.body.data.id })
        .expect(200);

      expect(res.body.data).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-FILES-006: create with projectId persists association
  // -------------------------------------------------------------------------
  describe('VAL-FILES-006: create with projectId', () => {
    it('persists projectId and the file appears in the project-filtered list', async () => {
      const res = await createFile({ name: 'project-file.txt', projectId }).expect(201);

      expect(res.body.data.projectId).toBe(projectId);

      const filtered = await request(app)
        .get(`/api/companies/${companyId}/files`)
        .query({ project: projectId })
        .expect(200);

      expect(filtered.body.data.some((r: any) => r.id === res.body.data.id)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-FILES-007: create without projectId remains unscoped (null)
  // -------------------------------------------------------------------------
  describe('VAL-FILES-007: create without projectId stays null', () => {
    it('created row has projectId === null and is absent from ?project= but present unfiltered', async () => {
      const res = await createFile({ name: 'unscoped-create.txt' }).expect(201);

      expect(res.body.data.projectId).toBeNull();

      const filtered = await request(app)
        .get(`/api/companies/${companyId}/files`)
        .query({ project: projectId })
        .expect(200);

      expect(filtered.body.data.some((r: any) => r.id === res.body.data.id)).toBe(false);

      const unfiltered = await request(app)
        .get(`/api/companies/${companyId}/files`)
        .expect(200);

      expect(unfiltered.body.data.some((r: any) => r.id === res.body.data.id)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-FILES-008: create with cross-company projectId rejected, no file created
  // -------------------------------------------------------------------------
  describe('VAL-FILES-008: cross-company projectId rejected', () => {
    it('rejects a projectId from another company with 404 and writes no row', async () => {
      const foreignProj = await request(app)
        .post(`/api/companies/${otherCompanyId}/projects`)
        .send({ name: 'Foreign' })
        .expect(201);

      const beforeCount = await db.drizzle
        .select({ count: sql<number>`count(*)` })
        .from(db.schema.agentFiles)
        .where(eq(db.schema.agentFiles.companyId, companyId));

      await createFile({ name: 'cross-company.txt', projectId: foreignProj.body.data.id })
        .expect(404)
        .expect(({ body }) => {
          expect(body.code).toBe('PROJECT_INVALID');
        });

      const afterCount = await db.drizzle
        .select({ count: sql<number>`count(*)` })
        .from(db.schema.agentFiles)
        .where(eq(db.schema.agentFiles.companyId, companyId));

      expect(Number(afterCount[0].count)).toBe(Number(beforeCount[0].count));
    });
  });

  // -------------------------------------------------------------------------
  // VAL-FILES-009: create with non-existent projectId rejected, no file created
  // -------------------------------------------------------------------------
  describe('VAL-FILES-009: non-existent projectId rejected', () => {
    it('rejects a valid UUID that does not exist in projects with 404 and writes no row', async () => {
      const beforeCount = await db.drizzle
        .select({ count: sql<number>`count(*)` })
        .from(db.schema.agentFiles)
        .where(eq(db.schema.agentFiles.companyId, companyId));

      await createFile({ name: 'nonexistent.txt', projectId: randomUUID() })
        .expect(404)
        .expect(({ body }) => {
          expect(body.code).toBe('PROJECT_INVALID');
        });

      const afterCount = await db.drizzle
        .select({ count: sql<number>`count(*)` })
        .from(db.schema.agentFiles)
        .where(eq(db.schema.agentFiles.companyId, companyId));

      expect(Number(afterCount[0].count)).toBe(Number(beforeCount[0].count));
    });
  });

  // -------------------------------------------------------------------------
  // VAL-FILES-010: update sets/changes projectId with ownership validation
  // -------------------------------------------------------------------------
  describe('VAL-FILES-010: update projectId with ownership validation', () => {
    it('sets, changes, and rejects cross-company projectId on update', async () => {
      const file = await createFile({ name: 'updateable.txt' }).expect(201);

      // set from null to projectA
      const projA = await request(app)
        .post(`/api/companies/${companyId}/projects`)
        .send({ name: 'Proj A' })
        .expect(201);
      const projOther = await request(app)
        .post(`/api/companies/${companyId}/projects`)
        .send({ name: 'Proj Other' })
        .expect(201);

      const set1 = await request(app)
        .patch(`/api/companies/${companyId}/files/${file.body.data.id}`)
        .send({ projectId: projA.body.data.id })
        .expect(200);
      expect(set1.body.data.projectId).toBe(projA.body.data.id);

      // change to another same-company project
      const set2 = await request(app)
        .patch(`/api/companies/${companyId}/files/${file.body.data.id}`)
        .send({ projectId: projOther.body.data.id })
        .expect(200);
      expect(set2.body.data.projectId).toBe(projOther.body.data.id);

      // cross-company attempt rejected, row unchanged
      const foreignProj = await request(app)
        .post(`/api/companies/${otherCompanyId}/projects`)
        .send({ name: 'Foreign' })
        .expect(201);

      await request(app)
        .patch(`/api/companies/${companyId}/files/${file.body.data.id}`)
        .send({ projectId: foreignProj.body.data.id })
        .expect(404);

      const [row] = await db.drizzle
        .select({ projectId: db.schema.agentFiles.projectId })
        .from(db.schema.agentFiles)
        .where(eq(db.schema.agentFiles.id, file.body.data.id))
        .limit(1);
      expect(row.projectId).toBe(projOther.body.data.id);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-FILES-011: update can clear projectId back to null
  // -------------------------------------------------------------------------
  describe('VAL-FILES-011: clear projectId to null', () => {
    it('clears projectId and the row leaves the project filter but stays unfiltered', async () => {
      const file = await createFile({ name: 'clearable.txt', projectId }).expect(201);

      const cleared = await request(app)
        .patch(`/api/companies/${companyId}/files/${file.body.data.id}`)
        .send({ projectId: null })
        .expect(200);
      expect(cleared.body.data.projectId).toBeNull();

      const filtered = await request(app)
        .get(`/api/companies/${companyId}/files`)
        .query({ project: projectId })
        .expect(200);
      expect(filtered.body.data.some((r: any) => r.id === file.body.data.id)).toBe(false);

      const unfiltered = await request(app)
        .get(`/api/companies/${companyId}/files`)
        .expect(200);
      expect(unfiltered.body.data.some((r: any) => r.id === file.body.data.id)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-FILES-012: backfill populates projectId from task linkage only
  // -------------------------------------------------------------------------
  describe('VAL-FILES-012: backfill from task linkage', () => {
    it('populates projectId from tasks.projectId for linked rows only', async () => {
      // Create a project-scoped task (has projectId)
      const task = await request(app)
        .post(`/api/companies/${companyId}/tasks`)
        .send({ title: 'Scoped task', projectId })
        .expect(201);

      // Create an unscoped task (no projectId)
      const unscopedTask = await request(app)
        .post(`/api/companies/${companyId}/tasks`)
        .send({ title: 'Unscoped task' })
        .expect(201);

      // Insert raw agent_files rows (projectId = null) as if pre-migration
      const linkedFileId = await insertRawFile({
        companyId,
        name: 'linked.txt',
        path: '/linked.txt',
        taskId: task.body.data.id,
      });
      const unscopedTaskFileId = await insertRawFile({
        companyId,
        name: 'unscoped-task.txt',
        path: '/unscoped-task.txt',
        taskId: unscopedTask.body.data.id,
      });
      const noTaskFileId = await insertRawFile({
        companyId,
        name: 'no-task.txt',
        path: '/no-task.txt',
        taskId: null,
      });

      // Run the same backfill UPDATE as migration 0010 — must match the
      // actual migration SQL exactly (join through projects for FK safety +
      // match company_id across agent_files/tasks/projects).
      await db.drizzle.execute(
        sql`UPDATE "agent_files"
            SET "project_id" = "p"."id"
            FROM "tasks" "t"
            JOIN "projects" "p"
              ON "p"."id" = "t"."project_id"
             AND "p"."company_id" = "t"."company_id"
            WHERE "agent_files"."task_id" = "t"."id"
              AND "agent_files"."company_id" = "t"."company_id"
              AND "agent_files"."project_id" IS NULL`,
      );

      const [linked] = await db.drizzle
        .select({ projectId: db.schema.agentFiles.projectId })
        .from(db.schema.agentFiles)
        .where(eq(db.schema.agentFiles.id, linkedFileId))
        .limit(1);
      expect(linked.projectId).toBe(projectId);

      const [unscopedTaskRow] = await db.drizzle
        .select({ projectId: db.schema.agentFiles.projectId })
        .from(db.schema.agentFiles)
        .where(eq(db.schema.agentFiles.id, unscopedTaskFileId))
        .limit(1);
      expect(unscopedTaskRow.projectId).toBeNull();

      const [noTaskRow] = await db.drizzle
        .select({ projectId: db.schema.agentFiles.projectId })
        .from(db.schema.agentFiles)
        .where(eq(db.schema.agentFiles.id, noTaskFileId))
        .limit(1);
      expect(noTaskRow.projectId).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // VAL-FILES-013: company boundary — another company's files never returned
  // -------------------------------------------------------------------------
  describe('VAL-FILES-013: company boundary', () => {
    it('never returns another company files even when filtering by that company project id', async () => {
      const foreignProj = await request(app)
        .post(`/api/companies/${otherCompanyId}/projects`)
        .send({ name: 'Foreign project' })
        .expect(201);

      // Create a file in the foreign company scoped to its project
      await createFile(
        { name: 'foreign.txt', projectId: foreignProj.body.data.id },
        otherCompanyId,
      ).expect(201);

      // Requesting companyA files filtered by foreignProjectId
      const res = await request(app)
        .get(`/api/companies/${companyId}/files`)
        .query({ project: foreignProj.body.data.id })
        .expect(200);

      for (const row of res.body.data) {
        expect(row.companyId).toBe(companyId);
        expect(row.projectId).not.toBe(foreignProj.body.data.id);
      }
    });
  });

  // -------------------------------------------------------------------------
  // VAL-FILES-014: agentId filter composes with project filter
  // -------------------------------------------------------------------------
  describe('VAL-FILES-014: agentId composes with project', () => {
    it('returns only rows matching both projectId and agentId', async () => {
      const agent2 = await request(app)
        .post(`/api/companies/${companyId}/agents`)
        .send({ name: 'Agent 2', role: 'engineer' })
        .expect(201);

      await createFile({ name: 'a1-p.txt', projectId, agentId });
      await createFile({ name: 'a2-p.txt', projectId, agentId: agent2.body.data.id });
      await createFile({ name: 'a1-unscoped.txt', agentId });

      const res = await request(app)
        .get(`/api/companies/${companyId}/files`)
        .query({ project: projectId, agentId })
        .expect(200);

      for (const row of res.body.data) {
        expect(row.projectId).toBe(projectId);
        expect(row.agentId).toBe(agentId);
      }
      expect(res.body.data.some((r: any) => r.agentId === agent2.body.data.id)).toBe(false);

      // agentId filter still works independently without project
      const agentOnly = await request(app)
        .get(`/api/companies/${companyId}/files`)
        .query({ agentId })
        .expect(200);
      for (const row of agentOnly.body.data) {
        expect(row.agentId).toBe(agentId);
      }
    });
  });

  // -------------------------------------------------------------------------
  // VAL-FILES-015: folders and files are both scoped by projectId
  // -------------------------------------------------------------------------
  describe('VAL-FILES-015: folders and files both scoped', () => {
    it('returns both isDirectory=true and isDirectory=false rows scoped to the project', async () => {
      await createFile({ name: 'folder', isDirectory: true, projectId }).expect(201);
      await createFile({ name: 'file.txt', isDirectory: false, projectId }).expect(201);

      const res = await request(app)
        .get(`/api/companies/${companyId}/files`)
        .query({ project: projectId })
        .expect(200);

      const types = res.body.data.map((r: any) => r.isDirectory);
      expect(types).toContain(true);
      expect(types).toContain(false);
      for (const row of res.body.data) {
        expect(row.projectId).toBe(projectId);
      }
    });
  });

  // -------------------------------------------------------------------------
  // VAL-FILES-016: invalid (non-UUID) project query param rejected
  // -------------------------------------------------------------------------
  describe('VAL-FILES-016: non-UUID project param rejected', () => {
    it('returns 400 for a non-UUID project query param', async () => {
      const res = await request(app)
        .get(`/api/companies/${companyId}/files`)
        .query({ project: 'not-a-uuid' })
        .expect(400);

      expect(res.body).toHaveProperty('code', 'VALIDATION_ERROR');
      expect(res.body).not.toHaveProperty('data');
    });
  });
});
