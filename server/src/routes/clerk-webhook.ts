import { Router } from 'express';
import type { Request, Response } from 'express';
import { eq, and } from 'drizzle-orm';
import { verifyWebhook } from '@clerk/backend/webhooks';
import { AppError } from '../middleware/error-handler.js';
import type { DbInstance } from '../types.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Clerk webhook handler (M2 — VAL-INV-015 through VAL-INV-022)
// ---------------------------------------------------------------------------
//
// POST /api/webhooks/clerk
//   Public endpoint (no auth middleware). Verifies the Clerk webhook
//   signature in production mode. In local_trusted mode, signature
//   verification is bypassed for testing.
//
// On user.created event:
//   1. Extracts the user's primary email address
//   2. Finds all pending, non-expired invitations for that email
//   3. For each matching invitation:
//      a. Creates a company_members row with the invitation's role
//      b. Marks the invitation as accepted (status→accepted,
//         acceptedByUserId, acceptedAt)
//
// If no matching invitations are found, the webhook succeeds with no action.
// Expired invitations are skipped (not accepted, no membership created).
// ---------------------------------------------------------------------------

export function clerkWebhookRouter(db: DbInstance): Router {
  const router = Router();
  const isLocalTrusted = process.env.AUTH_MODE === 'local_trusted';
  const { companyInvitations, companyMembers } = db.schema;

  router.post('/', async (req: Request, res: Response) => {
    let eventType: string;
    let eventData: any;

    if (isLocalTrusted) {
      // Local trusted mode: bypass signature verification.
      // The body is already parsed by express.json().
      eventType = req.body?.type;
      eventData = req.body?.data;
    } else {
      // Production mode: verify the Clerk webhook signature.
      // verifyWebhook expects a standard Web API Request object.
      try {
        const rawBody = (req as any).rawBody ?? JSON.stringify(req.body ?? {});
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') {
            headers.set(key, value);
          }
        }
        const webRequest = new Request(
          `http://${req.headers.host ?? 'localhost'}${req.originalUrl}`,
          {
            method: req.method,
            headers,
            body: rawBody,
          },
        );
        const event = await verifyWebhook(webRequest, {
          signingSecret: process.env.CLERK_WEBHOOK_SECRET,
        });
        eventType = event.type;
        eventData = event.data;
      } catch (err) {
        logger.warn({ err }, 'Clerk webhook verification failed');
        throw new AppError(401, 'WEBHOOK_VERIFICATION_FAILED', 'Invalid webhook signature');
      }
    }

    // Handle user.created event
    if (eventType === 'user.created') {
      const clerkUserId: string | undefined = eventData?.id;

      // Extract the primary email address from the Clerk user data.
      const emailAddresses: Array<{ id: string; email_address: string }> =
        eventData?.email_addresses ?? [];
      const primaryEmailId: string | null = eventData?.primary_email_address_id ?? null;
      const primaryEmailObj = primaryEmailId
        ? emailAddresses.find((e) => e.id === primaryEmailId)
        : emailAddresses[0];
      const email: string | undefined = primaryEmailObj?.email_address;

      if (clerkUserId && email) {
        await processInvitations(db, email, clerkUserId);
      }
    }

    // Always return success — Clerk expects a 2xx response.
    res.json({ received: true });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Invitation processing logic
// ---------------------------------------------------------------------------

/**
 * Find all pending, non-expired invitations for the given email and activate
 * them: create company_members rows with the invitation's role and mark the
 * invitations as accepted.
 *
 * Expired invitations are skipped (not accepted, no membership created).
 * Revoked invitations are not matched (status != 'pending').
 */
async function processInvitations(
  db: DbInstance,
  email: string,
  clerkUserId: string,
): Promise<void> {
  const { companyInvitations, companyMembers } = db.schema;
  const now = new Date();

  // Find all pending invitations for this email across all companies.
  const pendingInvitations = await db.drizzle
    .select()
    .from(companyInvitations)
    .where(and(eq(companyInvitations.email, email), eq(companyInvitations.status, 'pending')));

  for (const invitation of pendingInvitations) {
    // Skip expired invitations — they cannot be accepted.
    if (invitation.expiresAt <= now) {
      continue;
    }

    // Create the company_members row with the invitation's role.
    // onConflictDoNothing handles the edge case where the user is already
    // a member (e.g., webhook retried after a partial failure).
    await db.drizzle
      .insert(companyMembers)
      .values({
        companyId: invitation.companyId,
        userId: clerkUserId,
        role: invitation.role,
        createdByUserId: invitation.invitedByUserId,
      })
      .onConflictDoNothing();

    // Mark the invitation as accepted.
    await db.drizzle
      .update(companyInvitations)
      .set({
        status: 'accepted',
        acceptedByUserId: clerkUserId,
        acceptedAt: now,
        updatedAt: now,
      })
      .where(eq(companyInvitations.id, invitation.id));

    logger.info(
      {
        invitationId: invitation.id,
        companyId: invitation.companyId,
        email,
        clerkUserId,
        role: invitation.role,
      },
      'Invitation accepted via Clerk webhook',
    );
  }
}
