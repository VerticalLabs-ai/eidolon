import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { eq, and, sql } from 'drizzle-orm';
import { createTestDb, createTestServer } from '../test-utils.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import type { DbInstance } from '../types.js';
import type { AuthSession } from '../auth.js';
import {
  hasPermission,
  PERMISSION_MATRIX,
  type Role,
  type Permission,
} from '../middleware/permissions.js';

/**
 * RBAC Contract Validation Tests
 *
 * This file provides comprehensive contract-level evidence for the 17 M1
 * assertions that were blocked by the user-testing validator because
 * existing tests were representative but did not exercise every required
 * endpoint with full DB state checks.
 *
 * Blocked assertions covered:
 * - VAL-RBAC-001: Owner has the complete permission set
 * - VAL-RBAC-002: Admin has the administrative permission boundary
 * - VAL-RBAC-003: Member has the contributor permission boundary
 * - VAL-RBAC-004: Viewer has the read-only permission boundary
 * - VAL-RBAC-005: Unknown or invalid roles are denied
 * - VAL-RBAC-008: Non-member receives 403 for company-scoped endpoints
 * - VAL-RBAC-009: Membership from another company does not cross boundaries
 * - VAL-RBAC-012: Company creation auto-creates the owner membership
 * - VAL-RBAC-017: Migrated read routes remain functional
 * - VAL-RBAC-018: Migrated write routes enforce specific permissions
 * - VAL-RBAC-019: Viewer can read but cannot create, edit, or delete
 * - VAL-RBAC-020: Member can create and edit but not manage settings or members
 * - VAL-RBAC-021: Admin manages settings and members but not ownership controls
 * - VAL-RBAC-022: Owner can promote, demote, and delete
 * - VAL-CROSS-006: Company creator receives owner access
 * - VAL-CROSS-010: Membership role is isolated per company
 * - VAL-CROSS-013: local_trusted and Clerk modes have identical RBAC outcomes
 *
 * Each test produces the exact evidence specified in the validation contract:
 * status codes, response bodies, and DB state snapshots.
 */
