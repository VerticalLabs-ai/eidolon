import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { eq, and, sql } from 'drizzle-orm';
import { createTestDb, createTestServer } from '../test-utils.js';
import type { DbInstance } from '../types.js';

/**
 * RBAC route migration tests.
 *
 * Verifies that all company-scoped route mounts migrated from
 * requireOrgMember('admin'/'member') to requirePermission('specific.permission')
 * enforce the correct permission boundaries per the matrix in architecture.md.
 *
 * Covers:
 * - VAL-RBAC-001: Owner has the complete permission set
 * - VAL-RBAC-002: Admin has the administrative permission boundary
 * - VAL-RBAC-003: Member has the contributor permission boundary
 * - VAL-RBAC-004: Viewer has the read-only permission boundary
 * - VAL-RBAC-005: Unknown or invalid roles are denied
 * - VAL-RBAC-017: Migrated read routes remain functional for all roles
 * - VAL-RBAC-018: Migrated write routes enforce specific permissions
 * - VAL-RBAC-019: Viewer can read but cannot create, edit, or delete
 * - VAL-RBAC-020: Member can create and edit but not manage settings or members
 * - VAL-RBAC-021: Admin manages settings and members but not ownership controls
 * - VAL-RBAC-022: Owner can promote, demote, and delete
 * - VAL-CROSS-010: Membership role is isolated per company
 */
