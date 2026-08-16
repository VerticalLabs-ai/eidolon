import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { eq, and, asc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import { revokeUserStepUps } from '../services/stepup-service.js';
import { routeParams } from '../utils/route-params.js';
import type { Permission } from '../middleware/permissions.js';
import type { DbInstance } from '../types.js';

// ---------------------------------------------------------------------------
// Member management (M2 — VAL-MEM-*) + Ownership transfer (RBAC follow-up)
// ---------------------------------------------------------------------------
//
// GET    /api/companies/:companyId/members
//        Permission: member.list (all roles)
//        Returns all company members with userId, role, createdAt.
//
// PATCH  /api/companies/:companyId/members/:memberId/role
//        Permission: member.promote (owner only)
//        Changes a member's role. Validates role enum. Enforces last-owner
//        protection (cannot demote the last owner).
//
// POST   /api/companies/:companyId/members/:memberId/role
//        Backward-compat alias for PATCH (existing tests use POST).
//
// DELETE /api/companies/:companyId/members/:memberId
//        Permission: member.remove (owner + admin)
//        Removes a member. Admins cannot remove owners. Last-owner
//        protection enforced.
//
// POST   /api/companies/:companyId/transfer-ownership
//        Permission: member.promote (owner only)
//        Atomically transfers ownership: promotes target to owner, demotes
//        current owner to admin. Revokes step-up sessions for demoted owner.
//        Audit logs ownership.transferred.
//
// The `:memberId` route param may be either the `company_members.id` (UUID)
// or the `userId`. The lookup tries `id` first, then falls back to `userId`
// for backward compatibility with existing tests and API consumers.
// ---------------------------------------------------------------------------

const UpdateRoleBody = z.object({
  role: z.enum(['owner', 'admin', 'member', 'viewer']),
});

const TransferOwnershipBody = z.object({
  targetMemberId: z.string().min(1),
});

const ROLE_HIERARCHY: Record<string, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
};

type RequirePermissionFn = (
  permission: Permission,
) => (req: Request, res: Response, next: NextFunction) => Promise<void>;

type TransactionClient = Parameters<Parameters<DbInstance['drizzle']['transaction']>['0']>['0'];

// -------------------------------------------------------------------------
// Module-level helpers (shared by membersRouter and transferOwnershipRouter)
// -------------------------------------------------------------------------

/**
 * Find a company_members row by `:memberId`. Tries `id` (UUID) first,
 * then falls back to `userId` for backward compatibility.
 *
 * In local_trusted mode, if no `company_members` row exists, also checks
 * `local_trusted_sessions` for a session matching `(companyId, userId)`.
 * This preserves backward compatibility with the M8 security surface
 * (mfa-stepup-security tests) which creates sessions without
 * `company_members` rows. If a session is found, a synthetic member
 * object is returned so the role-change/removal can proceed.
 *
 * The `fromCompanyMembers` flag indicates whether the member was found
 * in the `company_members` table (true) or via session fallback (false).
 * Last-owner protection only applies when `fromCompanyMembers` is true.
 *
 * Returns `null` if no row matches in either table.
 */
async function findMember(
  db: DbInstance,
  isLocalTrusted: boolean,
  companyId: string,
  memberId: string,
): Promise<{
  id: string;
  userId: string;
  role: string;
  createdAt: Date;
  fromCompanyMembers: boolean;
} | null> {
  const { companyMembers } = db.schema;

  // Try by primary key (company_members.id)
  const [byId] = await db.drizzle
    .select()
    .from(companyMembers)
    .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.id, memberId)))
    .limit(1);
  if (byId) {
    return { ...byId, fromCompanyMembers: true };
  }

  // Fall back to userId lookup
  const [byUserId] = await db.drizzle
    .select()
    .from(companyMembers)
    .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, memberId)))
    .limit(1);
  if (byUserId) {
    return { ...byUserId, fromCompanyMembers: true };
  }

  // In local_trusted mode, fall back to local_trusted_sessions for
  // backward compatibility with the M8 security surface.
  if (isLocalTrusted) {
    const { localTrustedSessions } = db.schema;
    const [sessionRow] = await db.drizzle
      .select()
      .from(localTrustedSessions)
      .where(
        and(
          eq(localTrustedSessions.companyId, companyId),
          eq(localTrustedSessions.userId, memberId),
        ),
      )
      .limit(1);
    if (sessionRow) {
      return {
        id: sessionRow.id,
        userId: sessionRow.userId,
        role: sessionRow.role,
        createdAt: sessionRow.createdAt,
        fromCompanyMembers: false,
      };
    }
  }

  return null;
}

