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
// Both routes require admin/owner org role (enforced via requireOrgMember
// on mount + an explicit check), and write an audit-log entry.
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
    throw new AppError(
      403,
      'INSUFFICIENT_ROLE',
      'This action requires admin or owner role',
    );
  }
}

export function securityMembersRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const isLocalTrusted = process.env.AUTH_MODE === 'local_trusted';

  // POST /api/companies/:companyId/members/:userId/role
  // Change a member's org role (downgrade or upgrade). In local_trusted mode
  // this updates the member's local_trusted_sessions row, so their existing
  // session token immediately reflects the new role. A downgrade revokes any
  // step-up sessions the member held.
  router.post(
    '/members/:userId/role',
    validate(UpdateRoleBody),
    async (req, res) => {
      requireAdminOrOwner(req);
      const { companyId, userId: targetUserId } = routeParams(req);
      const body = (req as any).validated.body;
      const actingUserId = req.organizationMembership?.userId ?? req.user?.id ?? 'dev-user-000';

      if (isLocalTrusted) {
        const { localTrustedSessions } = db.schema;
        const existing = await db.drizzle
          .select()
          .from(localTrustedSessions)
          .where(
            and(
              eq(localTrustedSessions.companyId, companyId),
              eq(localTrustedSessions.userId, targetUserId),
            ),
          );

        if (existing.length === 0) {
          throw new AppError(
            404,
            'MEMBER_NOT_FOUND',
            'No session found for that user in this company',
          );
        }

        const isDowngrade =
          ROLE_HIERARCHY[body.role] < ROLE_HIERARCHY[existing[0].role];

        await db.drizzle
          .update(localTrustedSessions)
          .set({ role: body.role, updatedAt: new Date() })
          .where(
            and(
              eq(localTrustedSessions.companyId, companyId),
              eq(localTrustedSessions.userId, targetUserId),
            ),
          );

        // A privilege downgrade revokes the member's step-up sessions so they
        // cannot reuse a prior re-auth for sensitive operations.
        if (isDowngrade) {
          await revokeUserStepUps(db, targetUserId);
        }
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
    },
  );

  // DELETE /api/companies/:companyId/members/:userId
  // Remove a user from the company. In local_trusted mode this deactivates
  // their session row (active=false) so their existing session token is
  // rejected with 401 on the next request — modeling session invalidation
  // on company removal (VAL-SEC-011). Step-up sessions are revoked.
  router.delete('/members/:userId', async (req, res) => {
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
