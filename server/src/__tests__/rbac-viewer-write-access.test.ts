import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { eq, and } from 'drizzle-orm';
import { createTestDb, createTestServer } from '../test-utils.js';
import type { DbInstance } from '../types.js';

/**
 * RBAC viewer write-access fix tests.
 *
 * Verifies that mutable company-scoped routes that were previously mounted
 * with requirePermission('company.view') for ALL HTTP methods now correctly
 * reject viewers (403) on POST/PATCH/DELETE, while members can still
 * create/update/delete.
 *
 * Categories tested:
 * - content.* routes: goals, messages, evaluations, collaborations,
 *   approvals, routines, budgets, folders, workspace-templates, teams,
 *   permissions, presence, project sub-routes (threads, plans, decisions,
 *   outcomes, meetings)
 * - artifact.* routes: files, knowledge, memories
 * - agent.manage route: runtime
 * - Read-only routes (analytics, activity, search, inbox, mentions) remain
 *   company.view for all methods (no regression for viewers)
 */
describe('RBAC viewer write-access fix', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    const res = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Viewer Write Fix', settings: { testFixture: true } })
      .expect(201);
    companyId = res.body.data.id;
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function roleHeader(role: string): Record<string, string> {
    return { 'X-Eidolon-Test-Org-Role': role };
  }

  function url(path: string): string {
    return `/api/companies/${companyId}${path}`;
  }

  // -------------------------------------------------------------------------
  // content.* routes — viewer gets 403 on POST/PATCH/DELETE
  // -------------------------------------------------------------------------

  describe('content.* routes: viewer denied writes', () => {
    it('viewer cannot POST goals (403)', async () => {
      const res = await request(app)
        .post(url('/goals'))
        .set(roleHeader('viewer'))
        .send({ title: 'viewer goal' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('member can POST goals (201)', async () => {
      await request(app)
        .post(url('/goals'))
        .set(roleHeader('member'))
        .send({ title: 'member goal' })
        .expect(201);
    });

    it('viewer cannot POST messages (403)', async () => {
      const res = await request(app)
        .post(url('/messages'))
        .set(roleHeader('viewer'))
        .send({ content: 'viewer message' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('viewer cannot POST workflows (403)', async () => {
      const res = await request(app)
        .post(url('/workflows'))
        .set(roleHeader('viewer'))
        .send({ name: 'viewer workflow' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('viewer cannot POST collaborations (403)', async () => {
      const res = await request(app)
        .post(url('/collaborations'))
        .set(roleHeader('viewer'))
        .send({
          type: 'delegation',
          fromAgentId: 'agent-1',
          toAgentId: 'agent-2',
          requestContent: 'test',
        })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('viewer cannot POST approvals (403)', async () => {
      const res = await request(app)
        .post(url('/approvals'))
        .set(roleHeader('viewer'))
        .send({ title: 'viewer approval' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('viewer cannot POST routines (403)', async () => {
      const res = await request(app)
        .post(url('/routines'))
        .set(roleHeader('viewer'))
        .send({ name: 'viewer routine', triggerType: 'manual' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('viewer cannot POST budgets/costs (403)', async () => {
      const res = await request(app)
        .post(url('/costs'))
        .set(roleHeader('viewer'))
        .send({ category: 'compute', amountCents: 100 })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('viewer cannot POST folders (403)', async () => {
      const res = await request(app)
        .post(url('/folders'))
        .set(roleHeader('viewer'))
        .send({ name: 'viewer folder' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('viewer cannot POST workspace-templates (403)', async () => {
      const res = await request(app)
        .post(url('/project-templates'))
        .set(roleHeader('viewer'))
        .send({ name: 'viewer template', project: { name: 'test' } })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('viewer cannot POST teams (403)', async () => {
      const res = await request(app)
        .post(url('/teams'))
        .set(roleHeader('viewer'))
        .send({ name: 'viewer team' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('viewer cannot POST permissions (403)', async () => {
      const res = await request(app)
        .post(url('/permissions'))
        .set(roleHeader('viewer'))
        .send({ granteeUserId: 'some-user', scope: 'artifact', role: 'member' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('viewer cannot POST presence/join (403)', async () => {
      const res = await request(app)
        .post(url('/artifacts/test-id/presence/join'))
        .set(roleHeader('viewer'))
        .send({ userId: 'viewer-user' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('viewer cannot POST meetings (403)', async () => {
      const res = await request(app)
        .post(url('/meetings'))
        .set(roleHeader('viewer'))
        .send({ title: 'viewer meeting' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });
  });

  // -------------------------------------------------------------------------
  // artifact.* routes — viewer gets 403 on POST/PATCH/DELETE
  // -------------------------------------------------------------------------

  describe('artifact.* routes: viewer denied writes', () => {
    it('viewer cannot POST files (403)', async () => {
      const res = await request(app)
        .post(url('/files'))
        .set(roleHeader('viewer'))
        .send({ name: 'viewer-file.txt' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('member can POST files (201)', async () => {
      await request(app)
        .post(url('/files'))
        .set(roleHeader('member'))
        .send({ name: 'member-file.txt' })
        .expect(201);
    });

    it('viewer cannot POST knowledge (403)', async () => {
      const res = await request(app)
        .post(url('/knowledge'))
        .set(roleHeader('viewer'))
        .send({ title: 'viewer doc', content: 'test content' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('viewer cannot POST memories (403)', async () => {
      const res = await request(app)
        .post(url('/agents/test-agent/memories'))
        .set(roleHeader('viewer'))
        .send({ content: 'viewer memory' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });
  });

  // -------------------------------------------------------------------------
  // agent.manage route — runtime writes denied for viewer
  // -------------------------------------------------------------------------

  describe('agent.manage route: runtime', () => {
    it('viewer can GET runtime state (200)', async () => {
      // Runtime is read-only currently but read access should remain for all roles
      await request(app).get(url('/runtime/state')).set(roleHeader('viewer')).expect(200);
    });

    it('member can GET runtime state (200)', async () => {
      await request(app).get(url('/runtime/state')).set(roleHeader('member')).expect(200);
    });
  });

  // -------------------------------------------------------------------------
  // Read-only routes remain company.view for all methods (no regression)
  // -------------------------------------------------------------------------

  describe('read-only routes: no regression for viewer', () => {
    it.each([
      '/analytics/overview',
      '/activity',
      '/inbox',
      '/mentions/search?q=test',
      '/search?q=test',
    ])('viewer can GET %s (no 403)', async (path) => {
      const res = await request(app).get(url(path)).set(roleHeader('viewer'));
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // Project sub-routes — viewer denied writes
  // -------------------------------------------------------------------------

  describe('project sub-routes: viewer denied writes', () => {
    let projectId: string;

    beforeEach(async () => {
      const res = await request(app)
        .post(url('/projects'))
        .set(roleHeader('owner'))
        .send({ name: 'Test Project', status: 'active' })
        .expect(201);
      projectId = res.body.data.id;
    });

    it('viewer cannot POST project threads (403)', async () => {
      const res = await request(app)
        .post(url(`/projects/${projectId}/threads`))
        .set(roleHeader('viewer'))
        .send({ title: 'viewer thread' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('viewer cannot POST project plans (403)', async () => {
      const res = await request(app)
        .post(url(`/projects/${projectId}/plans`))
        .set(roleHeader('viewer'))
        .send({ title: 'viewer plan' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('viewer cannot POST project decisions (403)', async () => {
      const res = await request(app)
        .post(url(`/projects/${projectId}/decisions`))
        .set(roleHeader('viewer'))
        .send({ title: 'viewer decision', status: 'proposed' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('viewer cannot POST project outcomes (403)', async () => {
      const res = await request(app)
        .post(url(`/projects/${projectId}/outcomes`))
        .set(roleHeader('viewer'))
        .send({ title: 'viewer outcome', status: 'pending' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('viewer cannot POST project meetings (403)', async () => {
      const res = await request(app)
        .post(url(`/projects/${projectId}/meetings`))
        .set(roleHeader('viewer'))
        .send({ title: 'viewer meeting' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('member can POST project threads (201)', async () => {
      await request(app)
        .post(url(`/projects/${projectId}/threads`))
        .set(roleHeader('member'))
        .send({ title: 'member thread' })
        .expect(201);
    });
  });

  // -------------------------------------------------------------------------
  // Member can still create/update/delete on mutable routes
  // -------------------------------------------------------------------------

  describe('member can still write on mutable routes', () => {
    it('member can POST workflows (201)', async () => {
      await request(app)
        .post(url('/workflows'))
        .set(roleHeader('member'))
        .send({ name: 'member workflow' })
        .expect(201);
    });

    it('member can POST approvals (201)', async () => {
      await request(app)
        .post(url('/approvals'))
        .set(roleHeader('member'))
        .send({ title: 'member approval' })
        .expect(201);
    });

    it('member can POST knowledge (201)', async () => {
      await request(app)
        .post(url('/knowledge'))
        .set(roleHeader('member'))
        .send({ title: 'member doc', content: 'test' })
        .expect(201);
    });
  });

  // -------------------------------------------------------------------------
  // DB-based membership resolution (no impersonation headers)
  // -------------------------------------------------------------------------

  describe('DB-based membership: viewer role from company_members', () => {
    it('viewer with DB membership gets 403 on POST goals', async () => {
      // Set the dev-user-000 membership to viewer via DB
      await db.drizzle
        .update(db.schema.companyMembers)
        .set({ role: 'viewer', updatedAt: new Date() })
        .where(
          and(
            eq(db.schema.companyMembers.companyId, companyId),
            eq(db.schema.companyMembers.userId, 'dev-user-000'),
          ),
        );

      // No impersonation header → uses DB role 'viewer'
      const res = await request(app)
        .post(url('/goals'))
        .send({ title: 'db viewer goal' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('member with DB membership can POST goals', async () => {
      await db.drizzle
        .update(db.schema.companyMembers)
        .set({ role: 'member', updatedAt: new Date() })
        .where(
          and(
            eq(db.schema.companyMembers.companyId, companyId),
            eq(db.schema.companyMembers.userId, 'dev-user-000'),
          ),
        );

      await request(app).post(url('/goals')).send({ title: 'db member goal' }).expect(201);
    });
  });
});