/**
 * Lock all owner rows for the company within a transaction and return the
 * count. The SELECT ... FOR UPDATE prevents concurrent transactions from
 * changing the owner count between the check and the subsequent mutation.
 * In READ COMMITTED isolation, a concurrent transaction that has modified
 * an owner row will block this SELECT until it commits; once it commits,
 * the row is re-evaluated against the updated values.
 */
async function countOwnersForUpdate(
  db: DbInstance,
  tx: TransactionClient,
  companyId: string,
): Promise<number> {
  const { companyMembers } = db.schema;
  const owners = await tx
    .select({ id: companyMembers.id })
    .from(companyMembers)
    .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.role, 'owner')))
    .for('update');
  return owners.length;
}

/**
 * Lock all owner rows for the company within a transaction and return the
 * actual rows (not just the count). Used by the ownership transfer endpoint
 * to verify the actor is the current owner after locking.
 */
async function getOwnersForUpdate(
  db: DbInstance,
  tx: TransactionClient,
  companyId: string,
): Promise<{ id: string; userId: string; role: string }[]> {
  const { companyMembers } = db.schema;
  return tx
    .select({ id: companyMembers.id, userId: companyMembers.userId, role: companyMembers.role })
    .from(companyMembers)
    .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.role, 'owner')))
    .for('update');
}

