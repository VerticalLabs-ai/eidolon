import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { createAuthMiddleware } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import logger from '../utils/logger.js';
import type { AuthSession } from '../auth.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock DB that returns the given rows for any company_members
 * query. The drizzle query chain (select().from().where().limit()) is
 * stubbed to return the pre-set rows. Each test controls the rows so the
 * first element is the membership that resolveMembership destructures.
 */
function createMockDb(
  rows: Array<{ id: string; companyId: string; userId: string; role: string }>,
) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return {
    drizzle: { select: () => chain },
    schema: {
      companyMembers: { companyId: 'company_id', userId: 'user_id' },
      localTrustedSessions: { id: 'id' },
    },
  };
}

function buildTestApp(
  verify: (req: Request) => Promise<AuthSession | null>,
  opts: {
    authMode?: 'local_trusted' | 'authenticated';
    requireRole?: 'owner' | 'admin' | 'member' | 'viewer';
    db?: ReturnType<typeof createMockDb>;
  } = {},
) {
  const app = express();
  const { requireAuth, requireOrgMember } = createAuthMiddleware({
    verify,
    authMode: opts.authMode ?? 'authenticated',
    db: opts.db,
  });

  app.get('/me', requireAuth, (req: Request, res: Response) => {
    res.json({ user: req.user ?? null });
  });

  app.get(
    '/companies/:companyId/ping',
    requireAuth,
    requireOrgMember(opts.requireRole),
    (req: Request, res: Response) => {
      res.json({ membership: req.organizationMembership ?? null });
    },
  );

  app.use(errorHandler);
  return app;
}

const mockUser = (overrides: Partial<AuthSession['user']> = {}) => ({
  id: 'user-1',
  name: 'Ada',
  email: 'ada@example.com',
  role: undefined,
  ...overrides,
});

const mockSession = (overrides: Partial<AuthSession['session']> = {}) => ({
  id: 'sess-1',
  userId: 'user-1',
  activeOrganizationId: null,
  activeOrganizationRole: null,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auth middleware', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // requireAuth
  // -------------------------------------------------------------------------

  describe('requireAuth', () => {
    it('injects the dev user when AUTH_MODE=local_trusted', async () => {
      const app = buildTestApp(async () => null, { authMode: 'local_trusted' });

      const res = await request(app).get('/me').expect(200);
      expect(res.body.user.id).toBe('dev-user-000');
      expect(res.body.user.role).toBe('admin');
    });

    it('returns 401 when the verifier returns null (authenticated mode)', async () => {
      const app = buildTestApp(async () => null);

      const res = await request(app).get('/me').expect(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('attaches the user when verifier returns a session', async () => {
      const app = buildTestApp(async () => ({
        user: mockUser(),
        session: mockSession(),
      }));

      const res = await request(app).get('/me').expect(200);
      expect(res.body.user.id).toBe('user-1');
      expect(res.body.user.email).toBe('ada@example.com');
    });

    it('returns 401 when the verifier throws', async () => {
      const app = buildTestApp(async () => {
        throw new Error('boom');
      });

      const res = await request(app).get('/me').expect(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });
  });

  // -------------------------------------------------------------------------
  // requireOrgMember
  // -------------------------------------------------------------------------

  describe('requireOrgMember', () => {
    it('grants owner-tier membership in local_trusted mode without calling the verifier', async () => {
      const verify = vi.fn(async () => null);
      const app = buildTestApp(verify, { authMode: 'local_trusted' });

      const res = await request(app).get('/companies/co-42/ping').expect(200);
      expect(res.body.membership.role).toBe('owner');
      expect(res.body.membership.organizationId).toBe('co-42');
      // requireAuth also runs, but local_trusted short-circuits before verify.
      expect(verify).not.toHaveBeenCalled();
    });

    it('returns 403 NOT_MEMBER when the user has no company_members row', async () => {
      const app = buildTestApp(
        async () => ({
          user: mockUser({ role: 'user' }),
          session: mockSession({ activeOrganizationId: null }),
        }),
        {
          db: createMockDb([]), // no membership rows
        },
      );

      const res = await request(app).get('/companies/co-1/ping').expect(403);
      expect(res.body.code).toBe('NOT_MEMBER');
    });

    it('returns 403 NOT_MEMBER when the user has a Clerk org membership but no company_members row', async () => {
      // Clerk activeOrganizationId is no longer used for membership resolution.
      // A Clerk org membership alone (without a company_members row) grants no access.
      const app = buildTestApp(
        async () => ({
          user: mockUser({ role: 'user' }),
          session: mockSession({
            activeOrganizationId: 'co-OTHER',
            activeOrganizationRole: 'member',
          }),
        }),
        {
          db: createMockDb([]), // no company_members rows
        },
      );

      const res = await request(app).get('/companies/co-1/ping').expect(403);
      expect(res.body.code).toBe('NOT_MEMBER');
    });

    it('allows members with sufficient role from company_members', async () => {
      const app = buildTestApp(
        async () => ({
          user: mockUser({ role: 'user' }),
          session: mockSession({
            activeOrganizationId: null, // Clerk org id irrelevant now
            activeOrganizationRole: null,
          }),
        }),
        {
          requireRole: 'member',
          db: createMockDb([{ id: 'm1', companyId: 'co-1', userId: 'user-1', role: 'member' }]),
        },
      );

      const res = await request(app).get('/companies/co-1/ping').expect(200);
      expect(res.body.membership.role).toBe('member');
      expect(res.body.membership.organizationId).toBe('co-1');
    });

    it('rejects members whose role is below the required level', async () => {
      const app = buildTestApp(
        async () => ({
          user: mockUser({ role: 'user' }),
          session: mockSession({
            activeOrganizationId: null,
            activeOrganizationRole: null,
          }),
        }),
        {
          requireRole: 'admin',
          db: createMockDb([{ id: 'm1', companyId: 'co-1', userId: 'user-1', role: 'viewer' }]),
        },
      );

      const res = await request(app).get('/companies/co-1/ping').expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_ROLE');
    });
  });

  // -------------------------------------------------------------------------
  // Admin bypass
  // -------------------------------------------------------------------------

  describe('admin bypass', () => {
    it('grants owner access to any organization AND writes an audit log', async () => {
      const logSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
      const app = buildTestApp(async () => ({
        user: mockUser({ id: 'admin-user', name: 'Root', email: 'root@x.co', role: 'admin' }),
        session: mockSession({ id: 'sess-admin', userId: 'admin-user' }),
      }));

      const res = await request(app).get('/companies/co-other/ping').expect(200);

      expect(res.body.membership.role).toBe('owner');
      expect(res.body.membership.id).toBe('admin-bypass');

      const auditCall = logSpy.mock.calls.find(
        (call) => (call[0] as any)?.action === 'admin_bypass_owner_access',
      );
      expect(auditCall).toBeDefined();
      const payload = auditCall![0] as Record<string, unknown>;
      expect(payload.actingUserId).toBe('admin-user');
      expect(payload.targetOrganizationId).toBe('co-other');
      expect(typeof payload.timestamp).toBe('string');
    });
  });
});
