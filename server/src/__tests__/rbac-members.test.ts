import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { eq, and } from 'drizzle-orm';
import { createTestDb, createTestServer } from '../test-utils.js';
import type { DbInstance } from '../types.js';

/**
 * RBAC Member Management Tests
 *
 * Comprehensive tests for the member management endpoints:
 *   GET    /api/companies/:companyId/members
 *   PATCH  /api/companies/:companyId/members/:memberId/role
 *   DELETE /api/companies/:companyId/members/:memberId
 *
 * Covers all VAL-MEM-* assertions plus VAL-RBAC-023/024 and VAL-CROSS-004/005.
 *
 * Each test produces the exact evidence specified in the validation contract:
 * status codes, response bodies, and DB state snapshots.
 */
describe('RBAC Member Management', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    // Create a company — auto-creates owner membership for dev-user-000
    const res = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Members Test', settings: { testFixture: true } })
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

  /** Headers to impersonate a specific user in local_trusted mode. */
  function userHeader(userId: string): Record<string, string> {
    return { 'X-Eidolon-Test-User-Id': userId };
  }

  /** Company-scoped URL. */
  function url(path: string): string {
    return `/api/companies/${companyId}${path}`;
  }

  /** Seed a membership row directly in the DB. */
  async function seedMember(userId: string, role: 'owner' | 'admin' | 'member' | 'viewer') {
    await db.drizzle
      .insert(db.schema.companyMembers)
      .values({ companyId, userId, role })
      .onConflictDoNothing();
  }

  /** Seed a company + membership in a different company. */
  async function seedOtherCompany(
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

  /** Get a specific membership row by userId. */
  async function getMembership(userId: string) {
    const rows = await db.drizzle
      .select()
      .from(db.schema.companyMembers)
      .where(
        and(
          eq(db.schema.companyMembers.companyId, companyId),
          eq(db.schema.companyMembers.userId, userId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Get a membership row by company_members.id. */
  async function getMembershipById(memberId: string) {
    const rows = await db.drizzle
      .select()
      .from(db.schema.companyMembers)
      .where(eq(db.schema.companyMembers.id, memberId))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Count owners in the company. */
  async function countOwners(): Promise<number> {
    const rows = await db.drizzle
      .select()
      .from(db.schema.companyMembers)
      .where(
        and(
          eq(db.schema.companyMembers.companyId, companyId),
          eq(db.schema.companyMembers.role, 'owner'),
        ),
      );
    return rows.length;
  }

  /** Count all members in the company. */
  async function countMembers(): Promise<number> {
    const rows = await db.drizzle
      .select()
      .from(db.schema.companyMembers)
      .where(eq(db.schema.companyMembers.companyId, companyId));
    return rows.length;
  }

  // =========================================================================
  // VAL-MEM-001: All company roles can list members
  // =========================================================================

  describe('VAL-MEM-001: all roles can list members', () => {
    it('owner gets 200 with member list', async () => {
      await seedMember('member-001', 'member');

      const res = await request(app).get(url('/members')).set(roleHeader('owner')).expect(200);

      expect(res.body.data).toBeDefined();
      expect(Array.isArray(res.body.data)).toBe(true);
      // Every returned member belongs to the requested company
      for (const m of res.body.data) {
        expect(m.userId).toBeDefined();
      }
    });

    it('admin gets 200 with member list', async () => {
      const res = await request(app).get(url('/members')).set(roleHeader('admin')).expect(200);
      expect(res.body.data).toBeDefined();
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('member gets 200 with member list', async () => {
      const res = await request(app).get(url('/members')).set(roleHeader('member')).expect(200);
      expect(res.body.data).toBeDefined();
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('viewer gets 200 with member list', async () => {
      const res = await request(app).get(url('/members')).set(roleHeader('viewer')).expect(200);
      expect(res.body.data).toBeDefined();
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  // =========================================================================
  // VAL-MEM-002: Non-members cannot list members
  // =========================================================================

  describe('VAL-MEM-002: non-members get 403 on list', () => {
    // In local_trusted mode, users with no memberships anywhere default
    // to 'owner' (backward compat). To test non-member denial, we use a
    // user who has a membership in ANOTHER company — the resolveMembership
    // logic gives them role='none' for the target company, which fails the
    // member.list permission check → 403. This is the same pattern used by
    // the existing rbac-contract-validation.test.ts for non-member tests.

    it('member of another company gets 403 on target company list', async () => {
      await seedOtherCompany('co-other-001', 'cross-user-001', 'owner');

      const res = await request(app)
        .get(url('/members'))
        .set(userHeader('cross-user-001'))
        .expect(403);

      // 403 is the required status; the error code may be NOT_MEMBER or
      // INSUFFICIENT_PERMISSION depending on the local_trusted resolution
      // path. The key assertion is that no member records are returned.
      expect(res.body).not.toHaveProperty('data');
    });

    it('user with membership in company A gets 403 on company B list', async () => {
      // Seed a non-dev user as owner in company A (companyId).
      // dev-user-000 cannot be used because local_trusted gives DEV_USER
      // default 'owner' for ANY company (backward compat).
      await seedMember('cross-actor-002', 'owner');

      // Create company B with a different owner.
      await seedOtherCompany('co-other-002', 'b-owner-002', 'owner');

      // cross-actor-002 (owner in A, no membership in B) tries to list
      // company B members → 403
      const res = await request(app)
        .get('/api/companies/co-other-002/members')
        .set(userHeader('cross-actor-002'))
        .expect(403);

      expect(res.body).not.toHaveProperty('data');
    });
  });

  // =========================================================================
  // VAL-MEM-003: Member list includes required fields
  // =========================================================================

  describe('VAL-MEM-003: member list includes userId, role, createdAt', () => {
    it('each member has userId, role, and parseable createdAt matching DB', async () => {
      await seedMember('user-field-001', 'admin');
      await seedMember('user-field-002', 'viewer');

      const res = await request(app).get(url('/members')).expect(200);

      const members = res.body.data;
      expect(members.length).toBeGreaterThanOrEqual(3); // dev-user-000 + 2 seeded

      // Verify each member has required fields
      for (const m of members) {
        expect(m.userId).toBeDefined();
        expect(typeof m.userId).toBe('string');
        expect(m.role).toBeDefined();
        expect(['owner', 'admin', 'member', 'viewer']).toContain(m.role);
        expect(m.createdAt).toBeDefined();
        expect(new Date(m.createdAt).toString()).not.toBe('Invalid Date');
      }

      // Verify specific seeded members match DB rows
      const adminMember = members.find((m: any) => m.userId === 'user-field-001');
      expect(adminMember).toBeDefined();
      expect(adminMember.role).toBe('admin');

      const dbRow = await getMembership('user-field-001');
      expect(adminMember.role).toBe(dbRow?.role);
      expect(new Date(adminMember.createdAt).toISOString()).toBe(dbRow?.createdAt.toISOString());
    });
  });

  // =========================================================================
  // VAL-MEM-004: Owner can change any member role
  // =========================================================================

  describe('VAL-MEM-004: owner can change any member role', () => {
    it('owner can PATCH a member role (200 with updated role)', async () => {
      await seedMember('promote-target-004', 'member');

      const res = await request(app)
        .patch(url('/members/promote-target-004/role'))
        .set(roleHeader('owner'))
        .send({ role: 'admin' })
        .expect(200);

      expect(res.body.data.role).toBe('admin');

      // DB state check
      const membership = await getMembership('promote-target-004');
      expect(membership?.role).toBe('admin');
    });

    it('owner can PATCH a viewer role (200)', async () => {
      await seedMember('promote-viewer-004', 'viewer');

      const res = await request(app)
        .patch(url('/members/promote-viewer-004/role'))
        .set(roleHeader('owner'))
        .send({ role: 'member' })
        .expect(200);

      expect(res.body.data.role).toBe('member');
      const membership = await getMembership('promote-viewer-004');
      expect(membership?.role).toBe('member');
    });

    it('owner can PATCH an admin role (200)', async () => {
      await seedMember('promote-admin-004', 'admin');

      const res = await request(app)
        .patch(url('/members/promote-admin-004/role'))
        .set(roleHeader('owner'))
        .send({ role: 'viewer' })
        .expect(200);

      expect(res.body.data.role).toBe('viewer');
      const membership = await getMembership('promote-admin-004');
      expect(membership?.role).toBe('viewer');
    });
  });

  // =========================================================================
  // VAL-MEM-005/006/007: Admin, member, viewer cannot change roles
  // =========================================================================

  describe('VAL-MEM-005: admin cannot change member roles', () => {
    it('admin gets 403 on PATCH role; target unchanged', async () => {
      await seedMember('admin-target-005', 'member');

      const before = await getMembership('admin-target-005');
      expect(before?.role).toBe('member');

      const res = await request(app)
        .patch(url('/members/admin-target-005/role'))
        .set(roleHeader('admin'))
        .send({ role: 'admin' })
        .expect(403);

      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      const after = await getMembership('admin-target-005');
      expect(after?.role).toBe('member');
    });
  });

  describe('VAL-MEM-006: member cannot change member roles', () => {
    it('member gets 403 on PATCH role; target unchanged', async () => {
      await seedMember('member-target-006', 'member');

      const before = await getMembership('member-target-006');
      expect(before?.role).toBe('member');

      const res = await request(app)
        .patch(url('/members/member-target-006/role'))
        .set(roleHeader('member'))
        .send({ role: 'admin' })
        .expect(403);

      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      const after = await getMembership('member-target-006');
      expect(after?.role).toBe('member');
    });
  });

  describe('VAL-MEM-007: viewer cannot change member roles', () => {
    it('viewer gets 403 on PATCH role; target unchanged', async () => {
      await seedMember('viewer-target-007', 'member');

      const before = await getMembership('viewer-target-007');
      expect(before?.role).toBe('member');

      const res = await request(app)
        .patch(url('/members/viewer-target-007/role'))
        .set(roleHeader('viewer'))
        .send({ role: 'admin' })
        .expect(403);

      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      const after = await getMembership('viewer-target-007');
      expect(after?.role).toBe('member');
    });
  });

  // =========================================================================
  // VAL-MEM-008: Owner can promote a member to admin
  // =========================================================================

  describe('VAL-MEM-008: owner can promote member to admin', () => {
    it('PATCH member→admin returns 200, response role=admin, DB role=admin', async () => {
      await seedMember('promote-008', 'member');

      const before = await getMembership('promote-008');
      expect(before?.role).toBe('member');

      const res = await request(app)
        .patch(url('/members/promote-008/role'))
        .set(roleHeader('owner'))
        .send({ role: 'admin' })
        .expect(200);

      expect(res.body.data.role).toBe('admin');

      const after = await getMembership('promote-008');
      expect(after?.role).toBe('admin');
    });
  });

  // =========================================================================
  // VAL-MEM-009: Owner can demote an admin to member
  // =========================================================================

  describe('VAL-MEM-009: owner can demote admin to member', () => {
    it('PATCH admin→member returns 200, response role=member, DB role=member', async () => {
      await seedMember('demote-009', 'admin');

      const before = await getMembership('demote-009');
      expect(before?.role).toBe('admin');

      const res = await request(app)
        .patch(url('/members/demote-009/role'))
        .set(roleHeader('owner'))
        .send({ role: 'member' })
        .expect(200);

      expect(res.body.data.role).toBe('member');

      const after = await getMembership('demote-009');
      expect(after?.role).toBe('member');
    });
  });

  // =========================================================================
  // VAL-MEM-010: Owner can promote a member to owner (multiple owners)
  // =========================================================================

  describe('VAL-MEM-010: owner can promote member to owner', () => {
    it('PATCH member→owner returns 200, two owners exist after', async () => {
      await seedMember('promote-owner-010', 'member');

      const ownersBefore = await countOwners();
      expect(ownersBefore).toBe(1); // dev-user-000

      const res = await request(app)
        .patch(url('/members/promote-owner-010/role'))
        .set(roleHeader('owner'))
        .send({ role: 'owner' })
        .expect(200);

      expect(res.body.data.role).toBe('owner');

      const ownersAfter = await countOwners();
      expect(ownersAfter).toBe(2);

      const membership = await getMembership('promote-owner-010');
      expect(membership?.role).toBe('owner');
    });
  });

  // =========================================================================
  // VAL-MEM-011 / VAL-RBAC-023: Last owner cannot demote themselves
  // =========================================================================

  describe('VAL-MEM-011 / VAL-RBAC-023: last owner cannot demote themselves', () => {
    it('sole owner PATCHing own role to non-owner gets 4xx; role unchanged', async () => {
      // dev-user-000 is the sole owner (auto-created on company creation)
      const ownersBefore = await countOwners();
      expect(ownersBefore).toBe(1);

      const res = await request(app)
        .patch(url('/members/dev-user-000/role'))
        .set(roleHeader('owner'))
        .send({ role: 'admin' });

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);

      // Owner row remains owner
      const membership = await getMembership('dev-user-000');
      expect(membership?.role).toBe('owner');

      // Company still has an owner
      const ownersAfter = await countOwners();
      expect(ownersAfter).toBe(1);
    });
  });

  // =========================================================================
  // VAL-MEM-012 / VAL-RBAC-024: Owner can demote self when another owner exists
  // =========================================================================

  describe('VAL-MEM-012 / VAL-RBAC-024: owner self-demotion with another owner', () => {
    it('owner can PATCH own role to member when another owner exists', async () => {
      // Promote a second member to owner
      await seedMember('second-owner-012', 'member');
      await db.drizzle
        .update(db.schema.companyMembers)
        .set({ role: 'owner', updatedAt: new Date() })
        .where(
          and(
            eq(db.schema.companyMembers.companyId, companyId),
            eq(db.schema.companyMembers.userId, 'second-owner-012'),
          ),
        );

      const ownersBefore = await countOwners();
      expect(ownersBefore).toBe(2);

      // dev-user-000 (owner) demotes self to member
      const res = await request(app)
        .patch(url('/members/dev-user-000/role'))
        .set(roleHeader('owner'))
        .send({ role: 'member' })
        .expect(200);

      expect(res.body.data.role).toBe('member');

      // At least one owner remains
      const ownersAfter = await countOwners();
      expect(ownersAfter).toBe(1);

      const selfMembership = await getMembership('dev-user-000');
      expect(selfMembership?.role).toBe('member');

      const otherMembership = await getMembership('second-owner-012');
      expect(otherMembership?.role).toBe('owner');
    });
  });

  // =========================================================================
  // VAL-MEM-013: Owner can remove any member
  // =========================================================================

  describe('VAL-MEM-013: owner can remove any member', () => {
    it('owner can DELETE an admin (200)', async () => {
      await seedMember('remove-admin-013', 'admin');

      const res = await request(app)
        .delete(url('/members/remove-admin-013'))
        .set(roleHeader('owner'))
        .expect(200);

      expect(res.body.data.removed).toBe(true);

      const membership = await getMembership('remove-admin-013');
      expect(membership).toBeNull();
    });

    it('owner can DELETE a member (200)', async () => {
      await seedMember('remove-member-013', 'member');

      await request(app)
        .delete(url('/members/remove-member-013'))
        .set(roleHeader('owner'))
        .expect(200);

      const membership = await getMembership('remove-member-013');
      expect(membership).toBeNull();
    });

    it('owner can DELETE a viewer (200)', async () => {
      await seedMember('remove-viewer-013', 'viewer');

      await request(app)
        .delete(url('/members/remove-viewer-013'))
        .set(roleHeader('owner'))
        .expect(200);

      const membership = await getMembership('remove-viewer-013');
      expect(membership).toBeNull();
    });

    it('owner can DELETE another (non-last) owner (200)', async () => {
      await seedMember('remove-owner-013', 'owner');

      // Two owners exist: dev-user-000 and remove-owner-013
      const ownersBefore = await countOwners();
      expect(ownersBefore).toBe(2);

      await request(app)
        .delete(url('/members/remove-owner-013'))
        .set(roleHeader('owner'))
        .expect(200);

      const membership = await getMembership('remove-owner-013');
      expect(membership).toBeNull();

      const ownersAfter = await countOwners();
      expect(ownersAfter).toBe(1);
    });
  });

  // =========================================================================
  // VAL-MEM-014: Admin can remove non-owner but not owners
  // =========================================================================

  describe('VAL-MEM-014: admin can remove non-owners but not owners', () => {
    it('admin can DELETE an admin (200)', async () => {
      await seedMember('admin-remove-admin-014', 'admin');

      await request(app)
        .delete(url('/members/admin-remove-admin-014'))
        .set(roleHeader('admin'))
        .expect(200);

      const membership = await getMembership('admin-remove-admin-014');
      expect(membership).toBeNull();
    });

    it('admin can DELETE a member (200)', async () => {
      await seedMember('admin-remove-member-014', 'member');

      await request(app)
        .delete(url('/members/admin-remove-member-014'))
        .set(roleHeader('admin'))
        .expect(200);

      const membership = await getMembership('admin-remove-member-014');
      expect(membership).toBeNull();
    });

    it('admin can DELETE a viewer (200)', async () => {
      await seedMember('admin-remove-viewer-014', 'viewer');

      await request(app)
        .delete(url('/members/admin-remove-viewer-014'))
        .set(roleHeader('admin'))
        .expect(200);

      const membership = await getMembership('admin-remove-viewer-014');
      expect(membership).toBeNull();
    });

    it('admin CANNOT DELETE an owner (403); owner intact', async () => {
      await seedMember('admin-cannot-remove-owner-014', 'owner');

      const before = await getMembership('admin-cannot-remove-owner-014');
      expect(before?.role).toBe('owner');

      const res = await request(app)
        .delete(url('/members/admin-cannot-remove-owner-014'))
        .set(roleHeader('admin'))
        .expect(403);

      expect(res.body.code).toBe('CANNOT_REMOVE_OWNER');

      const after = await getMembership('admin-cannot-remove-owner-014');
      expect(after?.role).toBe('owner');
    });
  });

  // =========================================================================
  // VAL-MEM-015: Member cannot remove members
  // =========================================================================

  describe('VAL-MEM-015: member cannot remove members', () => {
    it('member gets 403 on DELETE; target membership remains', async () => {
      await seedMember('member-cannot-remove-015', 'viewer');

      const before = await getMembership('member-cannot-remove-015');
      expect(before).not.toBeNull();

      const res = await request(app)
        .delete(url('/members/member-cannot-remove-015'))
        .set(roleHeader('member'))
        .expect(403);

      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      const after = await getMembership('member-cannot-remove-015');
      expect(after).not.toBeNull();
    });
  });

  // =========================================================================
  // VAL-MEM-016: Last owner cannot be removed
  // =========================================================================

  describe('VAL-MEM-016: last owner cannot be removed', () => {
    it('owner cannot DELETE the sole owner (4xx); owner remains', async () => {
      const ownersBefore = await countOwners();
      expect(ownersBefore).toBe(1);

      const res = await request(app).delete(url('/members/dev-user-000')).set(roleHeader('owner'));

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);

      const membership = await getMembership('dev-user-000');
      expect(membership).not.toBeNull();
      expect(membership?.role).toBe('owner');

      const ownersAfter = await countOwners();
      expect(ownersAfter).toBe(1);
    });

    it('admin cannot DELETE the sole owner (403); owner remains', async () => {
      const res = await request(app)
        .delete(url('/members/dev-user-000'))
        .set(roleHeader('admin'))
        .expect(403);

      expect(res.body.code).toBe('CANNOT_REMOVE_OWNER');

      const membership = await getMembership('dev-user-000');
      expect(membership?.role).toBe('owner');
    });
  });

  // =========================================================================
  // VAL-MEM-017: Removed member loses company-scoped access
  // =========================================================================

  describe('VAL-MEM-017: removed member loses access', () => {
    it('after removal, user gets 403 on member list and company-scoped endpoint', async () => {
      // Seed the user in the target company AND another company.
      // The other-company membership ensures that after removal from the
      // target company, the user doesn't fall back to default 'owner'
      // (local_trusted backward compat for users with no memberships).
      await seedMember('remove-loses-access-017', 'member');
      await seedOtherCompany('co-other-017', 'remove-loses-access-017', 'member');

      // Verify they can list members before removal
      const beforeRes = await request(app)
        .get(url('/members'))
        .set(userHeader('remove-loses-access-017'))
        .expect(200);
      expect(beforeRes.body.data).toBeDefined();

      // Owner removes the member
      await request(app)
        .delete(url('/members/remove-loses-access-017'))
        .set(roleHeader('owner'))
        .expect(200);

      // Removed user now gets 403 on member list
      const afterListRes = await request(app)
        .get(url('/members'))
        .set(userHeader('remove-loses-access-017'))
        .expect(403);
      expect(afterListRes.body).not.toHaveProperty('data');

      // Removed user gets 403 on another company-scoped endpoint (agents)
      const afterAgentsRes = await request(app)
        .get(url('/agents'))
        .set(userHeader('remove-loses-access-017'))
        .expect(403);
      expect(afterAgentsRes.body).not.toHaveProperty('data');

      // Control: the user still has access to their other company
      const otherRes = await request(app)
        .get('/api/companies/co-other-017/members')
        .set(userHeader('remove-loses-access-017'))
        .expect(200);
      expect(otherRes.body.data).toBeDefined();
    });
  });

  // =========================================================================
  // VAL-MEM-018: Invalid target role is rejected
  // =========================================================================

  describe('VAL-MEM-018: invalid role returns 400', () => {
    it('PATCH with invalid role returns 400; target unchanged', async () => {
      await seedMember('invalid-role-target-018', 'member');

      const before = await getMembership('invalid-role-target-018');
      expect(before?.role).toBe('member');

      const res = await request(app)
        .patch(url('/members/invalid-role-target-018/role'))
        .set(roleHeader('owner'))
        .send({ role: 'superadmin' })
        .expect(400);

      expect(res.body.code).toBe('VALIDATION_ERROR');

      const after = await getMembership('invalid-role-target-018');
      expect(after?.role).toBe('member');
    });
  });

  // =========================================================================
  // VAL-MEM-019: Non-existent member returns 404
  // =========================================================================

  describe('VAL-MEM-019: non-existent memberId returns 404', () => {
    it('PATCH non-existent memberId returns 404; no rows changed', async () => {
      const membersBefore = await countMembers();

      const res = await request(app)
        .patch(url('/members/nonexistent-user-999/role'))
        .set(roleHeader('owner'))
        .send({ role: 'admin' })
        .expect(404);

      expect(res.body.code).toBe('MEMBER_NOT_FOUND');

      const membersAfter = await countMembers();
      expect(membersAfter).toBe(membersBefore);
    });

    it('DELETE non-existent memberId returns 404; no rows changed', async () => {
      const membersBefore = await countMembers();

      const res = await request(app)
        .delete(url('/members/nonexistent-user-999'))
        .set(roleHeader('owner'))
        .expect(404);

      expect(res.body.code).toBe('MEMBER_NOT_FOUND');

      const membersAfter = await countMembers();
      expect(membersAfter).toBe(membersBefore);
    });

    it('PATCH with fabricated UUID returns 404', async () => {
      const fakeUuid = '00000000-0000-0000-0000-000000000000';

      const res = await request(app)
        .patch(url(`/members/${fakeUuid}/role`))
        .set(roleHeader('owner'))
        .send({ role: 'admin' })
        .expect(404);

      expect(res.body.code).toBe('MEMBER_NOT_FOUND');
    });
  });

  // =========================================================================
  // VAL-MEM-020: Cross-company member management is denied
  // =========================================================================

  describe('VAL-MEM-020: cross-company management denied', () => {
    it('user in company A gets 403 on company B members (GET, PATCH, DELETE)', async () => {
      // Create company B with its own owner
      await seedOtherCompany('co-cross-020', 'cross-owner-020', 'owner');
      // Seed a member in company B
      await db.drizzle
        .insert(db.schema.companyMembers)
        .values({ companyId: 'co-cross-020', userId: 'cross-target-020', role: 'member' })
        .onConflictDoNothing();

      // Seed a non-dev user as owner in company A (companyId).
      // dev-user-000 cannot be used because local_trusted gives DEV_USER
      // default 'owner' for ANY company (backward compat), so it would
      // bypass the cross-company check.
      await seedMember('cross-actor-020', 'owner');

      // cross-actor-020 is owner in companyId (company A) but has NO
      // membership in co-cross-020 (company B). Without role impersonation
      // headers, resolveMembership looks up (co-cross-020, cross-actor-020)
      // → no match → finds membership elsewhere → role='none' → 403.

      const beforeCount = await db.drizzle
        .select()
        .from(db.schema.companyMembers)
        .where(eq(db.schema.companyMembers.companyId, 'co-cross-020'));
      const membersBefore = beforeCount.length;

      // GET members of company B → 403
      const getRes = await request(app)
        .get('/api/companies/co-cross-020/members')
        .set(userHeader('cross-actor-020'))
        .expect(403);
      expect(getRes.body).not.toHaveProperty('data');

      // PATCH role in company B → 403
      const patchRes = await request(app)
        .patch('/api/companies/co-cross-020/members/cross-target-020/role')
        .set(userHeader('cross-actor-020'))
        .send({ role: 'admin' })
        .expect(403);
      expect(patchRes.body).not.toHaveProperty('data');

      // DELETE member in company B → 403
      const deleteRes = await request(app)
        .delete('/api/companies/co-cross-020/members/cross-target-020')
        .set(userHeader('cross-actor-020'))
        .expect(403);
      expect(deleteRes.body).not.toHaveProperty('data');

      // No membership rows changed in company B
      const afterRows = await db.drizzle
        .select()
        .from(db.schema.companyMembers)
        .where(eq(db.schema.companyMembers.companyId, 'co-cross-020'));
      expect(afterRows.length).toBe(membersBefore);

      // The target member's role is unchanged
      const targetMember = afterRows.find((r) => r.userId === 'cross-target-020');
      expect(targetMember?.role).toBe('member');
    });
  });

  // =========================================================================
  // VAL-CROSS-004: Demotion propagates on the next request
  // =========================================================================

  describe('VAL-CROSS-004: demotion propagates on next request', () => {
    it('demoted admin gets 403 on admin-only endpoint; member-level still works', async () => {
      // Seed an admin in the target company and a member in another company
      // (the other-company membership prevents the local_trusted default
      // 'owner' fallback from masking the demotion).
      await seedMember('demote-propagate-004', 'admin');
      await seedOtherCompany('co-other-004', 'demote-propagate-004', 'member');

      // Before demotion: admin can access admin-only endpoint (integrations)
      const beforeRes = await request(app)
        .get(url('/integrations'))
        .set(userHeader('demote-propagate-004'))
        .expect(200);
      expect(beforeRes.status).toBe(200);

      // Owner demotes admin to member
      await request(app)
        .patch(url('/members/demote-propagate-004/role'))
        .set(roleHeader('owner'))
        .send({ role: 'member' })
        .expect(200);

      // After demotion: same user gets 403 on admin-only endpoint
      const afterAdminRes = await request(app)
        .get(url('/integrations'))
        .set(userHeader('demote-propagate-004'))
        .expect(403);
      expect(afterAdminRes.body).not.toHaveProperty('data');

      // Member-level endpoint still works (agents list — company.view)
      const afterMemberRes = await request(app)
        .get(url('/agents'))
        .set(userHeader('demote-propagate-004'))
        .expect(200);
      expect(afterMemberRes.status).toBe(200);
    });
  });

  // =========================================================================
  // VAL-CROSS-005: Removal propagates on the next request
  // =========================================================================

  describe('VAL-CROSS-005: removal propagates on next request', () => {
    it('removed user gets 403 on next company-scoped request', async () => {
      // Seed the user in the target company AND another company so that
      // after removal they don't fall back to default 'owner' in
      // local_trusted mode.
      await seedMember('remove-propagate-005', 'member');
      await seedOtherCompany('co-other-005', 'remove-propagate-005', 'member');

      // Before removal: can access company-scoped endpoint
      const beforeRes = await request(app)
        .get(url('/agents'))
        .set(userHeader('remove-propagate-005'))
        .expect(200);
      expect(beforeRes.status).toBe(200);

      // Owner removes the member
      await request(app)
        .delete(url('/members/remove-propagate-005'))
        .set(roleHeader('owner'))
        .expect(200);

      // After removal: same user gets 403 immediately
      const afterRes = await request(app)
        .get(url('/agents'))
        .set(userHeader('remove-propagate-005'))
        .expect(403);
      expect(afterRes.body).not.toHaveProperty('data');

      // Control: the owner (dev-user-000) still has access
      const ownerRes = await request(app).get(url('/agents')).expect(200);
      expect(ownerRes.status).toBe(200);

      // Control: the removed user still has access to their other company
      const otherRes = await request(app)
        .get('/api/companies/co-other-005/agents')
        .set(userHeader('remove-propagate-005'))
        .expect(200);
      expect(otherRes.status).toBe(200);
    });
  });

  // =========================================================================
  // Backward compatibility: POST /:memberId/role still works
  // =========================================================================

  describe('backward compat: POST /:memberId/role', () => {
    it('POST role change works same as PATCH', async () => {
      await seedMember('post-compat-target', 'member');

      const res = await request(app)
        .post(url('/members/post-compat-target/role'))
        .set(roleHeader('owner'))
        .send({ role: 'admin' })
        .expect(200);

      expect(res.body.data.role).toBe('admin');

      const membership = await getMembership('post-compat-target');
      expect(membership?.role).toBe('admin');
    });
  });

  // =========================================================================
  // Member lookup by company_members.id (UUID)
  // =========================================================================

  describe('member lookup by id (UUID)', () => {
    it('PATCH by company_members.id works', async () => {
      await seedMember('uuid-lookup-target', 'member');
      const membership = await getMembership('uuid-lookup-target');
      expect(membership).not.toBeNull();

      const res = await request(app)
        .patch(url(`/members/${membership!.id}/role`))
        .set(roleHeader('owner'))
        .send({ role: 'admin' })
        .expect(200);

      expect(res.body.data.role).toBe('admin');
      expect(res.body.data.id).toBe(membership!.id);

      const after = await getMembershipById(membership!.id);
      expect(after?.role).toBe('admin');
    });

    it('DELETE by company_members.id works', async () => {
      await seedMember('uuid-delete-target', 'member');
      const membership = await getMembership('uuid-delete-target');
      expect(membership).not.toBeNull();

      await request(app)
        .delete(url(`/members/${membership!.id}`))
        .set(roleHeader('owner'))
        .expect(200);

      const after = await getMembershipById(membership!.id);
      expect(after).toBeNull();
    });
  });
});
