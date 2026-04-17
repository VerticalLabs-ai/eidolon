import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { createAuthMiddleware } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import logger from '../utils/logger.js';
import type { Auth } from '../auth.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMockAuth(overrides: {
  getSession?: (args: { headers: Headers }) => Promise<any>;
  listMembers?: (args: { headers: Headers; query: any }) => Promise<any>;
}): Auth {
  const getSession = overrides.getSession ?? (async () => null);
  const listMembers =
    overrides.listMembers ?? (async () => ({ members: [], total: 0 }));
  return {
    api: { getSession, listMembers },
  } as unknown as Auth;
}

function buildTestApp(
  auth: Auth,
  opts: { requireRole?: 'owner' | 'admin' | 'member' | 'viewer' } = {},
) {
  const app = express();
  const { requireAuth, requireOrgMember } = createAuthMiddleware(auth);

  app.get('/me', requireAuth, (req: Request, res: Response) => {
    res.json({ user: req.user ?? null });
  });

  app.get(
    '/companies/:companyId/ping',
    requireAuth,
    requireOrgMember(opts.requireRole),
    (req: Request, res: Response) => {
      res.json({
        membership: req.organizationMembership ?? null,
      });
    },
  );

  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auth middleware', () => {
  const originalAuthMode = process.env.AUTH_MODE;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalAuthMode === undefined) {
      delete process.env.AUTH_MODE;
    } else {
      process.env.AUTH_MODE = originalAuthMode;
    }
  });

  // -------------------------------------------------------------------------
  // requireAuth
  // -------------------------------------------------------------------------

  describe('requireAuth', () => {
    it('injects the dev user when AUTH_MODE=local_trusted', async () => {
      process.env.AUTH_MODE = 'local_trusted';
      const auth = buildMockAuth({});
      const app = buildTestApp(auth);

      const res = await request(app).get('/me').expect(200);
      expect(res.body.user.id).toBe('dev-user-000');
      expect(res.body.user.role).toBe('admin');
    });

    it('returns 401 when no session cookie is present (authenticated mode)', async () => {
      process.env.AUTH_MODE = 'authenticated';
      const auth = buildMockAuth({
        getSession: async () => null,
      });
      const app = buildTestApp(auth);

      const res = await request(app).get('/me').expect(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('attaches the user when a valid session is returned', async () => {
      process.env.AUTH_MODE = 'authenticated';
      const auth = buildMockAuth({
        getSession: async () =>
          ({
            user: {
              id: 'user-1',
              name: 'Ada',
              email: 'ada@example.com',
              role: 'user',
            },
            session: {
              id: 'sess-1',
              userId: 'user-1',
              activeOrganizationId: null,
            },
          }) as any,
      });
      const app = buildTestApp(auth);

      const res = await request(app).get('/me').expect(200);
      expect(res.body.user.id).toBe('user-1');
      expect(res.body.user.email).toBe('ada@example.com');
    });

    it('returns 401 when getSession throws unexpectedly', async () => {
      process.env.AUTH_MODE = 'authenticated';
      const auth = buildMockAuth({
        getSession: async () => {
          throw new Error('boom');
        },
      });
      const app = buildTestApp(auth);

      const res = await request(app).get('/me').expect(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });
  });

  // -------------------------------------------------------------------------
  // requireOrgMember
  // -------------------------------------------------------------------------

  describe('requireOrgMember', () => {
    it('grants owner-tier membership in local_trusted mode without any DB lookup', async () => {
      process.env.AUTH_MODE = 'local_trusted';
      const listMembers = vi.fn();
      const auth = buildMockAuth({ listMembers });
      const app = buildTestApp(auth);

      const res = await request(app)
        .get('/companies/co-42/ping')
        .expect(200);

      expect(res.body.membership.role).toBe('owner');
      expect(res.body.membership.organizationId).toBe('co-42');
      expect(listMembers).not.toHaveBeenCalled();
    });

    it('returns 403 when the user is not a member of the organization', async () => {
      process.env.AUTH_MODE = 'authenticated';
      const auth = buildMockAuth({
        getSession: async () =>
          ({
            user: { id: 'user-1', name: 'Ada', email: 'ada@x.co', role: 'user' },
            session: { id: 's', userId: 'user-1', activeOrganizationId: null },
          }) as any,
        listMembers: async () => ({ members: [], total: 0 }),
      });
      const app = buildTestApp(auth);

      const res = await request(app).get('/companies/co-1/ping').expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('allows members with a sufficient role', async () => {
      process.env.AUTH_MODE = 'authenticated';
      const auth = buildMockAuth({
        getSession: async () =>
          ({
            user: { id: 'user-1', name: 'Ada', email: 'ada@x.co', role: 'user' },
            session: { id: 's', userId: 'user-1', activeOrganizationId: null },
          }) as any,
        listMembers: async () => ({
          members: [
            {
              id: 'mem-1',
              organizationId: 'co-1',
              role: 'member',
              userId: 'user-1',
              user: { id: 'user-1', name: 'Ada', email: 'ada@x.co' },
            },
          ],
          total: 1,
        }),
      });
      const app = buildTestApp(auth, { requireRole: 'member' });

      const res = await request(app).get('/companies/co-1/ping').expect(200);
      expect(res.body.membership.role).toBe('member');
    });

    it('rejects members whose role is below the required level', async () => {
      process.env.AUTH_MODE = 'authenticated';
      const auth = buildMockAuth({
        getSession: async () =>
          ({
            user: { id: 'user-1', name: 'Viewer', email: 'v@x.co', role: 'user' },
            session: { id: 's', userId: 'user-1', activeOrganizationId: null },
          }) as any,
        listMembers: async () => ({
          members: [
            {
              id: 'mem-v',
              organizationId: 'co-1',
              role: 'viewer',
              userId: 'user-1',
              user: { id: 'user-1', name: 'V', email: 'v@x.co' },
            },
          ],
          total: 1,
        }),
      });
      const app = buildTestApp(auth, { requireRole: 'admin' });

      const res = await request(app).get('/companies/co-1/ping').expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_ROLE');
    });
  });

  // -------------------------------------------------------------------------
  // Admin bypass
  // -------------------------------------------------------------------------

  describe('admin bypass', () => {
    it('grants owner access to any organization AND writes an audit log', async () => {
      process.env.AUTH_MODE = 'authenticated';
      const logSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
      const listMembers = vi.fn();
      const auth = buildMockAuth({
        getSession: async () =>
          ({
            user: {
              id: 'admin-user',
              name: 'Root',
              email: 'root@x.co',
              role: 'admin',
            },
            session: { id: 's', userId: 'admin-user', activeOrganizationId: null },
          }) as any,
        listMembers,
      });
      const app = buildTestApp(auth);

      const res = await request(app)
        .get('/companies/co-other/ping')
        .expect(200);

      expect(res.body.membership.role).toBe('owner');
      expect(res.body.membership.id).toBe('admin-bypass');
      expect(listMembers).not.toHaveBeenCalled();

      // Audit-log emission: one pino.info call tagged 'admin_bypass_owner_access'
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
