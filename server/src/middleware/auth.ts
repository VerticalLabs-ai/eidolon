import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { AppError } from './error-handler.js';
import logger from '../utils/logger.js';
import type { AuthSession, AuthSessionData, AuthUser } from '../auth.js';
import { authenticateRequest } from '../auth.js';

// Extend Express Request to carry user/session info
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: AuthUser['id'];
        name: AuthUser['name'];
        email: AuthUser['email'];
        role?: AuthUser['role'];
      };
      session?: {
        id: AuthSessionData['id'];
        userId: AuthSessionData['userId'];
        activeOrganizationId?: AuthSessionData['activeOrganizationId'];
        activeOrganizationRole?: AuthSessionData['activeOrganizationRole'];
      };
      organizationMembership?: {
        id: string;
        role: string;
        organizationId: string;
        userId: string;
      };
    }
  }
}

/**
 * AUTH_MODE=local_trusted bypasses all auth checks and injects a dev user.
 * Only safe for local development bound to 127.0.0.1.
 */
const DEV_USER = {
  id: 'dev-user-000',
  name: 'Dev User',
  email: 'dev@localhost',
  role: 'admin',
};

const DEV_SESSION = {
  id: 'dev-session-000',
  userId: 'dev-user-000',
  activeOrganizationId: null as string | null,
  activeOrganizationRole: null as string | null,
};

const ROLE_HIERARCHY: Record<string, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
};

// ---------------------------------------------------------------------------
// Middleware factory (kept as a factory so tests can swap the verifier).
// ---------------------------------------------------------------------------

export interface AuthMiddlewareDeps {
  /** Verifier that returns an AuthSession or null. Defaults to the real
   *  Clerk-backed implementation. Overridden in tests. */
  verify?: (req: Request) => Promise<AuthSession | null>;
  /** Auth mode override for isolated tests. Production reads AUTH_MODE. */
  authMode?: 'local_trusted' | 'authenticated';
  /** DB instance used to resolve `X-Eidolon-Test-Session-Id` session tokens
   *  in `local_trusted` mode (VAL-SEC-011 session invalidation on role
   *  downgrade / company removal). Optional; when absent, session tokens are
   *  ignored and the header-based role impersonation is used. */
  db?: any;
}