describe('RBAC route migration', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    const res = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Route Migration', settings: { testFixture: true } })
      .expect(201);
    companyId = res.body.data.id;
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Headers to impersonate a specific org role in local_trusted mode. */
  function roleHeader(role: string): Record<string, string> {
    return { 'X-Eidolon-Test-Org-Role': role };
  }

  /** Base URL for a company-scoped route. */
  function url(path: string): string {
    return `/api/companies/${companyId}${path}`;
  }

  /** Update the dev-user-000 membership role for the test company. */
  async function setRole(role: string): Promise<void> {
    await db.drizzle
      .update(db.schema.companyMembers)
      .set({ role: role as any, updatedAt: new Date() })
      .where(
        and(
          eq(db.schema.companyMembers.companyId, companyId),
          eq(db.schema.companyMembers.userId, 'dev-user-000'),
        ),
      );
  }

  // -------------------------------------------------------------------------
  // VAL-RBAC-017: Migrated read routes remain functional for all roles
  // -------------------------------------------------------------------------

  describe('VAL-RBAC-017: migrated read routes remain functional for all roles', () => {
    const readRoutes: { path: string; name: string }[] = [
      { path: '/agents', name: 'agents' },
      { path: '/tasks', name: 'tasks' },
      { path: '/projects', name: 'projects' },
      { path: '/artifacts', name: 'artifacts' },
      { path: '/goals', name: 'goals' },
      { path: '/analytics/overview', name: 'analytics' },
      { path: '/activity', name: 'activity' },
      { path: '/inbox', name: 'inbox' },
      { path: '/mentions/search?q=test', name: 'mentions' },
      { path: '/search?q=test', name: 'search' },
    ];

    it.each(['owner', 'admin', 'member', 'viewer'] as const)(
      'role=%s can GET all migrated read routes (no 401/403)',
      async (role) => {
        for (const route of readRoutes) {
          const res = await request(app).get(url(route.path)).set(roleHeader(role));
          // Must NOT be 401 (unauthenticated) or 403 (forbidden)
          expect(res.status, `GET ${route.name} as ${role}`).not.toBe(401);
          expect(res.status, `GET ${route.name} as ${role}`).not.toBe(403);
        }
      },
    );
  });

  // -------------------------------------------------------------------------
  // VAL-RBAC-019: Viewer can read but cannot create, edit, or delete
  // -------------------------------------------------------------------------

  describe('VAL-RBAC-019: viewer can read but cannot create, edit, or delete', () => {
    it('viewer can read artifacts', async () => {
      await request(app).get(url('/artifacts')).set(roleHeader('viewer')).expect(200);
    });

    it('viewer cannot create artifacts (403 INSUFFICIENT_PERMISSION)', async () => {
      const res = await request(app)
        .post(url('/artifacts'))
        .set(roleHeader('viewer'))
        .send({ type: 'document', title: 'test', content: { format: 'markdown', body: '# Hello' } })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('viewer cannot create tasks (403)', async () => {
      const res = await request(app)
        .post(url('/tasks'))
        .set(roleHeader('viewer'))
        .send({ title: 'viewer task' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('viewer cannot create projects (403)', async () => {
      const res = await request(app)
        .post(url('/projects'))
        .set(roleHeader('viewer'))
        .send({ name: 'viewer project' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('viewer cannot create agents (403)', async () => {
      const res = await request(app)
        .post(url('/agents'))
        .set(roleHeader('viewer'))
        .send({
          name: 'viewer agent',
          role: 'custom',
          provider: 'anthropic',
          model: 'test',
        })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('viewer cannot send chat messages (403)', async () => {
      const res = await request(app)
        .post(url('/chat/send'))
        .set(roleHeader('viewer'))
        .send({ content: 'test message' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });
  });

  // -------------------------------------------------------------------------
  // VAL-RBAC-020: Member can create and edit but not manage settings or members
  // -------------------------------------------------------------------------

  describe('VAL-RBAC-020: member can create and edit but not manage', () => {
    it('member can create tasks', async () => {
      await request(app)
        .post(url('/tasks'))
        .set(roleHeader('member'))
        .send({ title: 'member task' })
        .expect(201);
    });

    it('member can create projects', async () => {
      await request(app)
        .post(url('/projects'))
        .set(roleHeader('member'))
        .send({ name: 'member project', status: 'active' })
        .expect(201);
    });

    it('member can create artifacts', async () => {
      await request(app)
        .post(url('/artifacts'))
        .set(roleHeader('member'))
        .send({
          type: 'document',
          title: 'member doc',
          content: { format: 'markdown', body: '# Hello' },
        })
        .expect(201);
    });

    it('member cannot access secrets (403)', async () => {
      const res = await request(app).get(url('/secrets')).set(roleHeader('member')).expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('member cannot access integrations (403)', async () => {
      const res = await request(app)
        .get(url('/integrations'))
        .set(roleHeader('member'))
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('member cannot access MCP (403)', async () => {
      const res = await request(app).get(url('/mcp/servers')).set(roleHeader('member')).expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('member cannot access sessions (403)', async () => {
      const res = await request(app).get(url('/sessions')).set(roleHeader('member')).expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('member cannot access skills (403)', async () => {
      const res = await request(app).get(url('/skills')).set(roleHeader('member')).expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('member cannot access environments (403)', async () => {
      const res = await request(app)
        .get(url('/environments'))
        .set(roleHeader('member'))
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('member cannot access export (403)', async () => {
      const res = await request(app)
        .post(url('/export'))
        .set(roleHeader('member'))
        .send({})
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('member cannot update company settings (403)', async () => {
      const res = await request(app)
        .patch(`/api/companies/${companyId}`)
        .set(roleHeader('member'))
        .send({ name: 'Updated by Member' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });
  });

  // -------------------------------------------------------------------------
  // VAL-RBAC-021: Admin manages settings and members but not ownership controls
  // -------------------------------------------------------------------------

  describe('VAL-RBAC-021: admin manages settings but not owner-only ops', () => {
    it('admin can access secrets', async () => {
      await request(app).get(url('/secrets')).set(roleHeader('admin')).expect(200);
    });

    it('admin can access integrations', async () => {
      await request(app).get(url('/integrations')).set(roleHeader('admin')).expect(200);
    });

    it('admin can access MCP', async () => {
      await request(app).get(url('/mcp/servers')).set(roleHeader('admin')).expect(200);
    });

    it('admin can access sessions', async () => {
      await request(app).get(url('/sessions')).set(roleHeader('admin')).expect(200);
    });

    it('admin can access skills', async () => {
      await request(app).get(url('/skills')).set(roleHeader('admin')).expect(200);
    });

    it('admin can access environments', async () => {
      await request(app).get(url('/environments')).set(roleHeader('admin')).expect(200);
    });

    it('admin can access export', async () => {
      await request(app).post(url('/export')).set(roleHeader('admin')).send({}).expect(201);
    });

    it('admin can update company settings', async () => {
      await request(app)
        .patch(`/api/companies/${companyId}`)
        .set(roleHeader('admin'))
        .send({ name: 'Updated by Admin' })
        .expect(200);
    });

    it('admin cannot delete company (403)', async () => {
      const res = await request(app)
        .delete(`/api/companies/${companyId}`)
        .set(roleHeader('admin'))
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });
  });

  // -------------------------------------------------------------------------
  // VAL-RBAC-001 / VAL-RBAC-022: Owner has the complete permission set
  // -------------------------------------------------------------------------

  describe('VAL-RBAC-001/022: owner has the complete permission set', () => {
    it('owner can access secrets', async () => {
      await request(app).get(url('/secrets')).set(roleHeader('owner')).expect(200);
    });

    it('owner can create artifacts', async () => {
      await request(app)
        .post(url('/artifacts'))
        .set(roleHeader('owner'))
        .send({
          type: 'document',
          title: 'owner doc',
          content: { format: 'markdown', body: '# Hello' },
        })
        .expect(201);
    });

    it('owner can update company settings', async () => {
      await request(app)
        .patch(`/api/companies/${companyId}`)
        .set(roleHeader('owner'))
        .send({ name: 'Updated by Owner' })
        .expect(200);
    });

    it('owner can delete company (soft delete)', async () => {
      // Create a separate company for the delete test so other tests are unaffected
      const res = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Delete Target', settings: { testFixture: true } })
        .expect(201);
      const deleteTargetId = res.body.data.id;

      await request(app)
        .delete(`/api/companies/${deleteTargetId}`)
        .set(roleHeader('owner'))
        .expect(200);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-RBAC-002/003/004: Permission boundary summary via admin route
  // -------------------------------------------------------------------------

  describe('VAL-RBAC-002/003/004: admin route permission boundaries', () => {
    it.each([
      ['owner', 200],
      ['admin', 200],
      ['member', 403],
      ['viewer', 403],
    ] as const)('GET /secrets as %s → %d', async (role, expectedStatus) => {
      const res = await request(app)
        .get(url('/secrets'))
        .set(roleHeader(role))
        .expect(expectedStatus);
      if (expectedStatus === 403) {
        expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
      }
    });
  });

  // -------------------------------------------------------------------------
  // VAL-RBAC-018: Migrated write routes enforce specific permissions
  // -------------------------------------------------------------------------

  describe('VAL-RBAC-018: migrated write routes enforce specific permissions', () => {
    it.each([
      ['owner', 201],
      ['admin', 201],
      ['member', 201],
      ['viewer', 403],
    ] as const)('POST /artifacts as %s → %d', async (role, expectedStatus) => {
      const res = await request(app)
        .post(url('/artifacts'))
        .set(roleHeader(role))
        .send({
          type: 'document',
          title: `test-${role}`,
          content: { format: 'markdown', body: '# Hello' },
        });
      expect(res.status).toBe(expectedStatus);
      if (expectedStatus === 403) {
        expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
      }
    });

    it.each([
      ['owner', 201],
      ['admin', 201],
      ['member', 201],
      ['viewer', 403],
    ] as const)('POST /tasks as %s → %d', async (role, expectedStatus) => {
      const res = await request(app)
        .post(url('/tasks'))
        .set(roleHeader(role))
        .send({ title: `test-${role}` });
      expect(res.status).toBe(expectedStatus);
      if (expectedStatus === 403) {
        expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
      }
    });

    it.each([
      ['owner', 201],
      ['admin', 201],
      ['member', 201],
      ['viewer', 403],
    ] as const)('POST /projects as %s → %d', async (role, expectedStatus) => {
      const res = await request(app)
        .post(url('/projects'))
        .set(roleHeader(role))
        .send({ name: `test-${role}`, status: 'active' });
      expect(res.status).toBe(expectedStatus);
      if (expectedStatus === 403) {
        expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
      }
    });
  });

  // -------------------------------------------------------------------------
  // VAL-RBAC-005: Unknown or invalid roles are denied
  // -------------------------------------------------------------------------

  describe('VAL-RBAC-005: unknown or invalid roles are denied', () => {
    it('invalid role in company_members is denied (403)', async () => {
      // Update the membership to an invalid role via raw SQL (the Drizzle
      // type-level enum prevents inserting via the typed API)
      await db.drizzle.execute(
        sql`UPDATE company_members SET role = 'superadmin' WHERE company_id = ${companyId} AND user_id = 'dev-user-000'`,
      );

      // No impersonation header → uses DB role 'superadmin'
      const res = await request(app).get(url('/agents')).expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('invalid role denied on admin route (403)', async () => {
      await db.drizzle.execute(
        sql`UPDATE company_members SET role = 'superadmin' WHERE company_id = ${companyId} AND user_id = 'dev-user-000'`,
      );

      const res = await request(app).get(url('/secrets')).expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('invalid role denied on write route (403)', async () => {
      await db.drizzle.execute(
        sql`UPDATE company_members SET role = 'superadmin' WHERE company_id = ${companyId} AND user_id = 'dev-user-000'`,
      );

      const res = await request(app)
        .post(url('/artifacts'))
        .send({
          type: 'document',
          title: 'invalid role test',
          content: { format: 'markdown', body: '# Hello' },
        })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });
  });

  // -------------------------------------------------------------------------
  // VAL-CROSS-010: Membership role is isolated per company
  // -------------------------------------------------------------------------

  describe('VAL-CROSS-010: membership role is isolated per company', () => {
    it('admin in A, viewer in B → admin ops in A succeed, denied in B', async () => {
      // Create company B
      const resB = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Company B', settings: { testFixture: true } })
        .expect(201);
      const companyIdB = resB.body.data.id;

      // Set dev-user-000 to admin in A (companyId), viewer in B (companyIdB)
      await db.drizzle
        .update(db.schema.companyMembers)
        .set({ role: 'admin', updatedAt: new Date() })
        .where(
          and(
            eq(db.schema.companyMembers.companyId, companyId),
            eq(db.schema.companyMembers.userId, 'dev-user-000'),
          ),
        );
      await db.drizzle
        .update(db.schema.companyMembers)
        .set({ role: 'viewer', updatedAt: new Date() })
        .where(
          and(
            eq(db.schema.companyMembers.companyId, companyIdB),
            eq(db.schema.companyMembers.userId, 'dev-user-000'),
          ),
        );

      // Admin can access secrets in A (no impersonation header → DB role)
      await request(app).get(url('/secrets')).expect(200);

      // Viewer cannot access secrets in B
      const res = await request(app).get(`/api/companies/${companyIdB}/secrets`).expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('admin in A can update settings in A, viewer in B cannot update B', async () => {
      const resB = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Company B', settings: { testFixture: true } })
        .expect(201);
      const companyIdB = resB.body.data.id;

      await db.drizzle
        .update(db.schema.companyMembers)
        .set({ role: 'admin', updatedAt: new Date() })
        .where(
          and(
            eq(db.schema.companyMembers.companyId, companyId),
            eq(db.schema.companyMembers.userId, 'dev-user-000'),
          ),
        );
      await db.drizzle
        .update(db.schema.companyMembers)
        .set({ role: 'viewer', updatedAt: new Date() })
        .where(
          and(
            eq(db.schema.companyMembers.companyId, companyIdB),
            eq(db.schema.companyMembers.userId, 'dev-user-000'),
          ),
        );

      // Admin can update settings in A
      await request(app)
        .patch(`/api/companies/${companyId}`)
        .send({ name: 'Updated A' })
        .expect(200);

      // Viewer cannot update settings in B
      const res = await request(app)
        .patch(`/api/companies/${companyIdB}`)
        .send({ name: 'Updated B' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('member in A can create tasks in A, viewer in B cannot in B', async () => {
      const resB = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Company B', settings: { testFixture: true } })
        .expect(201);
      const companyIdB = resB.body.data.id;

      await db.drizzle
        .update(db.schema.companyMembers)
        .set({ role: 'member', updatedAt: new Date() })
        .where(
          and(
            eq(db.schema.companyMembers.companyId, companyId),
            eq(db.schema.companyMembers.userId, 'dev-user-000'),
          ),
        );
      await db.drizzle
        .update(db.schema.companyMembers)
        .set({ role: 'viewer', updatedAt: new Date() })
        .where(
          and(
            eq(db.schema.companyMembers.companyId, companyIdB),
            eq(db.schema.companyMembers.userId, 'dev-user-000'),
          ),
        );

      // Member can create tasks in A
      await request(app).post(url('/tasks')).send({ title: 'task in A' }).expect(201);

      // Viewer cannot create tasks in B
      const res = await request(app)
        .post(`/api/companies/${companyIdB}/tasks`)
        .send({ title: 'task in B' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });
  });

  // -------------------------------------------------------------------------
  // Backward compatibility: default owner access in local_trusted
  // -------------------------------------------------------------------------

  describe('backward compatibility: local_trusted default owner access', () => {
    it('no impersonation header and no membership → default owner access', async () => {
      // The company was created by dev-user-000, so there IS a membership
      // with role=owner. But even without it, local_trusted defaults to owner.
      // Test with a company that has no membership for dev-user-000:
      await db.drizzle
        .delete(db.schema.companyMembers)
        .where(eq(db.schema.companyMembers.companyId, companyId));

      // No impersonation header → defaults to owner
      await request(app).get(url('/agents')).expect(200);
      await request(app).get(url('/secrets')).expect(200);
    });

    it('existing tests still work: owner can access all routes', async () => {
      // No impersonation header → DB membership role is owner (auto-created)
      await request(app).get(url('/agents')).expect(200);
      await request(app).get(url('/tasks')).expect(200);
      await request(app).get(url('/artifacts')).expect(200);
      await request(app).get(url('/secrets')).expect(200);
      await request(app).get(url('/integrations')).expect(200);
      await request(app).get(url('/mcp/servers')).expect(200);
    });
  });
});
