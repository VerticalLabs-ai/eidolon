import type { NextFunction, Request, Response } from 'express';
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
}

export function createAuthMiddleware(deps: AuthMiddlewareDeps = {}) {
  const isLocalTrusted = (deps.authMode ?? process.env.AUTH_MODE) === 'local_trusted';
  const verify = deps.verify ?? ((req: Request) => authenticateRequest(req));

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
    return (req: Request, _res: Response, next: NextFunction): void => {
      const companyId = String(req.params.companyId ?? '');

      if (isLocalTrusted) {
        req.organizationMembership = {
          id: 'dev-member-000',
          role: 'owner',
          organizationId: companyId,
          userId: DEV_USER.id,
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
