import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { eq, and } from 'drizzle-orm';
import { createTestDb, createTestServer } from '../test-utils.js';

/**
 * RBAC company creation and list tests.
 *
 * Covers:
 * - VAL-RBAC-010: my-role returns the current company role for each role type
 * - VAL-RBAC-011: my-role denies non-members
 * - VAL-RBAC-012: Company creation auto-creates the owner membership
 * - VAL-RBAC-013: Company creation does not assign unrelated users
 * - VAL-RBAC-025: Companies list filters by company_members membership
 * - VAL-RBAC-026: Companies list returns empty for user with no memberships
 * - VAL-CROSS-006: Company creator receives owner access
 * - VAL-CROSS-016: New user can create their first company
 */
describe('RBAC company creation and list', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Seed a company directly in the DB (no membership). */
  async function seedCompany(companyId: string, name = `__mtest__ ${companyId}`) {
    await db.drizzle
      .insert(db.schema.companies)
      .values({ id: companyId, name, settings: { testFixture: true } })
      .onConflictDoNothing();
  }

  /** Seed a company + membership directly in the DB. */
  async function seedMembership(
    companyId: string,
    userId: string,
    role: 'owner' | 'admin' | 'member' | 'viewer',
  ) {
    await seedCompany(companyId);
    await db.drizzle
      .insert(db.schema.companyMembers)
      .values({ companyId, userId, role })
      .onConflictDoNothing();
  }

  // -------------------------------------------------------------------------
  // POST /api/companies — auto-create owner membership
  // -------------------------------------------------------------------------

  describe('POST /api/companies — auto-create owner membership', () => {
    it('creates a company_members row with role=owner for the creator (VAL-RBAC-012)', async () => {
      const res = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Owner Auto-Create', settings: { testFixture: true } })
        .expect(201);

      const companyId = res.body.data.id;

      // Exactly one membership row for this company
      const memberships = await db.drizzle
        .select()
        .from(db.schema.companyMembers)
        .where(eq(db.schema.companyMembers.companyId, companyId));

      expect(memberships).toHaveLength(1);
      expect(memberships[0].userId).toBe('dev-user-000');
      expect(memberships[0].role).toBe('owner');
    });

    it('does not create memberships for unrelated users (VAL-RBAC-013)', async () => {
      const res = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ No Unrelated', settings: { testFixture: true } })
        .expect(201);

      const companyId = res.body.data.id;

      // Only one membership — for the creator
      const allMemberships = await db.drizzle
        .select()
        .from(db.schema.companyMembers)
        .where(eq(db.schema.companyMembers.companyId, companyId));

      expect(allMemberships).toHaveLength(1);
      expect(allMemberships[0].userId).toBe('dev-user-000');

      // A different user has no membership and cannot access the company
      const res2 = await request(app)
        .get(`/api/companies/${companyId}/my-role`)
        .set('X-Eidolon-Test-User-Id', 'other-user-001');

      expect(res2.status).toBe(403);
      expect(res2.body.code).toBe('NOT_MEMBER');
      expect(res2.body).not.toHaveProperty('role');
    });

    it('creator can immediately perform owner-only actions after creation (VAL-CROSS-006)', async () => {
      const res = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Owner Actions', settings: { testFixture: true } })
        .expect(201);

      const companyId = res.body.data.id;

      // The creator's role is owner
      const roleRes = await request(app).get(`/api/companies/${companyId}/my-role`).expect(200);

      expect(roleRes.body.role).toBe('owner');
      expect(roleRes.body).not.toHaveProperty('data');

      // The creator can access company-scoped endpoints (behind requireOrgMember)
      const agentsRes = await request(app).get(`/api/companies/${companyId}/agents`).expect(200);

      expect(agentsRes.body.data).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/companies — membership-based filtering
  // -------------------------------------------------------------------------

  describe('GET /api/companies — membership filtering', () => {
    it('returns only companies where the user has a company_members row (VAL-RBAC-025)', async () => {
      // Create company A (via POST → auto-creates owner membership)
      const resA = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Membership A', settings: { testFixture: true } })
        .expect(201);
      const companyAId = resA.body.data.id;

      // Create company B (via POST → auto-creates owner membership)
      const resB = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Membership B', settings: { testFixture: true } })
        .expect(201);
      const companyBId = resB.body.data.id;

      // Seed company C directly in DB (NO membership for dev-user-000)
      await seedCompany('co-no-membership', '__mtest__ No Membership C');

      // GET /api/companies as dev-user-000 → should see only A and B
      const listRes = await request(app).get('/api/companies').expect(200);

      const ids = listRes.body.data.map((c: { id: string }) => c.id);
      expect(ids).toContain(companyAId);
      expect(ids).toContain(companyBId);
      expect(ids).not.toContain('co-no-membership');
      expect(listRes.body.data).toHaveLength(2);
    });

    it('returns empty list for user with no memberships (VAL-RBAC-026)', async () => {
      // Seed a company directly in DB (no membership for anyone)
      await seedCompany('co-orphan', '__mtest__ Orphan Company');

      // GET /api/companies as dev-user-000 (no memberships) → empty
      const res = await request(app).get('/api/companies').expect(200);
      expect(res.body.data).toEqual([]);
    });

    it('returns empty list for a different user with no memberships', async () => {
      // Create a company as dev-user-000
      await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Dev User Company', settings: { testFixture: true } })
        .expect(201);

      // GET /api/companies as a different user → empty
      const res = await request(app)
        .get('/api/companies')
        .set('X-Eidolon-Test-User-Id', 'new-user-001')
        .expect(200);

      expect(res.body.data).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/companies/:id/my-role
  // -------------------------------------------------------------------------

  describe('GET /api/companies/:id/my-role', () => {
    it('returns 200 with correct role for owner membership (VAL-RBAC-010)', async () => {
      await seedMembership('co-role-owner', 'dev-user-000', 'owner');

      const res = await request(app).get('/api/companies/co-role-owner/my-role').expect(200);

      expect(res.body.role).toBe('owner');
      expect(res.body).toEqual({ role: 'owner' });
    });

    it('returns 200 with correct role for admin membership (VAL-RBAC-010)', async () => {
      await seedMembership('co-role-admin', 'dev-user-000', 'admin');

      const res = await request(app).get('/api/companies/co-role-admin/my-role').expect(200);

      expect(res.body.role).toBe('admin');
    });

    it('returns 200 with correct role for member membership (VAL-RBAC-010)', async () => {
      await seedMembership('co-role-member', 'dev-user-000', 'member');

      const res = await request(app).get('/api/companies/co-role-member/my-role').expect(200);

      expect(res.body.role).toBe('member');
    });

    it('returns 200 with correct role for viewer membership (VAL-RBAC-010)', async () => {
      await seedMembership('co-role-viewer', 'dev-user-000', 'viewer');

      const res = await request(app).get('/api/companies/co-role-viewer/my-role').expect(200);

      expect(res.body.role).toBe('viewer');
    });

    it('returns 403 for non-members (VAL-RBAC-011)', async () => {
      await seedCompany('co-no-role');

      const res = await request(app).get('/api/companies/co-no-role/my-role').expect(403);

      expect(res.body.code).toBe('NOT_MEMBER');
      expect(res.body).not.toHaveProperty('data');
    });

    it('returns 403 for a different user with no membership', async () => {
      await seedMembership('co-other-user', 'dev-user-000', 'owner');

      const res = await request(app)
        .get('/api/companies/co-other-user/my-role')
        .set('X-Eidolon-Test-User-Id', 'unrelated-user')
        .expect(403);

      expect(res.body.code).toBe('NOT_MEMBER');
    });

    it('returns the correct role for a different user who has a membership', async () => {
      await seedMembership('co-multi-user', 'dev-user-000', 'owner');
      await seedMembership('co-multi-user', 'other-user-001', 'viewer');

      // dev-user-000 sees owner
      const res1 = await request(app).get('/api/companies/co-multi-user/my-role').expect(200);
      expect(res1.body.role).toBe('owner');

      // other-user-001 sees viewer
      const res2 = await request(app)
        .get('/api/companies/co-multi-user/my-role')
        .set('X-Eidolon-Test-User-Id', 'other-user-001')
        .expect(200);
      expect(res2.body.role).toBe('viewer');
    });
  });

  // -------------------------------------------------------------------------
  // Cross-area flow: new user creates first company (VAL-CROSS-016)
  // -------------------------------------------------------------------------

  describe('New user flow: empty list → create first company → becomes owner (VAL-CROSS-016)', async () => {
    it('new user sees empty list, creates first company, becomes owner', async () => {
      const newUserId = 'brand-new-user-001';

      // Step 1: New user sees an empty company list
      const emptyListRes = await request(app)
        .get('/api/companies')
        .set('X-Eidolon-Test-User-Id', newUserId)
        .expect(200);

      expect(emptyListRes.body.data).toEqual([]);

      // Step 2: New user creates their first company
      const createRes = await request(app)
        .post('/api/companies')
        .set('X-Eidolon-Test-User-Id', newUserId)
        .send({ name: '__mtest__ First Company', settings: { testFixture: true } })
        .expect(201);

      const newCompanyId = createRes.body.data.id;

      // Step 3: The new user is the owner of the new company
      const roleRes = await request(app)
        .get(`/api/companies/${newCompanyId}/my-role`)
        .set('X-Eidolon-Test-User-Id', newUserId)
        .expect(200);

      expect(roleRes.body.role).toBe('owner');

      // Step 4: The new company appears in the user's company list
      const listRes = await request(app)
        .get('/api/companies')
        .set('X-Eidolon-Test-User-Id', newUserId)
        .expect(200);

      expect(listRes.body.data).toHaveLength(1);
      expect(listRes.body.data[0].id).toBe(newCompanyId);
    });
  });
});
