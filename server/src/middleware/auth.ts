import type { NextFunction, Request, Response } from 'express';
import { eq, and } from 'drizzle-orm';
import { AppError } from './error-handler.js';
import logger from '../utils/logger.js';
import type { AuthSession, AuthSessionData, AuthUser } from '../auth.js';
import { authenticateRequest } from '../auth.js';
import { hasPermission, type Permission, type Role } from './permissions.js';

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
    if (!token || !db) {
      return null;
    }
    try {
      const [row] = await db.drizzle
        .select()
        .from(db.schema.localTrustedSessions)
        .where(eq(db.schema.localTrustedSessions.id, token))
        .limit(1);
      if (!row) {
        return null;
      }
      if (row.companyId !== companyId) {
        return null;
      }
      if (!row.active) {
        return { role: '__revoked__', userId: row.userId };
      }
      return { role: row.role, userId: row.userId };
    } catch {
      return null;
    }
  }

  async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
    // If agent API key auth already set req.user, skip normal auth.
    // This allows agent keys to authenticate without a Clerk session.
    if (req.user) {
      return next();
    }

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
      if (err instanceof AppError) {
        return next(err);
      }
      logger.debug({ err }, 'Auth: session validation failed');
      next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
  }

  /**
   * Resolve the user's membership for a given company.
   *
   * This is the core membership-resolution logic shared by both
   * `requireOrgMember` and `requirePermission`. It replaces the previous
   * Clerk `activeOrganizationId` check with a `company_members` table
   * lookup.
   *
   * In **local_trusted** mode the resolution order is:
   *   1. `X-Eidolon-Test-Session-Id` → mutable `local_trusted_sessions` row
   *      (VAL-SEC-011 live session invalidation; highest priority)
   *   2. `X-Eidolon-Test-Org-Role` header → role impersonation (test-only)
   *   3. `company_members` lookup for the effective user id
   *   4. Default `owner` role (backward compatibility with existing tests)
   *
   * In **authenticated** (Clerk) mode the resolution is a single
   * `company_members` query by `(companyId, userId)`. Clerk's
   * `activeOrganizationId` is no longer consulted for authorization.
   *
   * Returns `{ role, userId, memberId }` on success, `null` when the user
   * is not a member. Throws `AppError` for revoked sessions (401).
   */
  async function resolveMembership(
    req: Request,
    companyId: string,
  ): Promise<{ role: string; userId: string; memberId: string } | null> {
    if (isLocalTrusted) {
      // 1. Session token (highest priority — server-side mutable)
      const sessionInfo = await resolveLocalTrustedSession(req, companyId);
      if (sessionInfo?.role === '__revoked__') {
        throw new AppError(
          401,
          'SESSION_REVOKED',
          'Your session is no longer valid for this company. Please re-authenticate.',
        );
      }

      // 2. User id resolution (session > header > dev user)
      const testUserId = req.get('X-Eidolon-Test-User-Id');
      const userId = sessionInfo?.userId ?? testUserId ?? DEV_USER.id;
      if (userId !== DEV_USER.id) {
        req.user = { ...DEV_USER, id: userId };
      }

      // 3. Role resolution
      let role: string;
      if (sessionInfo?.role) {
        // Session token role takes precedence
        role = sessionInfo.role;
      } else {
        const testRole = req.get('X-Eidolon-Test-Org-Role');
        const validRoles = ['owner', 'admin', 'member', 'viewer'];
        if (testRole && validRoles.includes(testRole)) {
          // Header impersonation
          role = testRole;
        } else if (db) {
          // Try company_members lookup for the effective user
          try {
            const [memberRow] = await db.drizzle
              .select()
              .from(db.schema.companyMembers)
              .where(
                and(
                  eq(db.schema.companyMembers.companyId, companyId),
                  eq(db.schema.companyMembers.userId, userId),
                ),
              )
              .limit(1);
            role = memberRow?.role ?? 'owner';
          } catch {
            role = 'owner';
          }
        } else {
          // No db → default owner (backward compat)
          role = 'owner';
        }
      }

      return { role, userId, memberId: 'dev-member-000' };
    }

    // Authenticated (Clerk) mode — query company_members
    if (!req.user || !db) {
      return null;
    }

    try {
      const [memberRow] = await db.drizzle
        .select()
        .from(db.schema.companyMembers)
        .where(
          and(
            eq(db.schema.companyMembers.companyId, companyId),
            eq(db.schema.companyMembers.userId, req.user.id),
          ),
        )
        .limit(1);

      if (!memberRow) {
        return null;
      }
      return {
        role: memberRow.role,
        userId: req.user.id,
        memberId: memberRow.id,
      };
    } catch {
      return null;
    }
  }

  /**
   * Platform admin bypass. Returns `true` and sets `req.organizationMembership`
   * to owner-level when `req.user.role === 'admin'`. Audit-logged.
   */
  function applyAdminBypass(req: Request, companyId: string): boolean {
    if (req.user?.role !== 'admin') {
      return false;
    }
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
    return true;
  }

  /**
   * Require the authenticated user to have access to the :companyId route
   * parameter. Membership is resolved from the `company_members` table
   * (Clerk `activeOrganizationId` is no longer used).
   *
   * Accepts these proofs of membership:
   *   1. AUTH_MODE=local_trusted (default owner-tier; see resolveMembership)
   *   2. user.role === 'admin' (platform admin bypass; audit-logged)
   *   3. company_members row for (companyId, userId)
   *
   * A `minimumRole` argument additionally requires the org role to clear a
   * hierarchy threshold (owner > admin > member > viewer).
   */
  function requireOrgMember(minimumRole?: 'owner' | 'admin' | 'member' | 'viewer') {
    return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
      const companyId = String(req.params.companyId ?? '');

      if (!companyId) {
        return next(new AppError(400, 'BAD_REQUEST', 'Company ID is required'));
      }

      if (!req.user) {
        return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
      }

      // If agent API key auth already set membership for a different
      // company, deny cross-company access immediately.
      if (req.organizationMembership && req.organizationMembership.organizationId !== companyId) {
        return next(new AppError(403, 'NOT_MEMBER', 'You are not a member of this company'));
      }

      // If agent API key auth already set membership for this company,
      // reuse it (avoids DB query and preserves the agent's role).
      if (req.organizationMembership && req.organizationMembership.organizationId === companyId) {
        if (minimumRole) {
          const userLevel = ROLE_HIERARCHY[req.organizationMembership.role] ?? 0;
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
        return next();
      }

      // Platform admin bypass (audit-logged). Only applies in authenticated
      // (Clerk) mode — in local_trusted, DEV_USER.role is 'admin' which
      // would always trigger the bypass and prevent header impersonation
      // and DB-based membership resolution. Local_trusted default owner
      // access is handled by resolveMembership instead.
      if (!isLocalTrusted && applyAdminBypass(req, companyId)) {
        return next();
      }

      try {
        const membership = await resolveMembership(req, companyId);
        if (!membership) {
          return next(new AppError(403, 'NOT_MEMBER', 'You are not a member of this company'));
        }

        // Enforce minimum role threshold
        if (minimumRole) {
          const userLevel = ROLE_HIERARCHY[membership.role] ?? 0;
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
          id: membership.memberId,
          role: membership.role,
          organizationId: companyId,
          userId: membership.userId,
        };
        next();
      } catch (err) {
        if (err instanceof AppError) {
          return next(err);
        }
        next(new AppError(403, 'NOT_MEMBER', 'You are not a member of this company'));
      }
    };
  }

  /**
   * Require the authenticated user to hold a specific permission for the
   * :companyId route parameter. This is the formal RBAC middleware that
   * replaces `requireOrgMember(minimumRole)` for migrated routes.
   *
   * Flow:
   *   1. Check req.user exists (else 401)
   *   2. Platform admin bypass: req.user.role === 'admin' → grant owner
   *   3. If req.organizationMembership already set by a preceding middleware,
   *      reuse it (avoids duplicate DB query)
   *   4. Resolve membership from company_members (or local_trusted logic)
   *   5. No membership → 403 NOT_MEMBER
   *   6. Check hasPermission(membership.role, permission)
   *   7. Insufficient → 403 INSUFFICIENT_PERMISSION
   *   8. Set req.organizationMembership and proceed
   */
  function requirePermission(permission: Permission) {
    return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
      const companyId = String(req.params.companyId ?? '');

      if (!companyId) {
        return next(new AppError(400, 'BAD_REQUEST', 'Company ID is required'));
      }

      if (!req.user) {
        return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
      }

      // Platform admin bypass (audit-logged). Only applies in authenticated
      // (Clerk) mode — see requireOrgMember for rationale.
      if (!isLocalTrusted && applyAdminBypass(req, companyId)) {
        return next();
      }

      // If agent API key auth already set membership for a different
      // company, deny cross-company access immediately.
      if (req.organizationMembership && req.organizationMembership.organizationId !== companyId) {
        return next(new AppError(403, 'NOT_MEMBER', 'You are not a member of this company'));
      }

      // If a preceding middleware (e.g. requireOrgMember) already resolved
      // membership for this company, reuse it to avoid a duplicate query.
      if (req.organizationMembership && req.organizationMembership.organizationId === companyId) {
        const role = req.organizationMembership.role as Role;
        if (!hasPermission(role, permission)) {
          return next(
            new AppError(
              403,
              'INSUFFICIENT_PERMISSION',
              `This action requires '${permission}' permission`,
            ),
          );
        }
        return next();
      }

      try {
        const membership = await resolveMembership(req, companyId);
        if (!membership) {
          return next(new AppError(403, 'NOT_MEMBER', 'You are not a member of this company'));
        }

        const role = membership.role as Role;
        if (!hasPermission(role, permission)) {
          return next(
            new AppError(
              403,
              'INSUFFICIENT_PERMISSION',
              `This action requires '${permission}' permission`,
            ),
          );
        }

        req.organizationMembership = {
          id: membership.memberId,
          role: membership.role,
          organizationId: companyId,
          userId: membership.userId,
        };
        next();
      } catch (err) {
        if (err instanceof AppError) {
          return next(err);
        }
        next(new AppError(403, 'NOT_MEMBER', 'You are not a member of this company'));
      }
    };
  }

  /**
   * Method-aware permission middleware for routers that handle both reads
   * and writes behind a single mount. GET/HEAD/OPTIONS requests are checked
   * against the `read` permission; all other methods (POST/PATCH/PUT/DELETE)
   * are checked against the `write` permission.
   *
   * This enables a single router mount to enforce different permissions for
   * reads vs writes without splitting the mount. For example:
   *
   *   requirePermissionByMethod({ read: 'company.view', write: 'artifact.create' })
   *
   * - GET /artifacts     → company.view    (all roles including viewer)
   * - POST /artifacts    → artifact.create  (owner+admin+member, NOT viewer)
   *
   * When a preceding middleware has already resolved membership for the same
   * company, the inner `requirePermission` calls reuse `req.organizationMembership`
   * and skip a duplicate DB query.
   */
  function requirePermissionByMethod(perms: { read: Permission; write: Permission }) {
    const readMiddleware = requirePermission(perms.read);
    const writeMiddleware = requirePermission(perms.write);
    return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
      const method = req.method.toUpperCase();
      const isRead = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
      if (isRead) {
        return readMiddleware(req, _res, next);
      }
      return writeMiddleware(req, _res, next);
    };
  }

  return { requireAuth, requireOrgMember, requirePermission, requirePermissionByMethod };
}
