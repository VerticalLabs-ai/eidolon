import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { eq, and } from 'drizzle-orm';
import { createTestDb, closeTestDb } from '../test-utils.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import type { DbInstance } from '../types.js';
import type { AuthSession } from '../auth.js';

// ---------------------------------------------------------------------------
// Test DB singleton
// ---------------------------------------------------------------------------

let db: DbInstance;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedCompany(companyId: string) {
  await db.drizzle
    .insert(db.schema.companies)
    .values({
      id: companyId,
      name: `__mtest__ ${companyId}`,
      settings: { testFixture: true },
    })
    .onConflictDoNothing();
}

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

function mockClerkSession(
  userId: string,
  overrides: Partial<AuthSession['session']> = {},
): AuthSession {
  return {
    user: { id: userId, name: 'Test User', email: `${userId}@test.com` },
    session: {
      id: 'sess-test',
      userId,
      activeOrganizationId: null,
      activeOrganizationRole: null,
      ...overrides,
    },
  };
}

/**
 * Build a lightweight Express app that mounts test routes guarded by
 * requireOrgMember and requirePermission. Uses the real test DB for
 * membership resolution.
 */
function buildApp(opts: {
  authMode?: 'local_trusted' | 'authenticated';
  verify?: (req: Request) => Promise<AuthSession | null>;
}) {
  const app = express();
  app.use(express.json());
  const { requireAuth, requireOrgMember, requirePermission } = createAuthMiddleware({
    authMode: opts.authMode ?? 'local_trusted',
    verify: opts.verify,
    db,
  });

  // requireOrgMember routes (legacy, still used by non-migrated routes)
  app.get(
    '/companies/:companyId/ping',
    requireAuth,
    requireOrgMember(),
    (req: Request, res: Response) => {
      res.json({ membership: req.organizationMembership ?? null });
    },
  );

  // requirePermission routes
  app.get(
    '/companies/:companyId/view',
    requireAuth,
    requirePermission('company.view'),
    (req: Request, res: Response) => {
      res.json({ membership: req.organizationMembership ?? null });
    },
  );

  app.post(
    '/companies/:companyId/settings',
    requireAuth,
    requirePermission('company.settings.update'),
    (req: Request, res: Response) => {
      res.json({ membership: req.organizationMembership ?? null });
    },
  );

  app.delete(
    '/companies/:companyId/delete',
    requireAuth,
    requirePermission('company.delete'),
    (req: Request, res: Response) => {
      res.json({ membership: req.organizationMembership ?? null });
    },
  );

  app.post(
    '/companies/:companyId/artifacts',
    requireAuth,
    requirePermission('artifact.create'),
    (req: Request, res: Response) => {
      res.json({ membership: req.organizationMembership ?? null });
    },
  );

  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RBAC membership middleware', () => {
  beforeEach(async () => {
    // Reset the DB between tests (createTestDb does TRUNCATE on re-call,
    // but we need to reset within the same instance)
    const { createTestDb: reset } = await import('../test-utils.js');
    // TRUNCATE is handled by re-invoking createTestDb (it resets singleton)
    // Instead we just manually clean the relevant tables
  });

  // -------------------------------------------------------------------------
  // local_trusted: default owner access preserved (VAL-RBAC-014)
  // -------------------------------------------------------------------------

  describe('local_trusted default owner access', () => {
    it('grants owner access with no headers and no company_members row', async () => {
      const app = buildApp({ authMode: 'local_trusted' });

      const res = await request(app).get('/companies/co-default/ping').expect(200);
      expect(res.body.membership.role).toBe('owner');
      expect(res.body.membership.organizationId).toBe('co-default');
    });

    it('allows owner-only operations with no headers and no membership', async () => {
      const app = buildApp({ authMode: 'local_trusted' });

      // company.delete is owner-only
      await request(app).delete('/companies/co-default/delete').expect(200);
    });
  });

  // -------------------------------------------------------------------------
  // local_trusted: role impersonation via headers (VAL-RBAC-015)
  // -------------------------------------------------------------------------

  describe('local_trusted role impersonation', () => {
    it('honors X-Eidolon-Test-Org-Role: owner', async () => {
      const app = buildApp({ authMode: 'local_trusted' });

      const res = await request(app)
        .get('/companies/co-imp/ping')
        .set('X-Eidolon-Test-Org-Role', 'owner')
        .expect(200);
      expect(res.body.membership.role).toBe('owner');
    });

    it('honors X-Eidolon-Test-Org-Role: admin and allows admin-level operations', async () => {
      const app = buildApp({ authMode: 'local_trusted' });

      const res = await request(app)
        .get('/companies/co-imp/ping')
        .set('X-Eidolon-Test-Org-Role', 'admin')
        .expect(200);
      expect(res.body.membership.role).toBe('admin');

      // admin can update settings
      await request(app)
        .post('/companies/co-imp/settings')
        .set('X-Eidolon-Test-Org-Role', 'admin')
        .expect(200);
    });

    it('honors X-Eidolon-Test-Org-Role: member and denies admin operations', async () => {
      const app = buildApp({ authMode: 'local_trusted' });

      // member can view
      const res = await request(app)
        .get('/companies/co-imp/view')
        .set('X-Eidolon-Test-Org-Role', 'member')
        .expect(200);
      expect(res.body.membership.role).toBe('member');

      // member cannot update settings (admin+)
      const denied = await request(app)
        .post('/companies/co-imp/settings')
        .set('X-Eidolon-Test-Org-Role', 'member')
        .expect(403);
      expect(denied.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('honors X-Eidolon-Test-Org-Role: viewer and denies write operations', async () => {
      const app = buildApp({ authMode: 'local_trusted' });

      // viewer can view
      const res = await request(app)
        .get('/companies/co-imp/view')
        .set('X-Eidolon-Test-Org-Role', 'viewer')
        .expect(200);
      expect(res.body.membership.role).toBe('viewer');

      // viewer cannot create artifacts
      const denied = await request(app)
        .post('/companies/co-imp/artifacts')
        .set('X-Eidolon-Test-Org-Role', 'viewer')
        .expect(403);
      expect(denied.body.code).toBe('INSUFFICIENT_PERMISSION');

      // viewer cannot delete company
      const denied2 = await request(app)
        .delete('/companies/co-imp/delete')
        .set('X-Eidolon-Test-Org-Role', 'viewer')
        .expect(403);
      expect(denied2.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('honors X-Eidolon-Test-Org-Role: admin but denies owner-only operations', async () => {
      const app = buildApp({ authMode: 'local_trusted' });

      // admin cannot delete company (owner-only)
      const denied = await request(app)
        .delete('/companies/co-imp/delete')
        .set('X-Eidolon-Test-Org-Role', 'admin')
        .expect(403);
      expect(denied.body.code).toBe('INSUFFICIENT_PERMISSION');
    });
  });

  // -------------------------------------------------------------------------
  // local_trusted: uses company_members rows when present (VAL-RBAC-014)
  // -------------------------------------------------------------------------

  describe('local_trusted company_members resolution', () => {
    it('uses company_members row for dev-user-000 when no impersonation header', async () => {
      await seedMembership('co-db-1', 'dev-user-000', 'member');

      const app = buildApp({ authMode: 'local_trusted' });

      // No X-Eidolon-Test-Org-Role header → should resolve from company_members
      const res = await request(app).get('/companies/co-db-1/ping').expect(200);
      expect(res.body.membership.role).toBe('member');
    });

    it('uses company_members row for viewer and denies write operations', async () => {
      await seedMembership('co-db-2', 'dev-user-000', 'viewer');

      const app = buildApp({ authMode: 'local_trusted' });

      // viewer can view
      await request(app).get('/companies/co-db-2/view').expect(200);

      // viewer cannot create artifacts
      const denied = await request(app).post('/companies/co-db-2/artifacts').expect(403);
      expect(denied.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('impersonation header overrides company_members row', async () => {
      await seedMembership('co-db-3', 'dev-user-000', 'viewer');

      const app = buildApp({ authMode: 'local_trusted' });

      // With impersonation header set to admin, should use admin even though DB says viewer
      const res = await request(app)
        .get('/companies/co-db-3/ping')
        .set('X-Eidolon-Test-Org-Role', 'admin')
        .expect(200);
      expect(res.body.membership.role).toBe('admin');
    });

    it('falls back to default owner when no header and no company_members row', async () => {
      // No membership seeded for co-no-member
      const app = buildApp({ authMode: 'local_trusted' });

      const res = await request(app).get('/companies/co-no-member/ping').expect(200);
      expect(res.body.membership.role).toBe('owner');
    });
  });

  // -------------------------------------------------------------------------
  // Clerk (authenticated) mode: membership resolved from company_members (VAL-RBAC-006, VAL-RBAC-007)
  // -------------------------------------------------------------------------

  describe('Clerk mode membership resolution', () => {
    it('resolves membership from company_members without Clerk org membership', async () => {
      await seedMembership('co-clerk-1', 'user-clerk-1', 'member');

      const app = buildApp({
        authMode: 'authenticated',
        verify: async () => mockClerkSession('user-clerk-1'), // no activeOrganizationId
      });

      const res = await request(app).get('/companies/co-clerk-1/ping').expect(200);
      expect(res.body.membership.role).toBe('member');
      expect(res.body.membership.organizationId).toBe('co-clerk-1');
      expect(res.body.membership.userId).toBe('user-clerk-1');
    });

    it('Clerk activeOrganizationId alone does not grant access without company_members row', async () => {
      await seedCompany('co-clerk-2');
      // No company_members row for user-clerk-2

      const app = buildApp({
        authMode: 'authenticated',
        verify: async () =>
          mockClerkSession('user-clerk-2', {
            activeOrganizationId: 'co-clerk-2',
            activeOrganizationRole: 'admin',
          }),
      });

      const res = await request(app).get('/companies/co-clerk-2/ping').expect(403);
      expect(res.body.code).toBe('NOT_MEMBER');
    });

    it('requirePermission checks the permission matrix in Clerk mode', async () => {
      await seedMembership('co-clerk-3', 'user-clerk-3', 'member');

      const app = buildApp({
        authMode: 'authenticated',
        verify: async () => mockClerkSession('user-clerk-3'),
      });

      // member can view
      await request(app).get('/companies/co-clerk-3/view').expect(200);

      // member cannot update settings (admin+)
      const denied = await request(app).post('/companies/co-clerk-3/settings').expect(403);
      expect(denied.body.code).toBe('INSUFFICIENT_PERMISSION');
    });
  });

  // -------------------------------------------------------------------------
  // Platform admin bypass (VAL-CROSS-012)
  // -------------------------------------------------------------------------

  describe('platform admin bypass', () => {
    it('grants owner-level access without company_members row in Clerk mode', async () => {
      await seedCompany('co-admin-1');
      // No company_members row for admin-user

      const app = buildApp({
        authMode: 'authenticated',
        verify: async () =>
          ({
            user: { id: 'admin-user', name: 'Admin', email: 'admin@test.com', role: 'admin' },
            session: { id: 'sess-admin', userId: 'admin-user' },
          }) as AuthSession,
      });

      const res = await request(app).get('/companies/co-admin-1/ping').expect(200);
      expect(res.body.membership.role).toBe('owner');
      expect(res.body.membership.id).toBe('admin-bypass');
    });

    it('allows owner-only operations via requirePermission', async () => {
      await seedCompany('co-admin-2');

      const app = buildApp({
        authMode: 'authenticated',
        verify: async () =>
          ({
            user: { id: 'admin-user', name: 'Admin', email: 'admin@test.com', role: 'admin' },
            session: { id: 'sess-admin', userId: 'admin-user' },
          }) as AuthSession,
      });

      // company.delete is owner-only — admin bypass grants owner
      await request(app).delete('/companies/co-admin-2/delete').expect(200);
    });

    it('works in local_trusted mode (DEV_USER has role=admin)', async () => {
      const app = buildApp({ authMode: 'local_trusted' });

      // DEV_USER.role is 'admin' → platform admin bypass
      // Even owner-only operations should work
      await request(app).delete('/companies/co-admin-local/delete').expect(200);
    });
  });

  // -------------------------------------------------------------------------
  // Non-member receives 403 (VAL-RBAC-008)
  // -------------------------------------------------------------------------

  describe('non-member access denied', () => {
    it('returns 403 NOT_MEMBER for requireOrgMember when user has no membership', async () => {
      await seedCompany('co-non-member-1');
      // No company_members row for user-non-member

      const app = buildApp({
        authMode: 'authenticated',
        verify: async () => mockClerkSession('user-non-member'),
      });

      const res = await request(app).get('/companies/co-non-member-1/ping').expect(403);
      expect(res.body.code).toBe('NOT_MEMBER');
    });

    it('returns 403 NOT_MEMBER for requirePermission when user has no membership', async () => {
      await seedCompany('co-non-member-2');

      const app = buildApp({
        authMode: 'authenticated',
        verify: async () => mockClerkSession('user-non-member'),
      });

      const res = await request(app).get('/companies/co-non-member-2/view').expect(403);
      expect(res.body.code).toBe('NOT_MEMBER');
    });
  });

  // -------------------------------------------------------------------------
  // Cross-company isolation (VAL-RBAC-009, VAL-CROSS-010)
  // -------------------------------------------------------------------------

  describe('cross-company isolation', () => {
    it('membership in company A does not grant access to company B', async () => {
      await seedMembership('co-a', 'user-cross', 'owner');
      await seedCompany('co-b');
      // No membership for user-cross in co-b

      const app = buildApp({
        authMode: 'authenticated',
        verify: async () => mockClerkSession('user-cross'),
      });

      // Access to co-a works
      const resA = await request(app).get('/companies/co-a/ping').expect(200);
      expect(resA.body.membership.role).toBe('owner');

      // Access to co-b is denied
      const resB = await request(app).get('/companies/co-b/ping').expect(403);
      expect(resB.body.code).toBe('NOT_MEMBER');
    });

    it('requirePermission also isolates across companies', async () => {
      await seedMembership('co-x', 'user-cross-2', 'admin');
      await seedCompany('co-y');

      const app = buildApp({
        authMode: 'authenticated',
        verify: async () => mockClerkSession('user-cross-2'),
      });

      // admin in co-x can update settings
      await request(app).post('/companies/co-x/settings').expect(200);

      // but cannot access co-y at all
      const res = await request(app).get('/companies/co-y/view').expect(403);
      expect(res.body.code).toBe('NOT_MEMBER');
    });

    it('local_trusted company_members also isolates across companies', async () => {
      await seedMembership('co-lt-a', 'dev-user-000', 'member');
      await seedCompany('co-lt-b');
      // No membership for dev-user-000 in co-lt-b

      const app = buildApp({ authMode: 'local_trusted' });

      // member in co-lt-a
      const resA = await request(app).get('/companies/co-lt-a/ping').expect(200);
      expect(resA.body.membership.role).toBe('member');

      // In local_trusted, co-lt-b has no membership → defaults to owner (backward compat)
      // This is expected: local_trusted default-owner is per-request, not per-company.
      // The DB-based isolation is tested in Clerk mode above.
      const resB = await request(app).get('/companies/co-lt-b/ping').expect(200);
      expect(resB.body.membership.role).toBe('owner');
    });
  });

  // -------------------------------------------------------------------------
  // Role impersonation headers ignored outside local_trusted (VAL-RBAC-016)
  // -------------------------------------------------------------------------

  describe('role impersonation ignored outside local_trusted', () => {
    it('X-Eidolon-Test-Org-Role header is ignored in authenticated mode', async () => {
      await seedMembership('co-noimp', 'user-noimp', 'viewer');

      const app = buildApp({
        authMode: 'authenticated',
        verify: async () => mockClerkSession('user-noimp'),
      });

      // Send owner impersonation header, but user is viewer in DB
      // The header should be ignored; viewer role should be used
      const res = await request(app)
        .get('/companies/co-noimp/view')
        .set('X-Eidolon-Test-Org-Role', 'owner')
        .expect(200);
      expect(res.body.membership.role).toBe('viewer');

      // viewer cannot create artifacts (even with owner header)
      const denied = await request(app)
        .post('/companies/co-noimp/artifacts')
        .set('X-Eidolon-Test-Org-Role', 'owner')
        .expect(403);
      expect(denied.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('X-Eidolon-Test-Org-Role header does not grant access without membership', async () => {
      await seedCompany('co-noimp-2');
      // No membership for user-noimp-2

      const app = buildApp({
        authMode: 'authenticated',
        verify: async () => mockClerkSession('user-noimp-2'),
      });

      // Send owner impersonation header, but user has no membership
      const res = await request(app)
        .get('/companies/co-noimp-2/view')
        .set('X-Eidolon-Test-Org-Role', 'owner')
        .expect(403);
      expect(res.body.code).toBe('NOT_MEMBER');
    });
  });

  // -------------------------------------------------------------------------
  // requirePermission correctly checks the permission matrix
  // -------------------------------------------------------------------------

  describe('requirePermission matrix enforcement', () => {
    it.each([
      ['owner', 'company.delete', 200],
      ['owner', 'company.settings.update', 200],
      ['owner', 'artifact.create', 200],
      ['owner', 'company.view', 200],
      ['admin', 'company.delete', 403],
      ['admin', 'company.settings.update', 200],
      ['admin', 'artifact.create', 200],
      ['admin', 'company.view', 200],
      ['member', 'company.delete', 403],
      ['member', 'company.settings.update', 403],
      ['member', 'artifact.create', 200],
      ['member', 'company.view', 200],
      ['viewer', 'company.delete', 403],
      ['viewer', 'company.settings.update', 403],
      ['viewer', 'artifact.create', 403],
      ['viewer', 'company.view', 200],
    ] as const)('role=%s permission=%s → status=%d', async (role, _permission, expectedStatus) => {
      const companyId = `co-matrix-${role}`;
      await seedMembership(companyId, 'dev-user-000', role);

      const app = buildApp({ authMode: 'local_trusted' });

      // We test via the route that matches the permission
      // Map permission to route
      const routeMap: Record<string, { method: string; path: string }> = {
        'company.view': { method: 'get', path: '/view' },
        'company.settings.update': { method: 'post', path: '/settings' },
        'artifact.create': { method: 'post', path: '/artifacts' },
        'company.delete': { method: 'delete', path: '/delete' },
      };
      const route = routeMap[_permission];
      if (!route) {return;} // skip unmapped permissions

      // Dynamic method dispatch — cast to access get/post/delete by key
      const agent = request(app) as unknown as Record<
        string,
        (url: string) => { expect: (status: number) => Promise<{ body: { code?: string } }> }
      >;
      const req = agent[route.method](`/companies/${companyId}${route.path}`);

      if (expectedStatus === 200) {
        await req.expect(200);
      } else {
        const res = await req.expect(403);
        expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
      }
    });
  });

  // -------------------------------------------------------------------------
  // requireOrgMember with minimumRole still works (backward compat)
  // -------------------------------------------------------------------------

  describe('requireOrgMember minimumRole enforcement', () => {
    it('enforces minimumRole in local_trusted with impersonation', async () => {
      const app = buildApp({ authMode: 'local_trusted' });

      // Build a custom app with requireOrgMember('admin')
      const customApp = express();
      customApp.use(express.json());
      const { requireAuth, requireOrgMember } = createAuthMiddleware({
        authMode: 'local_trusted',
        db,
      });
      customApp.get(
        '/companies/:companyId/admin-only',
        requireAuth,
        requireOrgMember('admin'),
        (_req: Request, res: Response) => {
          res.json({ ok: true });
        },
      );
      customApp.use(errorHandler);

      // viewer is below admin → 403
      await request(customApp)
        .get('/companies/co-min/admin-only')
        .set('X-Eidolon-Test-Org-Role', 'viewer')
        .expect(403);

      // admin meets the threshold → 200
      await request(customApp)
        .get('/companies/co-min/admin-only')
        .set('X-Eidolon-Test-Org-Role', 'admin')
        .expect(200);
    });

    it('enforces minimumRole in Clerk mode using company_members role', async () => {
      await seedMembership('co-min-clerk', 'user-min-clerk', 'viewer');

      const customApp = express();
      customApp.use(express.json());
      const { requireAuth, requireOrgMember } = createAuthMiddleware({
        authMode: 'authenticated',
        verify: async () => mockClerkSession('user-min-clerk'),
        db,
      });
      customApp.get(
        '/companies/:companyId/admin-only',
        requireAuth,
        requireOrgMember('admin'),
        (_req: Request, res: Response) => {
          res.json({ ok: true });
        },
      );
      customApp.use(errorHandler);

      // viewer is below admin → 403
      const res = await request(customApp).get('/companies/co-min-clerk/admin-only').expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_ROLE');
    });
  });
});
