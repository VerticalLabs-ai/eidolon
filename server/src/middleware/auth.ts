import type { NextFunction, Request, Response } from 'express';
import type { Auth } from '../auth.js';
import { AppError } from './error-handler.js';
import logger from '../utils/logger.js';

// Extend Express Request to carry user/session info
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        name: string;
        email: string;
        role?: string;
      };
      session?: {
        id: string;
        userId: string;
        activeOrganizationId?: string | null;
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
  activeOrganizationId: null,
};

/**
 * Creates auth middleware using the provided BetterAuth instance.
 */
export function createAuthMiddleware(auth: Auth) {
  const isLocalTrusted = process.env.AUTH_MODE === 'local_trusted';

  /**
   * Validates the session and attaches user info to the request.
   * In local_trusted mode, injects a dev user without validation.
   */
  async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (isLocalTrusted) {
      req.user = DEV_USER;
      req.session = DEV_SESSION;
      return next();
    }

    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value) headers.set(key, Array.isArray(value) ? value[0] : value);
      }
      const session = await auth.api.getSession({ headers });

      if (!session?.user) {
        throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
      }

      req.user = {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
        role: (session.user as any).role,
      };
      req.session = {
        id: session.session.id,
        userId: session.session.userId,
        activeOrganizationId: (session.session as any).activeOrganizationId,
      };

      next();
    } catch (err) {
      if (err instanceof AppError) return next(err);
      logger.debug({ err }, 'Auth: session validation failed');
      next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
  }

  /**
   * Validates that the authenticated user is a member of the organization
   * specified by :companyId in the route params.
   *
   * Optionally requires a minimum role level.
   * Role hierarchy: owner > admin > member > viewer
   */
  function requireOrgMember(minimumRole?: 'owner' | 'admin' | 'member' | 'viewer') {
    const roleHierarchy: Record<string, number> = {
      owner: 4,
      admin: 3,
      member: 2,
      viewer: 1,
    };

    return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
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

      try {
        // Check if user is a global admin (bypass org check)
        if (req.user.role === 'admin') {
          req.organizationMembership = {
            id: 'admin-bypass',
            role: 'owner',
            organizationId: companyId,
            userId: req.user.id,
          };
          return next();
        }

        // Use BetterAuth to check organization membership
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value) headers.set(key, Array.isArray(value) ? value[0] : value);
        }
        const membership = await auth.api.getFullOrganization({
          headers,
          query: { organizationId: companyId },
        });

        if (!membership) {
          throw new AppError(403, 'FORBIDDEN', 'You are not a member of this organization');
        }

        const userMember = membership.members?.find(
          (m: any) => m.userId === req.user!.id,
        );

        if (!userMember) {
          throw new AppError(403, 'FORBIDDEN', 'You are not a member of this organization');
        }

        // Check minimum role if specified
        if (minimumRole) {
          const userLevel = roleHierarchy[userMember.role] ?? 0;
          const requiredLevel = roleHierarchy[minimumRole] ?? 0;
          if (userLevel < requiredLevel) {
            throw new AppError(
              403,
              'INSUFFICIENT_ROLE',
              `This action requires at least '${minimumRole}' role`,
            );
          }
        }

        req.organizationMembership = {
          id: userMember.id,
          role: userMember.role,
          organizationId: companyId,
          userId: req.user.id,
        };

        next();
      } catch (err) {
        if (err instanceof AppError) return next(err);
        logger.debug({ err, companyId }, 'Auth: org membership check failed');
        next(new AppError(403, 'FORBIDDEN', 'You are not a member of this organization'));
      }
    };
  }

  return { requireAuth, requireOrgMember };
}
