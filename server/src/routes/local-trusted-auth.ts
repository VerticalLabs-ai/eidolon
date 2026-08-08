import { Router } from 'express';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import type { DbInstance } from '../types.js';

// ---------------------------------------------------------------------------
// Local-trusted test user creation
// ---------------------------------------------------------------------------
//
// In `local_trusted` auth mode, the only user is `dev-user-000`, so user
// mentions are always self-mentions (correctly skipped). This endpoint lets
// validators create a second test user with email/name and associate them
// with a company so that user mentions resolve, inbox notifications are
// created, and `thread.mention` WS events fire.
//
// Guarded to `AUTH_MODE=local_trusted` only — returns 404 in any other mode.
// ---------------------------------------------------------------------------

const CreateTestUserBody = z.object({
  email: z.string().email().max(255),
  name: z.string().trim().min(1).max(255),
  companyId: z.string().min(1).max(255),
});

export function localTrustedAuthRouter(db: DbInstance): Router {
  // Capture auth mode at router creation time (during createApp() when
  // AUTH_MODE is set). In tests, createTestApp() sets AUTH_MODE only
  // during createApp() and restores it afterward, so checking
  // process.env.AUTH_MODE at request time would always be undefined.
  const isLocalTrusted = process.env.AUTH_MODE === 'local_trusted';
  const router = Router();

  // POST /api/auth/local-trusted/create-test-user
  router.post('/create-test-user', validate(CreateTestUserBody), async (req, res) => {
    // Guard: only available in local_trusted mode
    if (!isLocalTrusted) {
      throw new AppError(404, 'NOT_FOUND', 'Endpoint not available');
    }

    const body = req.body as z.infer<typeof CreateTestUserBody>;
    const { testUsers, companies } = db.schema;

    // Verify the company exists
    const [company] = await db.drizzle
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, body.companyId))
      .limit(1);

    if (!company) {
      throw new AppError(404, 'COMPANY_NOT_FOUND', `Company ${body.companyId} not found`);
    }

    // Check for duplicate (same company + email)
    const [existing] = await db.drizzle
      .select({ id: testUsers.id })
      .from(testUsers)
      .where(
        and(eq(testUsers.companyId, body.companyId), eq(testUsers.email, body.email)),
      )
      .limit(1);

    if (existing) {
      // Return the existing test user (idempotent)
      const [row] = await db.drizzle
        .select()
        .from(testUsers)
        .where(eq(testUsers.id, existing.id))
        .limit(1);
      return res.status(200).json({ data: row });
    }

    const [row] = await db.drizzle
      .insert(testUsers)
      .values({
        companyId: body.companyId,
        name: body.name,
        email: body.email,
      })
      .returning();

    res.status(201).json({ data: row });
  });

  return router;
}