export function createAuthMiddleware(deps: AuthMiddlewareDeps = {}) {
  const isLocalTrusted = (deps.authMode ?? process.env.AUTH_MODE) === 'local_trusted';
  const verify = deps.verify ?? ((req: Request) => authenticateRequest(req));
  const db = deps.db;

  /**
   * Resolve a `local_trusted` session token (`X-Eidolon-Test-Session-Id`) to
   * a mutable org role + active flag. Returns null when no token is present
   * or no db is configured. This lets a server-side role downgrade or
   * company-removal take effect on the member's NEXT request with the same
   * session token (VAL-SEC-011) — without it, the role would be caller-
   * controlled via the header and could not model live invalidation.
   */
  async function resolveLocalTrustedSession(
    req: Request,
    companyId: string,
  ): Promise<{ role: string; userId: string } | null> {
    const token = req.get('X-Eidolon-Test-Session-Id');
    if (!token || !db) return null;
    try {
      const [row] = await db.drizzle
        .select()
        .from(db.schema.localTrustedSessions)
        .where(eq(db.schema.localTrustedSessions.id, token))
        .limit(1);
      if (!row) return null;
      if (row.companyId !== companyId) return null;
      if (!row.active) return { role: '__revoked__', userId: row.userId };
      return { role: row.role, userId: row.userId };
    } catch {
      return null;
    }
  }

  async function requireAuth(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (isLocalTrusted) {
      req.user = DEV_USER;
      req.session = DEV_SESSION;
      return next();
    }

    try {
      const session = await verify(req);
      if (!session?.user) {
        throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
      }
      req.user = {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
        role: session.user.role,
      };
      req.session = {
        id: session.session.id,
        userId: session.session.userId,
        activeOrganizationId: session.session.activeOrganizationId,
        activeOrganizationRole: session.session.activeOrganizationRole,
      };
      next();
    } catch (err) {
      if (err instanceof AppError) return next(err);
      logger.debug({ err }, 'Auth: session validation failed');
      next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
  }

  /**
   * Require the authenticated user to have access to the :companyId route
   * parameter. Accepts any of these proofs of membership:
   *
   *   1. AUTH_MODE=local_trusted (grants owner-tier implicitly)
   *   2. user.role === 'admin' (platform admin bypass; audit-logged)
   *   3. session.activeOrganizationId === companyId (Clerk organization
   *      membership, which is how multi-tenant access is granted today)
   *
   * A `minimumRole` argument additionally requires the org role to clear a
   * hierarchy threshold (owner > admin > member > viewer).
   */
  function requireOrgMember(
    minimumRole?: 'owner' | 'admin' | 'member' | 'viewer',
  ) {
    return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
      const companyId = String(req.params.companyId ?? '');

      if (isLocalTrusted) {
        // VAL-SEC-011: when a `X-Eidolon-Test-Session-Id` token is present,
        // resolve the org role from the mutable `local_trusted_sessions`
        // row. A server-side downgrade or removal updates that row, so the
        // SAME session token yields the downgraded role (or 401 when
        // deactivated) on the next request — modeling live session
        // invalidation on privilege loss. This takes precedence over the
        // caller-controlled `X-Eidolon-Test-Org-Role` header.
        const sessionInfo = await resolveLocalTrustedSession(req, companyId);
        if (sessionInfo?.role === '__revoked__') {
          return next(
            new AppError(401, 'SESSION_REVOKED', 'Your session is no longer valid for this company. Please re-authenticate.'),
          );
        }

        // Support test impersonation of different org roles + user ids via
        // headers. This lets integration tests and validators exercise RBAC
        // (viewer/member/admin/owner) and per-user permissions without a
        // real Clerk session. Only honored in local_trusted mode. A session
        // token overrides the header role.
        const testRole = req.get('X-Eidolon-Test-Org-Role');
        const testUserId = req.get('X-Eidolon-Test-User-Id');
        const validRoles = ['owner', 'admin', 'member', 'viewer'];
        const headerRole = testRole && validRoles.includes(testRole) ? testRole : 'owner';
        const role = sessionInfo?.role ?? headerRole;
        const userId = sessionInfo?.userId ?? testUserId ?? DEV_USER.id;
        if (userId !== DEV_USER.id) {
          req.user = { ...DEV_USER, id: userId };
        }
        // Enforce minimum role for local_trusted with impersonation.
        if (minimumRole) {
          const userLevel = ROLE_HIERARCHY[role] ?? 0;
          const requiredLevel = ROLE_HIERARCHY[minimumRole] ?? 0;
          if (userLevel < requiredLevel) {
            return next(
              new AppError(403, 'INSUFFICIENT_ROLE', `This action requires at least '${minimumRole}' role`),
            );
          }
        }
        req.organizationMembership = {
          id: 'dev-member-000',
          role,
          organizationId: companyId,
          userId,
        };
        return next();
      }

      if (!companyId) {
        return next(new AppError(400, 'BAD_REQUEST', 'Company ID is required'));
      }

      if (!req.user) {
        return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
      }

      // Admin bypass (audit-logged).
      if (req.user.role === 'admin') {
        logger.info(
          {
            action: 'admin_bypass_owner_access',
            actingUserId: req.user.id,
            targetOrganizationId: companyId,
            timestamp: new Date().toISOString(),
          },
          'Admin bypass granted owner-level organization access',
        );
        req.organizationMembership = {
          id: 'admin-bypass',
          role: 'owner',
          organizationId: companyId,
          userId: req.user.id,
        };
        return next();
      }

      const activeOrgId = req.session?.activeOrganizationId ?? null;
      const activeOrgRole = req.session?.activeOrganizationRole ?? 'member';

      if (activeOrgId !== companyId) {
        return next(
          new AppError(403, 'FORBIDDEN', 'You are not a member of this organization'),
        );
      }

      if (minimumRole) {
        const userLevel = ROLE_HIERARCHY[activeOrgRole] ?? 0;
        const requiredLevel = ROLE_HIERARCHY[minimumRole] ?? 0;
        if (userLevel < requiredLevel) {
          return next(
            new AppError(
              403,
              'INSUFFICIENT_ROLE',
              `This action requires at least '${minimumRole}' role`,
            ),
          );
        }
      }

      req.organizationMembership = {
        id: `clerk:${req.user.id}:${companyId}`,
        role: activeOrgRole,
        organizationId: companyId,
        userId: req.user.id,
      };

      next();
    };
  }

  return { requireAuth, requireOrgMember };
}