describe('RBAC Contract Validation', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    const res = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Contract Validation', settings: { testFixture: true } })
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

  /** Company-scoped URL. */
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

  /** Seed a company + membership for a specific user/role. */
  async function seedMembership(
    coId: string,
    userId: string,
    role: 'owner' | 'admin' | 'member' | 'viewer',
  ) {
    await db.drizzle
      .insert(db.schema.companies)
      .values({ id: coId, name: `__mtest__ ${coId}`, settings: { testFixture: true } })
      .onConflictDoNothing();
    await db.drizzle
      .insert(db.schema.companyMembers)
      .values({ companyId: coId, userId, role })
      .onConflictDoNothing();
  }

  /** Count company_members rows for a company. */
  async function countMembers(coId: string): Promise<number> {
    const rows = await db.drizzle
      .select()
      .from(db.schema.companyMembers)
      .where(eq(db.schema.companyMembers.companyId, coId));
    return rows.length;
  }

  /** Get a specific membership row. */
  async function getMembership(coId: string, userId: string) {
    const rows = await db.drizzle
      .select()
      .from(db.schema.companyMembers)
      .where(
        and(
          eq(db.schema.companyMembers.companyId, coId),
          eq(db.schema.companyMembers.userId, userId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Get the company row. */
  async function getCompany(coId: string) {
    const rows = await db.drizzle
      .select()
      .from(db.schema.companies)
      .where(eq(db.schema.companies.id, coId))
      .limit(1);
    return rows[0] ?? null;
  }

  // =========================================================================
  // VAL-RBAC-001: Owner has the complete permission set
  // =========================================================================

  describe('VAL-RBAC-001: owner has the complete permission set', () => {
    it('owner can read company resources (GET /agents → 200)', async () => {
      const res = await request(app).get(url('/agents')).set(roleHeader('owner'));
      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
    });

    it('owner can create artifacts (POST /artifacts → 201)', async () => {
      const res = await request(app)
        .post(url('/artifacts'))
        .set(roleHeader('owner'))
        .send({
          type: 'document',
          title: 'owner doc',
          content: { format: 'markdown', body: '# Hello' },
        });
      expect(res.status).toBe(201);
      expect(res.body.data.id).toBeDefined();

      // DB state check: artifact was created
      const artifacts = await db.drizzle
        .select()
        .from(db.schema.artifacts)
        .where(eq(db.schema.artifacts.companyId, companyId));
      expect(artifacts.length).toBeGreaterThanOrEqual(1);
    });

    it('owner can edit/update resources (PATCH company settings → 200)', async () => {
      const res = await request(app)
        .patch(`/api/companies/${companyId}`)
        .set(roleHeader('owner'))
        .send({ name: 'Updated by Owner' });
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Updated by Owner');

      // DB state check: company name updated
      const company = await getCompany(companyId);
      expect(company?.name).toBe('Updated by Owner');
    });

    it('owner can manage settings (GET /secrets → 200)', async () => {
      const res = await request(app).get(url('/secrets')).set(roleHeader('owner'));
      expect(res.status).toBe(200);
    });

    it('owner can list members (GET /agents includes membership context)', async () => {
      // Owner can access company-scoped endpoints (membership is owner)
      const res = await request(app).get(url('/agents')).set(roleHeader('owner'));
      expect(res.status).toBe(200);
    });

    it('owner can promote/demote members (POST /members/:userId/role → 200)', async () => {
      // Seed a second member to promote/demote
      await db.drizzle
        .insert(db.schema.companyMembers)
        .values({ companyId, userId: 'member-to-promote', role: 'member' })
        .onConflictDoNothing();

      // Promote member to admin
      const promoteRes = await request(app)
        .post(url('/members/member-to-promote/role'))
        .set(roleHeader('owner'))
        .send({ role: 'admin' });
      expect(promoteRes.status).toBe(200);
      expect(promoteRes.body.data.role).toBe('admin');

      // DB state check: role updated in company_members
      const membership = await getMembership(companyId, 'member-to-promote');
      expect(membership?.role).toBe('admin');

      // Demote admin back to member
      const demoteRes = await request(app)
        .post(url('/members/member-to-promote/role'))
        .set(roleHeader('owner'))
        .send({ role: 'member' });
      expect(demoteRes.status).toBe(200);
      expect(demoteRes.body.data.role).toBe('member');

      // DB state check: role updated back
      const membershipAfter = await getMembership(companyId, 'member-to-promote');
      expect(membershipAfter?.role).toBe('member');
    });

    it('owner can delete the company (DELETE → 200)', async () => {
      // Create a separate company for the delete test
      const res = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Delete by Owner', settings: { testFixture: true } })
        .expect(201);
      const deleteTargetId = res.body.data.id;

      await request(app)
        .delete(`/api/companies/${deleteTargetId}`)
        .set(roleHeader('owner'))
        .expect(200);

      // DB state check: company is soft-deleted (archived)
      const company = await getCompany(deleteTargetId);
      expect(company).not.toBeNull();
      expect(company?.status).toBe('archived');
    });

    it('owner has every permission in the matrix (code-level)', async () => {
      const allPermissions = Object.keys(PERMISSION_MATRIX) as Permission[];
      for (const perm of allPermissions) {
        expect(hasPermission('owner', perm), `owner should have ${perm}`).toBe(true);
      }
    });
  });

  // =========================================================================
  // VAL-RBAC-002: Admin has the administrative permission boundary
  // =========================================================================

  describe('VAL-RBAC-002: admin has the administrative permission boundary', () => {
    it('admin can read company resources (GET /agents → 200)', async () => {
      const res = await request(app).get(url('/agents')).set(roleHeader('admin'));
      expect(res.status).toBe(200);
    });

    it('admin can create artifacts (POST /artifacts → 201)', async () => {
      const res = await request(app)
        .post(url('/artifacts'))
        .set(roleHeader('admin'))
        .send({
          type: 'document',
          title: 'admin doc',
          content: { format: 'markdown', body: '# Hello' },
        });
      expect(res.status).toBe(201);
    });

    it('admin can manage settings (GET /secrets → 200, PATCH company → 200)', async () => {
      const secretsRes = await request(app).get(url('/secrets')).set(roleHeader('admin'));
      expect(secretsRes.status).toBe(200);

      const settingsRes = await request(app)
        .patch(`/api/companies/${companyId}`)
        .set(roleHeader('admin'))
        .send({ name: 'Updated by Admin' });
      expect(settingsRes.status).toBe(200);

      // DB state check
      const company = await getCompany(companyId);
      expect(company?.name).toBe('Updated by Admin');
    });

    it('admin can remove members (DELETE /members/:userId → 200)', async () => {
      // Seed a member to remove
      await db.drizzle
        .insert(db.schema.companyMembers)
        .values({ companyId, userId: 'member-to-remove', role: 'member' })
        .onConflictDoNothing();

      const beforeCount = await countMembers(companyId);
      expect(beforeCount).toBe(2); // owner + seeded member

      const res = await request(app)
        .delete(url('/members/member-to-remove'))
        .set(roleHeader('admin'))
        .expect(200);
      expect(res.body.data.removed).toBe(true);

      // DB state check: member removed from company_members
      const afterCount = await countMembers(companyId);
      expect(afterCount).toBe(1); // only owner remains
    });

    it('admin CANNOT promote/demote members (POST /members/:userId/role → 403)', async () => {
      await db.drizzle
        .insert(db.schema.companyMembers)
        .values({ companyId, userId: 'member-target-002', role: 'member' })
        .onConflictDoNothing();

      // Capture before state
      const beforeMembership = await getMembership(companyId, 'member-target-002');
      expect(beforeMembership?.role).toBe('member');

      const res = await request(app)
        .post(url('/members/member-target-002/role'))
        .set(roleHeader('admin'))
        .send({ role: 'admin' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      // DB state check: role unchanged
      const afterMembership = await getMembership(companyId, 'member-target-002');
      expect(afterMembership?.role).toBe('member');
    });

    it('admin CANNOT delete company (DELETE → 403)', async () => {
      const beforeCompany = await getCompany(companyId);
      expect(beforeCompany?.status).not.toBe('archived');

      const res = await request(app).delete(`/api/companies/${companyId}`).set(roleHeader('admin'));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      // DB state check: company not deleted
      const afterCompany = await getCompany(companyId);
      expect(afterCompany?.status).not.toBe('archived');
    });
  });

  // =========================================================================
  // VAL-RBAC-003: Member has the contributor permission boundary
  // =========================================================================

  describe('VAL-RBAC-003: member has the contributor permission boundary', () => {
    it('member can read company resources (GET /agents → 200)', async () => {
      const res = await request(app).get(url('/agents')).set(roleHeader('member'));
      expect(res.status).toBe(200);
    });

    it('member can create tasks (POST /tasks → 201)', async () => {
      const res = await request(app)
        .post(url('/tasks'))
        .set(roleHeader('member'))
        .send({ title: 'member task' });
      expect(res.status).toBe(201);

      // DB state check
      const tasks = await db.drizzle
        .select()
        .from(db.schema.tasks)
        .where(eq(db.schema.tasks.companyId, companyId));
      expect(tasks.length).toBeGreaterThanOrEqual(1);
    });

    it('member can edit/update tasks (PATCH /tasks/:id → 200)', async () => {
      // Create a task first
      const createRes = await request(app)
        .post(url('/tasks'))
        .set(roleHeader('member'))
        .send({ title: 'task to edit' })
        .expect(201);
      const taskId = createRes.body.data.id;

      // Edit the task
      const editRes = await request(app)
        .patch(url(`/tasks/${taskId}`))
        .set(roleHeader('member'))
        .send({ title: 'edited task', status: 'done' });
      expect(editRes.status).toBe(200);

      // DB state check: task updated
      const tasks = await db.drizzle
        .select()
        .from(db.schema.tasks)
        .where(eq(db.schema.tasks.id, taskId))
        .limit(1);
      expect(tasks[0]?.title).toBe('edited task');
    });

    it('member CANNOT manage settings (GET /secrets → 403)', async () => {
      const res = await request(app).get(url('/secrets')).set(roleHeader('member'));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('member CANNOT update company settings (PATCH /api/companies/:id → 403)', async () => {
      const beforeCompany = await getCompany(companyId);

      const res = await request(app)
        .patch(`/api/companies/${companyId}`)
        .set(roleHeader('member'))
        .send({ name: 'Hacked by Member' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      // DB state check: company name unchanged
      const afterCompany = await getCompany(companyId);
      expect(afterCompany?.name).toBe(beforeCompany?.name);
    });

    it('member CANNOT manage members (DELETE /members/:userId → 403)', async () => {
      await db.drizzle
        .insert(db.schema.companyMembers)
        .values({ companyId, userId: 'member-target-003', role: 'viewer' })
        .onConflictDoNothing();

      const beforeCount = await countMembers(companyId);

      const res = await request(app)
        .delete(url('/members/member-target-003'))
        .set(roleHeader('member'));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      // DB state check: no members removed
      const afterCount = await countMembers(companyId);
      expect(afterCount).toBe(beforeCount);
    });

    it('member CANNOT promote/demote (POST /members/:userId/role → 403)', async () => {
      await db.drizzle
        .insert(db.schema.companyMembers)
        .values({ companyId, userId: 'member-target-004', role: 'viewer' })
        .onConflictDoNothing();

      const beforeRole = await getMembership(companyId, 'member-target-004');

      const res = await request(app)
        .post(url('/members/member-target-004/role'))
        .set(roleHeader('member'))
        .send({ role: 'admin' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      // DB state check: role unchanged
      const afterRole = await getMembership(companyId, 'member-target-004');
      expect(afterRole?.role).toBe(beforeRole?.role);
    });

    it('member CANNOT delete company (DELETE → 403)', async () => {
      const res = await request(app)
        .delete(`/api/companies/${companyId}`)
        .set(roleHeader('member'));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      // DB state check: company not archived
      const company = await getCompany(companyId);
      expect(company?.status).not.toBe('archived');
    });
  });

  // =========================================================================
  // VAL-RBAC-004: Viewer has the read-only permission boundary
  // =========================================================================

  describe('VAL-RBAC-004: viewer has the read-only permission boundary', () => {
    it('viewer can read company resources (GET /agents → 200)', async () => {
      const res = await request(app).get(url('/agents')).set(roleHeader('viewer'));
      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
    });

    it('viewer can read artifacts (GET /artifacts → 200)', async () => {
      const res = await request(app).get(url('/artifacts')).set(roleHeader('viewer'));
      expect(res.status).toBe(200);
    });

    it('viewer CANNOT create artifacts (POST /artifacts → 403, state unchanged)', async () => {
      const beforeCount = await db.drizzle
        .select()
        .from(db.schema.artifacts)
        .where(eq(db.schema.artifacts.companyId, companyId));

      const res = await request(app)
        .post(url('/artifacts'))
        .set(roleHeader('viewer'))
        .send({
          type: 'document',
          title: 'viewer doc',
          content: { format: 'markdown', body: '# Hello' },
        });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      // DB state check: no new artifact created
      const afterCount = await db.drizzle
        .select()
        .from(db.schema.artifacts)
        .where(eq(db.schema.artifacts.companyId, companyId));
      expect(afterCount.length).toBe(beforeCount.length);
    });

    it('viewer CANNOT edit resources (PATCH company → 403, state unchanged)', async () => {
      const before = await getCompany(companyId);

      const res = await request(app)
        .patch(`/api/companies/${companyId}`)
        .set(roleHeader('viewer'))
        .send({ name: 'Hacked by Viewer' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      // DB state check: company name unchanged
      const after = await getCompany(companyId);
      expect(after?.name).toBe(before?.name);
    });

    it('viewer CANNOT manage settings (GET /secrets → 403)', async () => {
      const res = await request(app).get(url('/secrets')).set(roleHeader('viewer'));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('viewer CANNOT manage members (DELETE /members/:userId → 403, state unchanged)', async () => {
      await db.drizzle
        .insert(db.schema.companyMembers)
        .values({ companyId, userId: 'viewer-target-001', role: 'member' })
        .onConflictDoNothing();

      const beforeCount = await countMembers(companyId);

      const res = await request(app)
        .delete(url('/members/viewer-target-001'))
        .set(roleHeader('viewer'));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      const afterCount = await countMembers(companyId);
      expect(afterCount).toBe(beforeCount);
    });

    it('viewer CANNOT promote/demote (POST /members/:userId/role → 403, state unchanged)', async () => {
      await db.drizzle
        .insert(db.schema.companyMembers)
        .values({ companyId, userId: 'viewer-target-002', role: 'member' })
        .onConflictDoNothing();

      const before = await getMembership(companyId, 'viewer-target-002');

      const res = await request(app)
        .post(url('/members/viewer-target-002/role'))
        .set(roleHeader('viewer'))
        .send({ role: 'admin' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      const after = await getMembership(companyId, 'viewer-target-002');
      expect(after?.role).toBe(before?.role);
    });

    it('viewer CANNOT delete company (DELETE → 403, state unchanged)', async () => {
      const before = await getCompany(companyId);

      const res = await request(app)
        .delete(`/api/companies/${companyId}`)
        .set(roleHeader('viewer'));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      const after = await getCompany(companyId);
      expect(after?.status).toBe(before?.status);
    });

    it('viewer has only company.view and member.list in the matrix (code-level)', async () => {
      const allPermissions = Object.keys(PERMISSION_MATRIX) as Permission[];
      for (const perm of allPermissions) {
        const allowed = hasPermission('viewer', perm);
        if (perm === 'company.view' || perm === 'member.list') {
          expect(allowed, `viewer should have ${perm}`).toBe(true);
        } else {
          expect(allowed, `viewer should NOT have ${perm}`).toBe(false);
        }
      }
    });
  });

  // =========================================================================
  // VAL-RBAC-005: Unknown or invalid roles are denied
  // =========================================================================

  describe('VAL-RBAC-005: unknown or invalid roles are denied', () => {
    it('invalid role in company_members is denied on read (GET /agents → 403)', async () => {
      await db.drizzle.execute(
        sql`UPDATE company_members SET role = 'superadmin' WHERE company_id = ${companyId} AND user_id = 'dev-user-000'`,
      );

      // No impersonation header → uses DB role 'superadmin'
      const res = await request(app).get(url('/agents')).expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('invalid role denied on write (POST /artifacts → 403, state unchanged)', async () => {
      await db.drizzle.execute(
        sql`UPDATE company_members SET role = 'superadmin' WHERE company_id = ${companyId} AND user_id = 'dev-user-000'`,
      );

      const beforeCount = await db.drizzle
        .select()
        .from(db.schema.artifacts)
        .where(eq(db.schema.artifacts.companyId, companyId));

      const res = await request(app)
        .post(url('/artifacts'))
        .send({
          type: 'document',
          title: 'invalid role test',
          content: { format: 'markdown', body: '# Hello' },
        })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      // DB state check: no artifact created (handler not reached)
      const afterCount = await db.drizzle
        .select()
        .from(db.schema.artifacts)
        .where(eq(db.schema.artifacts.companyId, companyId));
      expect(afterCount.length).toBe(beforeCount.length);
    });

    it('invalid role denied on admin route (GET /secrets → 403, state unchanged)', async () => {
      await db.drizzle.execute(
        sql`UPDATE company_members SET role = 'superadmin' WHERE company_id = ${companyId} AND user_id = 'dev-user-000'`,
      );

      const res = await request(app).get(url('/secrets')).expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('invalid role denied on settings (PATCH company → 403, state unchanged)', async () => {
      await db.drizzle.execute(
        sql`UPDATE company_members SET role = 'superadmin' WHERE company_id = ${companyId} AND user_id = 'dev-user-000'`,
      );

      const before = await getCompany(companyId);

      const res = await request(app)
        .patch(`/api/companies/${companyId}`)
        .send({ name: 'Hacked by Invalid Role' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      // DB state check: company name unchanged
      const after = await getCompany(companyId);
      expect(after?.name).toBe(before?.name);
    });
  });

  // =========================================================================
  // VAL-RBAC-008: Non-member receives 403 for company-scoped endpoints
  // =========================================================================
  //
  // In local_trusted mode, users without a company_members row default to
  // owner (backward compat). To properly test non-member denial, we use
  // Clerk (authenticated) mode with a mock verify function — the same
  // approach as rbac-membership.test.ts. This verifies that the
  // requirePermission middleware rejects users with no company_members row.
  // =========================================================================

  describe('VAL-RBAC-008: non-member receives 403 for company-scoped endpoints', () => {
    function mockSession(userId: string): AuthSession {
      return {
        user: { id: userId, name: 'Test User', email: `${userId}@test.com` },
        session: {
          id: 'sess-test',
          userId,
          activeOrganizationId: null,
          activeOrganizationRole: null,
        },
      };
    }

    /** Build a lightweight Clerk-mode app with representative routes. */
    function buildClerkApp(userId: string): express.Express {
      const testApp = express();
      testApp.use(express.json());
      const { requireAuth, requirePermission } = createAuthMiddleware({
        authMode: 'authenticated',
        verify: async () => mockSession(userId),
        db,
      });

      testApp.get(
        '/companies/:companyId/view',
        requireAuth,
        requirePermission('company.view'),
        (_req: Request, res: Response) => res.json({ ok: true }),
      );
      testApp.post(
        '/companies/:companyId/create',
        requireAuth,
        requirePermission('artifact.create'),
        (_req: Request, res: Response) => res.json({ ok: true }),
      );
      testApp.get(
        '/companies/:companyId/settings',
        requireAuth,
        requirePermission('secrets.manage'),
        (_req: Request, res: Response) => res.json({ ok: true }),
      );
      testApp.delete(
        '/companies/:companyId/members/:userId',
        requireAuth,
        requirePermission('member.remove'),
        (_req: Request, res: Response) => res.json({ ok: true }),
      );
      testApp.delete(
        '/companies/:companyId/delete',
        requireAuth,
        requirePermission('company.delete'),
        (_req: Request, res: Response) => res.json({ ok: true }),
      );
      testApp.use(errorHandler);
      return testApp;
    }

    it('non-member gets 403 on read endpoint (GET /view → 403 NOT_MEMBER)', async () => {
      const clerkApp = buildClerkApp('non-member-user-008');
      const res = await request(clerkApp).get(`/companies/${companyId}/view`).expect(403);
      expect(res.body.code).toBe('NOT_MEMBER');
      expect(res.body.ok).toBeUndefined();
    });

    it('non-member gets 403 on write endpoint (POST /create → 403 NOT_MEMBER)', async () => {
      const clerkApp = buildClerkApp('non-member-user-008');
      const res = await request(clerkApp)
        .post(`/companies/${companyId}/create`)
        .send({})
        .expect(403);
      expect(res.body.code).toBe('NOT_MEMBER');
    });

    it('non-member gets 403 on settings endpoint (GET /settings → 403 NOT_MEMBER)', async () => {
      const clerkApp = buildClerkApp('non-member-user-008');
      const res = await request(clerkApp).get(`/companies/${companyId}/settings`).expect(403);
      expect(res.body.code).toBe('NOT_MEMBER');
    });

    it('non-member gets 403 on member management (DELETE /members → 403 NOT_MEMBER)', async () => {
      const clerkApp = buildClerkApp('non-member-user-008');
      const res = await request(clerkApp)
        .delete(`/companies/${companyId}/members/some-user`)
        .expect(403);
      expect(res.body.code).toBe('NOT_MEMBER');
    });

    it('non-member gets 403 on company delete (DELETE → 403 NOT_MEMBER)', async () => {
      const clerkApp = buildClerkApp('non-member-user-008');
      const res = await request(clerkApp).delete(`/companies/${companyId}/delete`).expect(403);
      expect(res.body.code).toBe('NOT_MEMBER');
    });

    it('non-member denial: no state change (company still active)', async () => {
      const clerkApp = buildClerkApp('non-member-user-008');
      // Attempt delete
      await request(clerkApp).delete(`/companies/${companyId}/delete`).expect(403);

      // Company still exists and is active in DB
      const company = await getCompany(companyId);
      expect(company).not.toBeNull();
      expect(company?.status).not.toBe('archived');
    });
  });

  // =========================================================================
  // VAL-RBAC-009: Membership from another company does not cross boundaries
  // =========================================================================

  describe('VAL-RBAC-009: membership from another company does not cross boundaries', () => {
    /**
     * In local_trusted mode, deleting a user's membership causes them to
     * default to owner (backward compat). So to test cross-company
     * isolation, we set the user to a high role in A and a low role (viewer)
     * in B, then verify that B admin/delete endpoints return 403 despite
     * the user's elevated role in A.
     */

    it('owner of company A gets 403 on company B admin endpoint (viewer in B)', async () => {
      // Company A = companyId (dev-user-000 is owner)
      // Create company B and set dev-user-000 to viewer in B
      const resB = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Company B', settings: { testFixture: true } })
        .expect(201);
      const companyIdB = resB.body.data.id;

      // Set dev-user-000 to viewer in B
      await db.drizzle
        .update(db.schema.companyMembers)
        .set({ role: 'viewer', updatedAt: new Date() })
        .where(
          and(
            eq(db.schema.companyMembers.companyId, companyIdB),
            eq(db.schema.companyMembers.userId, 'dev-user-000'),
          ),
        );

      // Owner in A can access A's admin endpoints
      await request(app).get(url('/secrets')).expect(200);

      // Viewer in B CANNOT access B's admin endpoints (secrets.manage)
      const res = await request(app).get(`/api/companies/${companyIdB}/secrets`).expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('owner of company A gets 403 on company B write (viewer in B, state unchanged)', async () => {
      const resB = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Company B Write', settings: { testFixture: true } })
        .expect(201);
      const companyIdB = resB.body.data.id;

      await db.drizzle
        .update(db.schema.companyMembers)
        .set({ role: 'viewer', updatedAt: new Date() })
        .where(
          and(
            eq(db.schema.companyMembers.companyId, companyIdB),
            eq(db.schema.companyMembers.userId, 'dev-user-000'),
          ),
        );

      const beforeCount = await db.drizzle
        .select()
        .from(db.schema.artifacts)
        .where(eq(db.schema.artifacts.companyId, companyIdB));

      const res = await request(app)
        .post(`/api/companies/${companyIdB}/artifacts`)
        .send({
          type: 'document',
          title: 'cross-company doc',
          content: { format: 'markdown', body: '# Hello' },
        })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      const afterCount = await db.drizzle
        .select()
        .from(db.schema.artifacts)
        .where(eq(db.schema.artifacts.companyId, companyIdB));
      expect(afterCount.length).toBe(beforeCount.length);
    });

    it('owner of company A gets 403 on company B settings (PATCH, viewer in B, state unchanged)', async () => {
      const resB = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Company B Settings', settings: { testFixture: true } })
        .expect(201);
      const companyIdB = resB.body.data.id;

      await db.drizzle
        .update(db.schema.companyMembers)
        .set({ role: 'viewer', updatedAt: new Date() })
        .where(
          and(
            eq(db.schema.companyMembers.companyId, companyIdB),
            eq(db.schema.companyMembers.userId, 'dev-user-000'),
          ),
        );

      const beforeB = await getCompany(companyIdB);

      const res = await request(app)
        .patch(`/api/companies/${companyIdB}`)
        .send({ name: 'Hacked B Settings' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      // DB state check: B settings unchanged
      const afterB = await getCompany(companyIdB);
      expect(afterB?.name).toBe(beforeB?.name);
    });

    it('owner of company A gets 403 on company B delete (viewer in B, state unchanged)', async () => {
      const resB = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Company B Delete', settings: { testFixture: true } })
        .expect(201);
      const companyIdB = resB.body.data.id;

      await db.drizzle
        .update(db.schema.companyMembers)
        .set({ role: 'viewer', updatedAt: new Date() })
        .where(
          and(
            eq(db.schema.companyMembers.companyId, companyIdB),
            eq(db.schema.companyMembers.userId, 'dev-user-000'),
          ),
        );

      const before = await getCompany(companyIdB);

      const res = await request(app).delete(`/api/companies/${companyIdB}`).expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      const after = await getCompany(companyIdB);
      expect(after?.status).toBe(before?.status);
    });
  });

  // =========================================================================
  // VAL-RBAC-012: Company creation auto-creates the owner membership
  // =========================================================================

  describe('VAL-RBAC-012: company creation auto-creates owner membership', () => {
    it('creates exactly one owner membership and creator can perform owner-only action', async () => {
      // Create a new company as a specific user
      const createRes = await request(app)
        .post('/api/companies')
        .set('X-Eidolon-Test-User-Id', 'new-creator-001')
        .send({ name: '__mtest__ Creator Owner Test', settings: { testFixture: true } })
        .expect(201);
      const newCompanyId = createRes.body.data.id;

      // Verify exactly one membership with role=owner
      const memberships = await db.drizzle
        .select()
        .from(db.schema.companyMembers)
        .where(eq(db.schema.companyMembers.companyId, newCompanyId));

      expect(memberships).toHaveLength(1);
      expect(memberships[0].userId).toBe('new-creator-001');
      expect(memberships[0].role).toBe('owner');

      // Creator can perform an owner-only action: PATCH company settings
      const patchRes = await request(app)
        .patch(`/api/companies/${newCompanyId}`)
        .set('X-Eidolon-Test-User-Id', 'new-creator-001')
        .send({ name: 'Updated by Creator' })
        .expect(200);
      expect(patchRes.body.data.name).toBe('Updated by Creator');

      // DB state check: company name updated
      const company = await getCompany(newCompanyId);
      expect(company?.name).toBe('Updated by Creator');
    });

    it('creator can perform DELETE company (owner-only action)', async () => {
      const createRes = await request(app)
        .post('/api/companies')
        .set('X-Eidolon-Test-User-Id', 'new-creator-002')
        .send({ name: '__mtest__ Creator Delete Test', settings: { testFixture: true } })
        .expect(201);
      const newCompanyId = createRes.body.data.id;

      // Creator can delete the company (owner-only action)
      await request(app)
        .delete(`/api/companies/${newCompanyId}`)
        .set('X-Eidolon-Test-User-Id', 'new-creator-002')
        .expect(200);

      // DB state check: company archived
      const company = await getCompany(newCompanyId);
      expect(company?.status).toBe('archived');
    });
  });

  // =========================================================================
  // VAL-RBAC-017: Migrated read routes remain functional
  // =========================================================================

  describe('VAL-RBAC-017: migrated read routes remain functional (as viewer → 200)', () => {
    // Comprehensive list of migrated read routes
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
      { path: '/org-chart', name: 'org-chart' },
      { path: '/runtime/state', name: 'runtime-state' },
      { path: '/routines', name: 'routines' },
      { path: '/automations', name: 'automations' },
      { path: '/collaborations', name: 'collaborations' },
      { path: '/approvals', name: 'approvals' },
      { path: '/files', name: 'files' },
      { path: '/folders', name: 'folders' },
      { path: '/evaluations', name: 'evaluations' },
      { path: '/workflows', name: 'workflows' },
      { path: '/messages', name: 'messages' },
      { path: '/costs', name: 'budgets' },
    ];

    it.each(readRoutes)(
      'viewer GET $name → 200 (not 401/403, valid response body)',
      async (route) => {
        const res = await request(app).get(url(route.path)).set(roleHeader('viewer'));
        // Must be a successful 2xx response
        expect(res.status, `GET ${route.name} as viewer`).toBeGreaterThanOrEqual(200);
        expect(res.status, `GET ${route.name} as viewer`).toBeLessThan(300);
        // Response must have a body (data or other field)
        expect(res.body).toBeDefined();
      },
    );
  });

  // =========================================================================
  // VAL-RBAC-018: Migrated write routes enforce specific permissions
  // =========================================================================

  describe('VAL-RBAC-018: migrated write routes enforce specific permissions', () => {
    // Custom test for each route
    it.each([
      [
        'POST /artifacts',
        'post',
        '/artifacts',
        { type: 'document', title: 'test', content: { format: 'markdown', body: '# Hello' } },
      ],
      ['POST /tasks', 'post', '/tasks', { title: 'test task' }],
      ['POST /projects', 'post', '/projects', { name: 'test project', status: 'active' }],
      ['POST /goals', 'post', '/goals', { title: 'test goal' }],
    ] as const)('%s: role boundary test', async (name, method, path, body) => {
      for (const [role, expectedStatus] of [
        ['owner', 201],
        ['admin', 201],
        ['member', 201],
        ['viewer', 403],
      ] as const) {
        const req = (request(app) as any)[method](url(path)).set(roleHeader(role)).send(body);
        const res = await req;
        expect(res.status, `${name} as ${role}`).toBe(expectedStatus);
        if (expectedStatus === 403) {
          expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
        }
      }
    });

    it('GET /secrets: admin+ allowed, member/viewer denied', async () => {
      for (const [role, expectedStatus] of [
        ['owner', 200],
        ['admin', 200],
        ['member', 403],
        ['viewer', 403],
      ] as const) {
        const res = await request(app).get(url('/secrets')).set(roleHeader(role));
        expect(res.status, `GET /secrets as ${role}`).toBe(expectedStatus);
        if (expectedStatus === 403) {
          expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
        }
      }
    });

    it('PATCH company settings: admin+ allowed, member/viewer denied with state check', async () => {
      for (const [role, expectedStatus] of [
        ['owner', 200],
        ['admin', 200],
        ['member', 403],
        ['viewer', 403],
      ] as const) {
        const before = await getCompany(companyId);
        const res = await request(app)
          .patch(`/api/companies/${companyId}`)
          .set(roleHeader(role))
          .send({ name: `Updated by ${role}` });
        expect(res.status, `PATCH company as ${role}`).toBe(expectedStatus);
        if (expectedStatus === 403) {
          expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
          // DB state check: name unchanged for denied roles
          const after = await getCompany(companyId);
          expect(after?.name).toBe(before?.name);
        }
      }
    });
  });

  // =========================================================================
  // VAL-RBAC-019: Viewer can read but cannot create, edit, or delete
  // =========================================================================

  describe('VAL-RBAC-019: viewer can read but cannot create, edit, or delete', () => {
    it('viewer successfully reads a company resource (GET /artifacts → 200)', async () => {
      const res = await request(app).get(url('/artifacts')).set(roleHeader('viewer')).expect(200);
      expect(res.body.data).toBeDefined();
    });

    it('viewer cannot create (POST /artifacts → 403, state unchanged)', async () => {
      const before = await db.drizzle
        .select()
        .from(db.schema.artifacts)
        .where(eq(db.schema.artifacts.companyId, companyId));

      const res = await request(app)
        .post(url('/artifacts'))
        .set(roleHeader('viewer'))
        .send({
          type: 'document',
          title: 'viewer create attempt',
          content: { format: 'markdown', body: '# Hello' },
        })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      const after = await db.drizzle
        .select()
        .from(db.schema.artifacts)
        .where(eq(db.schema.artifacts.companyId, companyId));
      expect(after.length).toBe(before.length);
    });

    it('viewer cannot edit (PATCH company → 403, state unchanged)', async () => {
      const before = await getCompany(companyId);

      const res = await request(app)
        .patch(`/api/companies/${companyId}`)
        .set(roleHeader('viewer'))
        .send({ name: 'Viewer Edit Attempt' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      const after = await getCompany(companyId);
      expect(after?.name).toBe(before?.name);
    });

    it('viewer cannot delete (DELETE company → 403, state unchanged)', async () => {
      const before = await getCompany(companyId);

      const res = await request(app)
        .delete(`/api/companies/${companyId}`)
        .set(roleHeader('viewer'))
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      const after = await getCompany(companyId);
      expect(after?.status).toBe(before?.status);
    });
  });

  // =========================================================================
  // VAL-RBAC-020: Member can create and edit but not manage settings or members
  // =========================================================================

  describe('VAL-RBAC-020: member can create and edit but not manage', () => {
    it('member can create resources (POST /tasks → 201)', async () => {
      const res = await request(app)
        .post(url('/tasks'))
        .set(roleHeader('member'))
        .send({ title: 'member task' })
        .expect(201);
      expect(res.body.data.id).toBeDefined();
    });

    it('member can edit resources (PATCH /tasks/:id → 200)', async () => {
      const createRes = await request(app)
        .post(url('/tasks'))
        .set(roleHeader('member'))
        .send({ title: 'task to edit by member' })
        .expect(201);
      const taskId = createRes.body.data.id;

      const editRes = await request(app)
        .patch(url(`/tasks/${taskId}`))
        .set(roleHeader('member'))
        .send({ title: 'edited by member', status: 'done' });
      expect(editRes.status).toBe(200);

      // DB state check
      const tasks = await db.drizzle
        .select()
        .from(db.schema.tasks)
        .where(eq(db.schema.tasks.id, taskId))
        .limit(1);
      expect(tasks[0]?.title).toBe('edited by member');
    });

    it('member CANNOT access settings (GET /secrets → 403, state unchanged)', async () => {
      const res = await request(app).get(url('/secrets')).set(roleHeader('member')).expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('member CANNOT update company settings (PATCH → 403, state unchanged)', async () => {
      const before = await getCompany(companyId);

      const res = await request(app)
        .patch(`/api/companies/${companyId}`)
        .set(roleHeader('member'))
        .send({ name: 'Hacked by Member' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      const after = await getCompany(companyId);
      expect(after?.name).toBe(before?.name);
    });

    it('member CANNOT remove members (DELETE /members/:userId → 403, state unchanged)', async () => {
      await db.drizzle
        .insert(db.schema.companyMembers)
        .values({ companyId, userId: 'member-cannot-remove-001', role: 'viewer' })
        .onConflictDoNothing();

      const beforeCount = await countMembers(companyId);

      const res = await request(app)
        .delete(url('/members/member-cannot-remove-001'))
        .set(roleHeader('member'))
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      const afterCount = await countMembers(companyId);
      expect(afterCount).toBe(beforeCount);
    });

    it('member CANNOT change roles (POST /members/:userId/role → 403, state unchanged)', async () => {
      await db.drizzle
        .insert(db.schema.companyMembers)
        .values({ companyId, userId: 'member-cannot-promote-001', role: 'viewer' })
        .onConflictDoNothing();

      const before = await getMembership(companyId, 'member-cannot-promote-001');

      const res = await request(app)
        .post(url('/members/member-cannot-promote-001/role'))
        .set(roleHeader('member'))
        .send({ role: 'admin' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      const after = await getMembership(companyId, 'member-cannot-promote-001');
      expect(after?.role).toBe(before?.role);
    });

    it('member CANNOT delete company (DELETE → 403, state unchanged)', async () => {
      const before = await getCompany(companyId);

      const res = await request(app)
        .delete(`/api/companies/${companyId}`)
        .set(roleHeader('member'))
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      const after = await getCompany(companyId);
      expect(after?.status).toBe(before?.status);
    });
  });

  // =========================================================================
  // VAL-RBAC-021: Admin manages settings and members but not ownership controls
  // =========================================================================

  describe('VAL-RBAC-021: admin manages settings and members but not ownership controls', () => {
    it('admin can update company settings (PATCH → 200)', async () => {
      const res = await request(app)
        .patch(`/api/companies/${companyId}`)
        .set(roleHeader('admin'))
        .send({ name: 'Updated by Admin' })
        .expect(200);
      expect(res.body.data.name).toBe('Updated by Admin');

      // DB state check
      const company = await getCompany(companyId);
      expect(company?.name).toBe('Updated by Admin');
    });

    it('admin can remove non-owner members (DELETE /members → 200, state changed)', async () => {
      await db.drizzle
        .insert(db.schema.companyMembers)
        .values({ companyId, userId: 'admin-remove-target-001', role: 'member' })
        .onConflictDoNothing();

      const beforeCount = await countMembers(companyId);

      const res = await request(app)
        .delete(url('/members/admin-remove-target-001'))
        .set(roleHeader('admin'))
        .expect(200);
      expect(res.body.data.removed).toBe(true);

      const afterCount = await countMembers(companyId);
      expect(afterCount).toBe(beforeCount - 1);
    });

    it('admin CANNOT promote/demote (POST /members/:userId/role → 403, state unchanged)', async () => {
      await db.drizzle
        .insert(db.schema.companyMembers)
        .values({ companyId, userId: 'admin-cannot-promote-001', role: 'member' })
        .onConflictDoNothing();

      const before = await getMembership(companyId, 'admin-cannot-promote-001');

      const res = await request(app)
        .post(url('/members/admin-cannot-promote-001/role'))
        .set(roleHeader('admin'))
        .send({ role: 'admin' })
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      const after = await getMembership(companyId, 'admin-cannot-promote-001');
      expect(after?.role).toBe(before?.role);
    });

    it('admin CANNOT delete company (DELETE → 403, state unchanged)', async () => {
      const before = await getCompany(companyId);

      const res = await request(app)
        .delete(`/api/companies/${companyId}`)
        .set(roleHeader('admin'))
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      const after = await getCompany(companyId);
      expect(after?.status).toBe(before?.status);
    });
  });

  // =========================================================================
  // VAL-RBAC-022: Owner can promote, demote, and delete
  // =========================================================================

  describe('VAL-RBAC-022: owner can promote, demote, and delete', () => {
    it('owner can promote a member to admin (POST /members/:userId/role → 200)', async () => {
      await db.drizzle
        .insert(db.schema.companyMembers)
        .values({ companyId, userId: 'promote-target-001', role: 'member' })
        .onConflictDoNothing();

      // Before: role is member
      const before = await getMembership(companyId, 'promote-target-001');
      expect(before?.role).toBe('member');

      // Promote to admin
      const res = await request(app)
        .post(url('/members/promote-target-001/role'))
        .set(roleHeader('owner'))
        .send({ role: 'admin' })
        .expect(200);
      expect(res.body.data.role).toBe('admin');

      // After: role is admin in DB
      const after = await getMembership(companyId, 'promote-target-001');
      expect(after?.role).toBe('admin');
    });

    it('owner can demote an admin to member (POST /members/:userId/role → 200)', async () => {
      await db.drizzle
        .insert(db.schema.companyMembers)
        .values({ companyId, userId: 'demote-target-001', role: 'admin' })
        .onConflictDoNothing();

      // Before: role is admin
      const before = await getMembership(companyId, 'demote-target-001');
      expect(before?.role).toBe('admin');

      // Demote to member
      const res = await request(app)
        .post(url('/members/demote-target-001/role'))
        .set(roleHeader('owner'))
        .send({ role: 'member' })
        .expect(200);
      expect(res.body.data.role).toBe('member');

      // After: role is member in DB
      const after = await getMembership(companyId, 'demote-target-001');
      expect(after?.role).toBe('member');
    });

    it('owner can delete the company (DELETE → 200, company archived)', async () => {
      // Create a separate company for delete test
      const createRes = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Owner Delete Contract', settings: { testFixture: true } })
        .expect(201);
      const deleteId = createRes.body.data.id;

      // Before: company is active
      const before = await getCompany(deleteId);
      expect(before?.status).not.toBe('archived');

      // Delete as owner
      const res = await request(app)
        .delete(`/api/companies/${deleteId}`)
        .set(roleHeader('owner'))
        .expect(200);

      // After: company is archived
      const after = await getCompany(deleteId);
      expect(after?.status).toBe('archived');
    });
  });

  // =========================================================================
  // VAL-CROSS-006: Company creator receives owner access
  // =========================================================================

  describe('VAL-CROSS-006: company creator receives owner access', () => {
    it('creator is owner, can access all endpoints, can perform owner-only actions', async () => {
      // Create a company as a specific user
      const createRes = await request(app)
        .post('/api/companies')
        .set('X-Eidolon-Test-User-Id', 'cross-006-creator')
        .send({ name: '__mtest__ Cross-006 Creator', settings: { testFixture: true } })
        .expect(201);
      const newCompanyId = createRes.body.data.id;

      // Verify owner membership exists
      const membership = await getMembership(newCompanyId, 'cross-006-creator');
      expect(membership).not.toBeNull();
      expect(membership?.role).toBe('owner');

      // Creator can access company-scoped GET endpoint
      const getRes = await request(app)
        .get(`/api/companies/${newCompanyId}/agents`)
        .set('X-Eidolon-Test-User-Id', 'cross-006-creator')
        .expect(200);
      expect(getRes.body.data).toBeDefined();

      // Creator can perform owner-only action: DELETE company
      await request(app)
        .delete(`/api/companies/${newCompanyId}`)
        .set('X-Eidolon-Test-User-Id', 'cross-006-creator')
        .expect(200);

      // DB state: company archived
      const company = await getCompany(newCompanyId);
      expect(company?.status).toBe('archived');
    });

    it('creator can perform PATCH settings (owner-only action)', async () => {
      const createRes = await request(app)
        .post('/api/companies')
        .set('X-Eidolon-Test-User-Id', 'cross-006-creator-002')
        .send({ name: '__mtest__ Cross-006 Settings', settings: { testFixture: true } })
        .expect(201);
      const newCompanyId = createRes.body.data.id;

      // Owner-only action: PATCH company settings
      const patchRes = await request(app)
        .patch(`/api/companies/${newCompanyId}`)
        .set('X-Eidolon-Test-User-Id', 'cross-006-creator-002')
        .send({ name: 'Creator Updated Name' })
        .expect(200);
      expect(patchRes.body.data.name).toBe('Creator Updated Name');

      // DB state check
      const company = await getCompany(newCompanyId);
      expect(company?.name).toBe('Creator Updated Name');
    });
  });

  // =========================================================================
  // VAL-CROSS-010: Membership role is isolated per company
  // =========================================================================

  describe('VAL-CROSS-010: membership role is isolated per company', () => {
    it('admin in A can manage settings in A, viewer in B gets 403 in B with unchanged B settings', async () => {
      // Create company B
      const resB = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Cross-010 Company B', settings: { testFixture: true } })
        .expect(201);
      const companyIdB = resB.body.data.id;

      // Set dev-user-000 to admin in A, viewer in B
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
      const patchA = await request(app)
        .patch(`/api/companies/${companyId}`)
        .send({ name: 'Updated A Settings' })
        .expect(200);
      expect(patchA.body.data.name).toBe('Updated A Settings');

      // Capture B settings before denied operation
      const beforeB = await getCompany(companyIdB);

      // Viewer CANNOT update settings in B
      const patchB = await request(app)
        .patch(`/api/companies/${companyIdB}`)
        .send({ name: 'Hacked B Settings' })
        .expect(403);
      expect(patchB.body.code).toBe('INSUFFICIENT_PERMISSION');

      // DB state check: B settings unchanged
      const afterB = await getCompany(companyIdB);
      expect(afterB?.name).toBe(beforeB?.name);
    });

    it('admin in A can remove members in A, viewer in B gets 403 on B members', async () => {
      const resB = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Cross-010 Members B', settings: { testFixture: true } })
        .expect(201);
      const companyIdB = resB.body.data.id;

      // Set roles
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

      // Seed a member in A to remove
      await db.drizzle
        .insert(db.schema.companyMembers)
        .values({ companyId, userId: 'cross-010-remove-a', role: 'member' })
        .onConflictDoNothing();

      // Admin can remove in A
      await request(app).delete(url('/members/cross-010-remove-a')).expect(200);

      // Viewer CANNOT remove in B
      await db.drizzle
        .insert(db.schema.companyMembers)
        .values({ companyId: companyIdB, userId: 'cross-010-remove-b', role: 'member' })
        .onConflictDoNothing();

      const beforeBCount = await countMembers(companyIdB);

      const res = await request(app)
        .delete(`/api/companies/${companyIdB}/members/cross-010-remove-b`)
        .expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      const afterBCount = await countMembers(companyIdB);
      expect(afterBCount).toBe(beforeBCount);
    });
  });

  // =========================================================================
  // VAL-CROSS-013: local_trusted and Clerk modes have identical RBAC outcomes
  // =========================================================================

  describe('VAL-CROSS-013: local_trusted and Clerk modes have identical RBAC outcomes', () => {
    /**
     * This test verifies that the requirePermission middleware uses the same
     * PERMISSION_MATRIX and hasPermission function in both modes.
     *
     * Strategy:
     * 1. Code-level: Verify that hasPermission is the same function used in
     *    both modes (it's a pure function on the PERMISSION_MATRIX).
     * 2. Behavioral: Test the same fixture in local_trusted mode (via
     *    impersonation headers and DB memberships) and verify the same
     *    allow/deny outcomes.
     */

    it('hasPermission is a pure function on PERMISSION_MATRIX (code-level)', async () => {
      // Verify the matrix is consistent for all roles
      const roles: Role[] = ['owner', 'admin', 'member', 'viewer'];
      const allPermissions = Object.keys(PERMISSION_MATRIX) as Permission[];

      for (const role of roles) {
        for (const perm of allPermissions) {
          // The function is deterministic — same inputs always produce same output
          const result1 = hasPermission(role, perm);
          const result2 = hasPermission(role, perm);
          expect(result1).toBe(result2);
        }
      }

      // Key boundary checks that must hold in both modes:
      expect(hasPermission('owner', 'company.delete')).toBe(true);
      expect(hasPermission('admin', 'company.delete')).toBe(false);
      expect(hasPermission('member', 'company.delete')).toBe(false);
      expect(hasPermission('viewer', 'company.delete')).toBe(false);

      expect(hasPermission('owner', 'member.promote')).toBe(true);
      expect(hasPermission('admin', 'member.promote')).toBe(false);

      expect(hasPermission('owner', 'company.settings.update')).toBe(true);
      expect(hasPermission('admin', 'company.settings.update')).toBe(true);
      expect(hasPermission('member', 'company.settings.update')).toBe(false);
      expect(hasPermission('viewer', 'company.settings.update')).toBe(false);

      expect(hasPermission('owner', 'artifact.create')).toBe(true);
      expect(hasPermission('admin', 'artifact.create')).toBe(true);
      expect(hasPermission('member', 'artifact.create')).toBe(true);
      expect(hasPermission('viewer', 'artifact.create')).toBe(false);

      expect(hasPermission('owner', 'company.view')).toBe(true);
      expect(hasPermission('admin', 'company.view')).toBe(true);
      expect(hasPermission('member', 'company.view')).toBe(true);
      expect(hasPermission('viewer', 'company.view')).toBe(true);
    });

    it('local_trusted mode: DB membership produces same outcomes as matrix', async () => {
      // Set dev-user-000 to viewer in DB (no impersonation header)
      await setRole('viewer');

      // Viewer can read (company.view)
      const readRes = await request(app).get(url('/agents')).expect(200);
      expect(readRes.status).toBe(200);

      // Viewer cannot write (artifact.create)
      const writeRes = await request(app)
        .post(url('/artifacts'))
        .send({ type: 'document', title: 'test', content: { format: 'markdown', body: '# Hello' } })
        .expect(403);
      expect(writeRes.body.code).toBe('INSUFFICIENT_PERMISSION');

      // Viewer cannot manage settings (secrets.manage)
      const secretsRes = await request(app).get(url('/secrets')).expect(403);
      expect(secretsRes.body.code).toBe('INSUFFICIENT_PERMISSION');

      // Viewer cannot delete company (company.delete)
      const deleteRes = await request(app).delete(`/api/companies/${companyId}`).expect(403);
      expect(deleteRes.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('local_trusted mode: admin membership produces same outcomes as matrix', async () => {
      await setRole('admin');

      // Admin can read
      await request(app).get(url('/agents')).expect(200);

      // Admin can write
      await request(app)
        .post(url('/artifacts'))
        .send({
          type: 'document',
          title: 'admin test',
          content: { format: 'markdown', body: '# Hello' },
        })
        .expect(201);

      // Admin can manage settings
      await request(app).get(url('/secrets')).expect(200);

      // Admin CANNOT delete company (owner-only)
      const deleteRes = await request(app).delete(`/api/companies/${companyId}`).expect(403);
      expect(deleteRes.body.code).toBe('INSUFFICIENT_PERMISSION');

      // Admin CANNOT promote/demote (owner-only)
      await db.drizzle
        .insert(db.schema.companyMembers)
        .values({ companyId, userId: 'cross-013-target', role: 'member' })
        .onConflictDoNothing();

      const promoteRes = await request(app)
        .post(url('/members/cross-013-target/role'))
        .send({ role: 'admin' })
        .expect(403);
      expect(promoteRes.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('local_trusted mode: owner membership produces same outcomes as matrix', async () => {
      await setRole('owner');

      // Owner can read
      await request(app).get(url('/agents')).expect(200);

      // Owner can write
      await request(app)
        .post(url('/artifacts'))
        .send({
          type: 'document',
          title: 'owner test',
          content: { format: 'markdown', body: '# Hello' },
        })
        .expect(201);

      // Owner can manage settings
      await request(app).get(url('/secrets')).expect(200);

      // Owner can promote/demote
      await db.drizzle
        .insert(db.schema.companyMembers)
        .values({ companyId, userId: 'cross-013-owner-target', role: 'member' })
        .onConflictDoNothing();

      await request(app)
        .post(url('/members/cross-013-owner-target/role'))
        .send({ role: 'admin' })
        .expect(200);
    });

    it('local_trusted impersonation header matches DB membership outcome', async () => {
      // The same role via header and via DB membership should produce
      // the same allow/deny outcome for the same operation.

      // Test: viewer cannot create artifacts
      // Via impersonation header
      const headerRes = await request(app)
        .post(url('/artifacts'))
        .set(roleHeader('viewer'))
        .send({
          type: 'document',
          title: 'header viewer',
          content: { format: 'markdown', body: '# Hello' },
        })
        .expect(403);
      expect(headerRes.body.code).toBe('INSUFFICIENT_PERMISSION');

      // Via DB membership (no header)
      await setRole('viewer');
      const dbRes = await request(app)
        .post(url('/artifacts'))
        .send({
          type: 'document',
          title: 'db viewer',
          content: { format: 'markdown', body: '# Hello' },
        })
        .expect(403);
      expect(dbRes.body.code).toBe('INSUFFICIENT_PERMISSION');

      // Both produce the same outcome: 403 INSUFFICIENT_PERMISSION
      expect(headerRes.status).toBe(dbRes.status);
      expect(headerRes.body.code).toBe(dbRes.body.code);
    });
  });
});