export function membersRouter(db: DbInstance, requirePermission: RequirePermissionFn): Router {
  const router = Router({ mergeParams: true });
  const isLocalTrusted = process.env.AUTH_MODE === 'local_trusted';
  const { companyMembers } = db.schema;

  // -------------------------------------------------------------------------
  // GET / — list members (permission: member.list)
  // -------------------------------------------------------------------------

  router.get('/', requirePermission('member.list'), async (req, res) => {
    const { companyId } = routeParams(req);

    const members = await db.drizzle
      .select({
        id: companyMembers.id,
        userId: companyMembers.userId,
        role: companyMembers.role,
        createdAt: companyMembers.createdAt,
      })
      .from(companyMembers)
      .where(eq(companyMembers.companyId, companyId))
      .orderBy(asc(companyMembers.createdAt));

    res.json({ data: members });
  });

  // -------------------------------------------------------------------------
  // PATCH/POST /:memberId/role — change role (permission: member.promote)
  // -------------------------------------------------------------------------

  const roleChangeHandler = async (req: Request, res: Response): Promise<void> => {
    const { companyId, memberId } = routeParams(req);
    const body = (req as any).validated.body;
    const actorRole = req.organizationMembership?.role ?? 'member';
    const actingUserId = req.organizationMembership?.userId ?? req.user?.id ?? 'dev-user-000';

    // Defense-in-depth: requirePermission('member.promote') already enforces
    // owner-only, but verify the actor's role explicitly.
    if (actorRole !== 'owner') {
      throw new AppError(403, 'INSUFFICIENT_ROLE', 'This action requires owner role');
    }

    // Find the target member
    const targetMember = await findMember(db, isLocalTrusted, companyId, memberId);
    if (!targetMember) {
      throw new AppError(404, 'MEMBER_NOT_FOUND', 'Member not found in this company');
    }

    // Atomic last-owner protection: wrap the owner-count check and the role
    // update in a single transaction with SELECT ... FOR UPDATE on all owner
    // rows. This prevents a race condition where another concurrent request
    // demotes or removes the other owner between the count and the update.
    //
    // Only applies when the target has a company_members row (not a
    // session-only fallback) and the target is an owner being demoted to a
    // non-owner role.
    const isOwnerBeingDemoted =
      targetMember.fromCompanyMembers && targetMember.role === 'owner' && body.role !== 'owner';

    const updatedRole: string = body.role;
    let needsStepUpRevocation = false;

    await db.drizzle.transaction(async (tx) => {
      if (isOwnerBeingDemoted) {
        // Lock all owner rows so no concurrent transaction can change the
        // owner count between this check and the UPDATE below.
        const ownerCount = await countOwnersForUpdate(db, tx, companyId);
        if (ownerCount <= 1) {
          throw new AppError(
            400,
            'LAST_OWNER_PROTECTION',
            'Cannot demote the last owner of the company',
          );
        }
      }

      // In local_trusted mode, update the mutable session row so the change
      // takes effect on the member's next request with the same session token.
      if (isLocalTrusted) {
        const { localTrustedSessions } = db.schema;
        const [existingSession] = await tx
          .select()
          .from(localTrustedSessions)
          .where(
            and(
              eq(localTrustedSessions.companyId, companyId),
              eq(localTrustedSessions.userId, targetMember.userId),
            ),
          )
          .limit(1);

        if (existingSession) {
          const isDowngrade = ROLE_HIERARCHY[body.role] < ROLE_HIERARCHY[existingSession.role];

          await tx
            .update(localTrustedSessions)
            .set({ role: body.role, updatedAt: new Date() })
            .where(eq(localTrustedSessions.id, existingSession.id));

          // A privilege downgrade revokes the member's step-up sessions.
          if (isDowngrade) {
            needsStepUpRevocation = true;
          }
        }
      }

      // Update the company_members row (if one exists — the member may have
      // been found via local_trusted_sessions without a company_members row)
      await tx
        .update(companyMembers)
        .set({ role: body.role, updatedAt: new Date() })
        .where(
          and(
            eq(companyMembers.companyId, companyId),
            eq(companyMembers.userId, targetMember.userId),
          ),
        );
    });

    // Revoke step-up sessions outside the transaction (uses db directly)
    if (needsStepUpRevocation) {
      await revokeUserStepUps(db, targetMember.userId);
    }

    // Audit log
    await db.drizzle.insert(db.schema.activityLog).values({
      companyId,
      actorType: 'user',
      actorId: actingUserId,
      action: 'member.role_changed',
      entityType: 'company_member',
      entityId: targetMember.userId,
      description: `Changed member role to ${body.role}`,
      metadata: { targetUserId: targetMember.userId, newRole: body.role },
      createdAt: new Date(),
    });

    res.json({
      data: {
        id: targetMember.id,
        companyId,
        userId: targetMember.userId,
        role: body.role,
      },
    });
  };

  // PATCH is the primary method per the API contract (VAL-MEM-004).
  router.patch(
    '/:memberId/role',
    requirePermission('member.promote'),
    validate(UpdateRoleBody),
    roleChangeHandler,
  );

  // POST is a backward-compat alias (existing tests and the M8 security
  // surface use POST for role changes).
  router.post(
    '/:memberId/role',
    requirePermission('member.promote'),
    validate(UpdateRoleBody),
    roleChangeHandler,
  );

  // -------------------------------------------------------------------------
  // DELETE /:memberId — remove member (permission: member.remove)
  // -------------------------------------------------------------------------

  router.delete('/:memberId', requirePermission('member.remove'), async (req, res) => {
    const { companyId, memberId } = routeParams(req);
    const actorRole = req.organizationMembership?.role ?? 'member';
    const actingUserId = req.organizationMembership?.userId ?? req.user?.id ?? 'dev-user-000';

    // Find the target member
    const targetMember = await findMember(db, isLocalTrusted, companyId, memberId);
    if (!targetMember) {
      throw new AppError(404, 'MEMBER_NOT_FOUND', 'Member not found in this company');
    }

    // Admins cannot remove owners (only owners can remove other owners).
    // Only applies when the target has a company_members row.
    if (targetMember.fromCompanyMembers && targetMember.role === 'owner' && actorRole !== 'owner') {
      throw new AppError(
        403,
        'CANNOT_REMOVE_OWNER',
        'Admins cannot remove owners. Only an owner can remove another owner.',
      );
    }

    // Atomic last-owner protection: wrap the owner-count check and the
    // deletion in a single transaction with SELECT ... FOR UPDATE on all
    // owner rows. This prevents a race condition where another concurrent
    // request removes the other owner between the count and the delete.
    //
    // Only applies when the target has a company_members row and is an owner.
    const isOwnerRemoval = targetMember.fromCompanyMembers && targetMember.role === 'owner';

    await db.drizzle.transaction(async (tx) => {
      if (isOwnerRemoval) {
        // Lock all owner rows so no concurrent transaction can change the
        // owner count between this check and the DELETE below.
        const ownerCount = await countOwnersForUpdate(db, tx, companyId);
        if (ownerCount <= 1) {
          throw new AppError(
            400,
            'LAST_OWNER_PROTECTION',
            'Cannot remove the last owner of the company',
          );
        }
      }

      // In local_trusted mode, deactivate the member's session so their
      // existing session token is rejected on the next request.
      if (isLocalTrusted) {
        const { localTrustedSessions } = db.schema;
        await tx
          .update(localTrustedSessions)
          .set({ active: false, updatedAt: new Date() })
          .where(
            and(
              eq(localTrustedSessions.companyId, companyId),
              eq(localTrustedSessions.userId, targetMember.userId),
            ),
          );
      }

      // Delete the company_members row — removed user immediately loses
      // access. (If the member was found via local_trusted_sessions without
      // a company_members row, this is a no-op DELETE.)
      await tx
        .delete(companyMembers)
        .where(
          and(
            eq(companyMembers.companyId, companyId),
            eq(companyMembers.userId, targetMember.userId),
          ),
        );
    });

    // Revoke step-up sessions outside the transaction (uses db directly)
    if (isLocalTrusted) {
      await revokeUserStepUps(db, targetMember.userId);
    }

    // Audit log
    await db.drizzle.insert(db.schema.activityLog).values({
      companyId,
      actorType: 'user',
      actorId: actingUserId,
      action: 'member.removed',
      entityType: 'company_member',
      entityId: targetMember.userId,
      description: 'Removed member from company',
      metadata: { targetUserId: targetMember.userId },
      createdAt: new Date(),
    });

    res.json({
      data: { companyId, userId: targetMember.userId, removed: true },
    });
  });

  return router;
}

