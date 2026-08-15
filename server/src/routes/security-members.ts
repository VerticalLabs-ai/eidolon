import { Router } from 'express';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import { revokeUserStepUps } from '../services/stepup-service.js';
import { routeParams } from '../utils/route-params.js';
import type { DbInstance } from '../types.js';

// ---------------------------------------------------------------------------
// Company member role management (M8 enterprise security — VAL-SEC-011)
// ---------------------------------------------------------------------------
//
// These routes model privilege-affecting operations on a company member:
// downgrading their org role or removing them from the company. In
// `local_trusted` mode, where the org role is carried by a mutable
// `local_trusted_sessions` row, the change takes effect on the member's
// NEXT request with the same session token — i.e. their existing session
// can no longer perform now-disallowed operations without re-authentication.
//
// In Clerk mode, org role changes are applied through Clerk and Clerk's
// session token refresh propagates the change; these routes are the
// local_trusted validation surface and audit the privilege change either way.
//
// The role-change router is mounted with `member.promote` (owner only).
// The removal router is mounted with `member.remove` (admin+owner).
// Both routers also write an audit-log entry and update `company_members`
// so the change is reflected in the RBAC membership table.
// ---------------------------------------------------------------------------

const UpdateRoleBody = z.object({
  role: z.enum(['owner', 'admin', 'member', 'viewer']),
});

const ROLE_HIERARCHY: Record<string, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
};

function requireAdminOrOwner(req: any): void {
  const role = req.organizationMembership?.role ?? 'member';
  if (role !== 'admin' && role !== 'owner') {
    throw new AppError(403, 'INSUFFICIENT_ROLE', 'This action requires admin or owner role');
  }
}

function requireOwner(req: any): void {
  const role = req.organizationMembership?.role ?? 'member';
  if (role !== 'owner') {
    throw new AppError(403, 'INSUFFICIENT_ROLE', 'This action requires owner role');
  }
}

/**
 * Router for member role changes (promote/demote).
 * Mounted at `/members/:userId/role` with `requirePermission('member.promote')` — owner only.
 *
 * POST /api/companies/:companyId/members/:userId/role
 */
export function securityMemberRoleRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const isLocalTrusted = process.env.AUTH_MODE === 'local_trusted';

  // POST / (mounted at /members/:userId/role)
  // Change a member's org role (downgrade or upgrade). In local_trusted mode
  // this updates the member's local_trusted_sessions row, so their existing
  // session token immediately reflects the new role. A downgrade revokes any
  // step-up sessions the member held. Also updates `company_members` so the
  // RBAC membership table reflects the new role.
  router.post('/', validate(UpdateRoleBody), async (req, res) => {
    requireOwner(req);
    const { companyId, userId: targetUserId } = routeParams(req);
    const body = (req as any).validated.body;
    const actingUserId = req.organizationMembership?.userId ?? req.user?.id ?? 'dev-user-000';

    if (isLocalTrusted) {
      const { localTrustedSessions } = db.schema;
      const [existing] = await db.drizzle
        .select()
        .from(localTrustedSessions)
        .where(
          and(
            eq(localTrustedSessions.companyId, companyId),
            eq(localTrustedSessions.userId, targetUserId),
          ),
        )
        .limit(1);

      if (existing) {
        const isDowngrade = ROLE_HIERARCHY[body.role] < ROLE_HIERARCHY[existing.role];

        await db.drizzle
          .update(localTrustedSessions)
          .set({ role: body.role, updatedAt: new Date() })
          .where(eq(localTrustedSessions.id, existing.id));

        // A privilege downgrade revokes the member's step-up sessions so they
        // cannot reuse a prior re-auth for sensitive operations.
        if (isDowngrade) {
          await revokeUserStepUps(db, targetUserId);
        }
      }
    }

    // Update company_members so the RBAC table reflects the new role.
    const { companyMembers } = db.schema;
    const [memberRow] = await db.drizzle
      .select()
      .from(companyMembers)
      .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, targetUserId)))
      .limit(1);

    if (memberRow) {
      await db.drizzle
        .update(companyMembers)
        .set({ role: body.role, updatedAt: new Date() })
        .where(eq(companyMembers.id, memberRow.id));
    }

    // Audit: privilege change is security-relevant (VAL-SEC-007/011).
    await db.drizzle.insert(db.schema.activityLog).values({
      companyId,
      actorType: 'user',
      actorId: actingUserId,
      action: 'member.role_changed',
      entityType: 'company_member',
      entityId: targetUserId,
      description: `Changed member role to ${body.role}`,
      metadata: { targetUserId, newRole: body.role },
      createdAt: new Date(),
    });

    res.json({
      data: { companyId, userId: targetUserId, role: body.role },
    });
  });

  return router;
}

/**
 * Router for member removal.
 * Mounted at `/members/:userId` with `requirePermission('member.remove')` — admin+owner.
 *
 * DELETE /api/companies/:companyId/members/:userId
 */
export function securityMemberRemovalRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const isLocalTrusted = process.env.AUTH_MODE === 'local_trusted';

  // DELETE / (mounted at /members/:userId)
  // Remove a user from the company. In local_trusted mode this deactivates
  // their session row (active=false) so their existing session token is
  // rejected with 401 on the next request — modeling session invalidation
  // on company removal (VAL-SEC-011). Step-up sessions are revoked.
  // Also deletes the `company_members` row so RBAC membership is revoked.
  router.delete('/', async (req, res) => {
    requireAdminOrOwner(req);
    const { companyId, userId: targetUserId } = routeParams(req);
    const actingUserId = req.organizationMembership?.userId ?? req.user?.id ?? 'dev-user-000';

    if (isLocalTrusted) {
      const { localTrustedSessions } = db.schema;
      await db.drizzle
        .update(localTrustedSessions)
        .set({ active: false, updatedAt: new Date() })
        .where(
          and(
            eq(localTrustedSessions.companyId, companyId),
            eq(localTrustedSessions.userId, targetUserId),
          ),
        );
      await revokeUserStepUps(db, targetUserId);
    }

    // Delete the company_members row so the removed user loses RBAC access.
    const { companyMembers } = db.schema;
    await db.drizzle
      .delete(companyMembers)
      .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, targetUserId)));

    await db.drizzle.insert(db.schema.activityLog).values({
      companyId,
      actorType: 'user',
      actorId: actingUserId,
      action: 'member.removed',
      entityType: 'company_member',
      entityId: targetUserId,
      description: 'Removed member from company',
      metadata: { targetUserId },
      createdAt: new Date(),
    });

    res.json({ data: { companyId, userId: targetUserId, removed: true } });
  });

  return router;
}

/**
 * Legacy combined router — delegates to both role and removal routers.
 * Kept for backward compatibility with any code that imports
 * `securityMembersRouter`. New mounts should use the separate routers
 * with the appropriate permission. The role router is mounted at
 * `/members/:userId/role` and the removal router at `/members/:userId`
 * within this combined router.
 */
export function securityMembersRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  router.use('/members/:userId/role', securityMemberRoleRouter(db));
  router.use('/members/:userId', securityMemberRemovalRouter(db));
  return router;
}
