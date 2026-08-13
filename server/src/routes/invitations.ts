import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { eq, and, asc } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import { routeParams } from '../utils/route-params.js';
import type { Permission } from '../middleware/permissions.js';
import type { DbInstance } from '../types.js';

// ---------------------------------------------------------------------------
// Invitation management (M2 — VAL-INV-*)
// ---------------------------------------------------------------------------
//
// POST   /api/companies/:companyId/invitations
//        Permission: member.invite (owner + admin)
//        Creates a company_invitations row with status=pending, expiresAt=+7d.
//        Validates email format. Rejects duplicate pending invitations (409).
//
// GET    /api/companies/:companyId/invitations
//        Permission: member.invite (owner + admin)
//        Lists all invitations with status.
//
// DELETE /api/companies/:companyId/invitations/:invitationId
//        Permission: member.invite (owner + admin)
//        Revokes a pending invitation (status→revoked).
//        Rejects revoking accepted invitations.
// ---------------------------------------------------------------------------

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CreateInvitationBody = z.object({
  email: z.string().refine((v) => EMAIL_REGEX.test(v), 'Invalid email format'),
  role: z.enum(['owner', 'admin', 'member', 'viewer']).default('member'),
});

type RequirePermissionFn = (
  permission: Permission,
) => (req: Request, res: Response, next: NextFunction) => Promise<void>;

export function invitationsRouter(db: DbInstance, requirePermission: RequirePermissionFn): Router {
  const router = Router({ mergeParams: true });
  const { companyInvitations } = db.schema;

  // -------------------------------------------------------------------------
  // POST / — create invitation (permission: member.invite)
  // -------------------------------------------------------------------------

  router.post(
    '/',
    requirePermission('member.invite'),
    validate(CreateInvitationBody),
    async (req, res) => {
      const { companyId } = routeParams(req);
      const body = (req as any).validated.body as {
        email: string;
        role: 'owner' | 'admin' | 'member' | 'viewer';
      };
      const actingUserId = req.organizationMembership?.userId ?? req.user?.id ?? 'dev-user-000';

      // Check for duplicate pending invitation for the same email+company.
      const [existing] = await db.drizzle
        .select({ id: companyInvitations.id })
        .from(companyInvitations)
        .where(
          and(
            eq(companyInvitations.companyId, companyId),
            eq(companyInvitations.email, body.email),
            eq(companyInvitations.status, 'pending'),
          ),
        )
        .limit(1);

      if (existing) {
        throw new AppError(
          409,
          'DUPLICATE_PENDING_INVITATION',
          'A pending invitation already exists for this email in this company',
        );
      }

      // Insert the new invitation.
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const [invitation] = await db.drizzle
        .insert(companyInvitations)
        .values({
          companyId,
          email: body.email,
          role: body.role,
          status: 'pending',
          invitedByUserId: actingUserId,
          expiresAt,
        })
        .returning();

      // Audit log
      await db.drizzle.insert(db.schema.activityLog).values({
        companyId,
        actorType: 'user',
        actorId: actingUserId,
        action: 'invitation.created',
        entityType: 'company_invitation',
        entityId: invitation.id,
        description: `Invited ${body.email} as ${body.role}`,
        metadata: { email: body.email, role: body.role },
        createdAt: new Date(),
      });

      res.status(201).json({
        data: {
          id: invitation.id,
          companyId: invitation.companyId,
          email: invitation.email,
          role: invitation.role,
          status: invitation.status,
          invitedByUserId: invitation.invitedByUserId,
          expiresAt: invitation.expiresAt,
          createdAt: invitation.createdAt,
        },
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET / — list invitations (permission: member.invite)
  // -------------------------------------------------------------------------

  router.get('/', requirePermission('member.invite'), async (req, res) => {
    const { companyId } = routeParams(req);

    const invitations = await db.drizzle
      .select({
        id: companyInvitations.id,
        companyId: companyInvitations.companyId,
        email: companyInvitations.email,
        role: companyInvitations.role,
        status: companyInvitations.status,
        invitedByUserId: companyInvitations.invitedByUserId,
        acceptedByUserId: companyInvitations.acceptedByUserId,
        acceptedAt: companyInvitations.acceptedAt,
        expiresAt: companyInvitations.expiresAt,
        createdAt: companyInvitations.createdAt,
      })
      .from(companyInvitations)
      .where(eq(companyInvitations.companyId, companyId))
      .orderBy(asc(companyInvitations.createdAt));

    res.json({ data: invitations });
  });

  // -------------------------------------------------------------------------
  // DELETE /:invitationId — revoke invitation (permission: member.invite)
  // -------------------------------------------------------------------------

  router.delete('/:invitationId', requirePermission('member.invite'), async (req, res) => {
    const { companyId, invitationId } = routeParams(req);
    const actingUserId = req.organizationMembership?.userId ?? req.user?.id ?? 'dev-user-000';

    // Find the invitation.
    const [invitation] = await db.drizzle
      .select()
      .from(companyInvitations)
      .where(
        and(eq(companyInvitations.id, invitationId), eq(companyInvitations.companyId, companyId)),
      )
      .limit(1);

    if (!invitation) {
      throw new AppError(404, 'INVITATION_NOT_FOUND', 'Invitation not found in this company');
    }

    // Cannot revoke an accepted invitation.
    if (invitation.status === 'accepted') {
      throw new AppError(
        409,
        'INVITATION_ALREADY_ACCEPTED',
        'Cannot revoke an invitation that has already been accepted',
      );
    }

    // If already revoked, return success (idempotent).
    if (invitation.status === 'revoked') {
      res.json({
        data: {
          id: invitation.id,
          companyId: invitation.companyId,
          email: invitation.email,
          role: invitation.role,
          status: invitation.status,
        },
      });
      return;
    }

    // Update status to revoked.
    await db.drizzle
      .update(companyInvitations)
      .set({ status: 'revoked', updatedAt: new Date() })
      .where(eq(companyInvitations.id, invitation.id));

    // Audit log
    await db.drizzle.insert(db.schema.activityLog).values({
      companyId,
      actorType: 'user',
      actorId: actingUserId,
      action: 'invitation.revoked',
      entityType: 'company_invitation',
      entityId: invitation.id,
      description: `Revoked invitation for ${invitation.email}`,
      metadata: { email: invitation.email },
      createdAt: new Date(),
    });

    res.json({
      data: {
        id: invitation.id,
        companyId: invitation.companyId,
        email: invitation.email,
        role: invitation.role,
        status: 'revoked',
      },
    });
  });

  return router;
}