// ---------------------------------------------------------------------------
// POST /api/companies/:companyId/transfer-ownership
//   Permission: member.promote (owner only)
//   Atomically transfers ownership from the current owner to a target member.
//   The target is promoted to owner and the current owner is demoted to admin
//   within a single Drizzle transaction with SELECT ... FOR UPDATE locking.
//   After the transaction, the demoted owner's step-up sessions are revoked.
//   An ownership.transferred audit entry is inserted with both owner IDs.
// ---------------------------------------------------------------------------

export function transferOwnershipRouter(
  db: DbInstance,
  requirePermission: RequirePermissionFn,
): Router {
  const router = Router({ mergeParams: true });
  const isLocalTrusted = process.env.AUTH_MODE === 'local_trusted';
  const { companyMembers } = db.schema;

  router.post(
    '/',
    requirePermission('member.promote'),
    validate(TransferOwnershipBody),
    async (req: Request, res: Response): Promise<void> => {
      const { companyId } = routeParams(req);
      const body = (req as any).validated.body as { targetMemberId: string };
      const actorRole = req.organizationMembership?.role ?? 'member';
      const actingUserId = req.organizationMembership?.userId ?? req.user?.id ?? 'dev-user-000';

      // Defense-in-depth: requirePermission('member.promote') already
      // enforces owner-only, but verify the actor's role explicitly.
      if (actorRole !== 'owner') {
        throw new AppError(403, 'INSUFFICIENT_ROLE', 'This action requires owner role');
      }

      // Variables populated inside the transaction for use after commit
      let newOwnerMemberId = '';
      let previousOwnerMemberId = '';
      let previousOwnerUserId = actingUserId;
      let newOwnerUserId = body.targetMemberId;

      await db.drizzle.transaction(async (tx) => {
        // (1) Lock all owner rows with SELECT ... FOR UPDATE
        const owners = await getOwnersForUpdate(db, tx, companyId);

        if (owners.length === 0) {
          throw new AppError(403, 'INSUFFICIENT_ROLE', 'No owner found for this company');
        }

        // (2) Verify the actor is the current owner
        const currentOwner = owners.find((o) => o.userId === actingUserId);
        if (!currentOwner) {
          throw new AppError(
            403,
            'INSUFFICIENT_ROLE',
            'Only the current owner can transfer ownership',
          );
        }
        previousOwnerMemberId = currentOwner.id;
        previousOwnerUserId = currentOwner.userId;

        // (3) Find the target member INSIDE the transaction using tx.
        // Only look in company_members — ownership transfer requires a
        // persisted company_members row. Session-only targets (found in
        // local_trusted_sessions but not company_members) are rejected
        // with 404 MEMBER_NOT_FOUND (ISSUE 1 fix).
        //
        // The lookup is transaction-bound so that a concurrent target
        // removal is visible to the subsequent promotion UPDATE within
        // the same transaction (ISSUE 2a fix).
        let targetMember: {
          id: string;
          userId: string;
          role: string;
          createdAt: Date;
        } | null = null;

        // Try by primary key (company_members.id)
        const [byId] = await tx
          .select()
          .from(companyMembers)
          .where(
            and(
              eq(companyMembers.companyId, companyId),
              eq(companyMembers.id, body.targetMemberId),
            ),
          )
          .limit(1);
        if (byId) {
          targetMember = byId;
        }

        // Fall back to userId lookup
        if (!targetMember) {
          const [byUserId] = await tx
            .select()
            .from(companyMembers)
            .where(
              and(
                eq(companyMembers.companyId, companyId),
                eq(companyMembers.userId, body.targetMemberId),
              ),
            )
            .limit(1);
          if (byUserId) {
            targetMember = byUserId;
          }
        }

        // (4) Validate target
        if (!targetMember) {
          throw new AppError(404, 'MEMBER_NOT_FOUND', 'Member not found in this company');
        }

        if (targetMember.userId === currentOwner.userId) {
          throw new AppError(
            400,
            'CANNOT_TRANSFER_TO_SELF',
            'Cannot transfer ownership to yourself',
          );
        }

        if (targetMember.role === 'owner') {
          throw new AppError(400, 'TARGET_ALREADY_OWNER', 'The target member is already an owner');
        }

        newOwnerUserId = targetMember.userId;
        newOwnerMemberId = targetMember.id;

        // (5) Promote target to owner, demote current to admin
        // Promote the target member's role to owner and verify at least
        // one row was affected. If the target was concurrently removed
        // (e.g., by a DELETE in another transaction that committed
        // between the lookup and this UPDATE), the promotion is a no-op
        // (0 rows). Throw inside the transaction to roll back — do NOT
        // proceed with demoting the owner (ISSUE 2b fix).
        const promoted = await tx
          .update(companyMembers)
          .set({ role: 'owner', updatedAt: new Date() })
          .where(
            and(
              eq(companyMembers.companyId, companyId),
              eq(companyMembers.userId, targetMember.userId),
            ),
          )
          .returning({ id: companyMembers.id });

        if (promoted.length === 0) {
          throw new AppError(
            404,
            'MEMBER_NOT_FOUND',
            'Target member was concurrently removed — transfer rolled back',
          );
        }

        // Demote the current owner to admin
        await tx
          .update(companyMembers)
          .set({ role: 'admin', updatedAt: new Date() })
          .where(
            and(
              eq(companyMembers.companyId, companyId),
              eq(companyMembers.userId, currentOwner.userId),
            ),
          );

        // (6) Update local_trusted_sessions in local_trusted mode
        if (isLocalTrusted) {
          const { localTrustedSessions } = db.schema;

          // Promote target's session to owner
          const [targetSession] = await tx
            .select()
            .from(localTrustedSessions)
            .where(
              and(
                eq(localTrustedSessions.companyId, companyId),
                eq(localTrustedSessions.userId, targetMember.userId),
              ),
            )
            .limit(1);

          if (targetSession) {
            await tx
              .update(localTrustedSessions)
              .set({ role: 'owner', updatedAt: new Date() })
              .where(eq(localTrustedSessions.id, targetSession.id));
          }

          // Demote current owner's session to admin
          const [ownerSession] = await tx
            .select()
            .from(localTrustedSessions)
            .where(
              and(
                eq(localTrustedSessions.companyId, companyId),
                eq(localTrustedSessions.userId, currentOwner.userId),
              ),
            )
            .limit(1);

          if (ownerSession) {
            await tx
              .update(localTrustedSessions)
              .set({ role: 'admin', updatedAt: new Date() })
              .where(eq(localTrustedSessions.id, ownerSession.id));
          }
        }

        // (7) Transaction commits on return
      });

      // After transaction: revoke step-up sessions for the demoted owner
      await revokeUserStepUps(db, previousOwnerUserId);

      // Insert audit entry
      await db.drizzle.insert(db.schema.activityLog).values({
        companyId,
        actorType: 'user',
        actorId: actingUserId,
        action: 'ownership.transferred',
        entityType: 'company',
        entityId: companyId,
        description: 'Transferred company ownership',
        metadata: {
          previousOwnerUserId,
          newOwnerUserId,
          newOwnerMemberId,
          previousOwnerMemberId,
        },
        createdAt: new Date(),
      });

      // Response
      res.json({
        data: {
          newOwner: {
            id: newOwnerMemberId,
            userId: newOwnerUserId,
            role: 'owner',
          },
          previousOwner: {
            id: previousOwnerMemberId,
            userId: previousOwnerUserId,
            role: 'admin',
          },
        },
      });
    },
  );

  return router;
}
