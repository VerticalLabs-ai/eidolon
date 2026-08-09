import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import {
  enrollTotpFactor,
  listMfaFactors,
  verifyTotpCode,
  disableMfaFactor,
  generateValidTotpCode,
} from '../services/mfa-service.js';
import { grantStepUp, userHasStepUp, type StepUpScope } from '../services/stepup-service.js';
import { StepUpScopeSchema } from '@eidolon/shared';
import type { DbInstance } from '../types.js';

// ---------------------------------------------------------------------------
// MFA + step-up authentication routes (M8 enterprise security)
// ---------------------------------------------------------------------------
//
// These routes are user-scoped (not company-scoped) and sit under
// `/api/auth`. They require an authenticated user (`requireAuth`) but NOT
// org membership — MFA protects the user's identity across companies.
//
// In `local_trusted` mode the user id is `dev-user-000` or a created test
// user. The `generate-valid-code` helper is guarded to `local_trusted` so
// validators/agents can produce a valid TOTP without a real authenticator.
// ---------------------------------------------------------------------------

const EnrollBody = z.object({
  label: z.string().trim().max(120).optional(),
  // Optional company context so MFA enrollment is recorded in the company
  // audit log (VAL-SEC-007). The MFA routes are user-scoped (requireAuth, not
  // requireOrgMember), so the company context is passed explicitly.
  companyId: z.string().optional(),
});
const VerifyBody = z.object({ code: z.string().trim().min(4).max(10) });
const StepUpBody = z.object({
  code: z.string().trim().min(4).max(10),
  scope: StepUpScopeSchema,
  companyId: z.string().optional(),
});

/** Resolve the acting user id from the request (works in both auth modes). */
function actingUserId(req: any): string {
  return req.user?.id ?? 'dev-user-000';
}

export function mfaRouter(db: DbInstance): Router {
  const router = Router();
  const isLocalTrusted = process.env.AUTH_MODE === 'local_trusted';

  // POST /api/auth/mfa/enroll — enroll a new TOTP factor
  router.post('/enroll', validate(EnrollBody), async (req, res) => {
    const userId = actingUserId(req);
    const body = (req as any).validated.body;
    const enrollment = await enrollTotpFactor(db, userId, {
      label: body.label,
      companyId: body.companyId ?? null,
      accountLabel: req.user?.email ?? userId,
    });

    // Audit: MFA enrollment is a security-relevant action (VAL-SEC-007).
    if (req.organizationMembership?.organizationId ?? body.companyId) {
      const companyId = req.organizationMembership?.organizationId ?? body.companyId;
      await db.drizzle.insert(db.schema.activityLog).values({
        companyId,
        actorType: 'user',
        actorId: userId,
        action: 'mfa.enroll',
        entityType: 'user_mfa_factor',
        entityId: enrollment.factor.id,
        description: `Enrolled TOTP MFA factor${body.label ? ` "${body.label}"` : ''}`,
        metadata: { factorType: 'totp', factorLabel: body.label ?? null },
        createdAt: new Date(),
      });
    }

    res.status(201).json({ data: enrollment });
  });

  // GET /api/auth/mfa/factors — list the user's active MFA factors
  router.get('/factors', async (req, res) => {
    const userId = actingUserId(req);
    const factors = await listMfaFactors(db, userId);
    res.json({ data: factors });
  });

  // POST /api/auth/mfa/verify — verify a TOTP code (challenge)
  // Returns 200 + factorId on success, 401 on invalid code.
  router.post('/verify', validate(VerifyBody), async (req, res) => {
    const userId = actingUserId(req);
    const body = (req as any).validated.body;
    const factorId = await verifyTotpCode(db, userId, body.code);
    if (!factorId) {
      throw new AppError(401, 'MFA_CODE_INVALID', 'The MFA code is invalid or expired');
    }
    res.json({ data: { verified: true, factorId } });
  });

  // DELETE /api/auth/mfa/factors/:factorId — disable an MFA factor
  router.delete('/factors/:factorId', async (req, res) => {
    const userId = actingUserId(req);
    const factorId = req.params.factorId;
    await disableMfaFactor(db, userId, factorId);
    res.json({ data: { disabled: true, factorId } });
  });

  // POST /api/auth/mfa/generate-valid-code — LOCAL TRUSTED ONLY
  // Returns a currently-valid TOTP code for the user's first active factor,
  // so validators/agents can complete an MFA challenge without a real
  // authenticator device. Guarded to local_trusted mode (404 otherwise).
  router.post('/generate-valid-code', async (req, res) => {
    if (!isLocalTrusted) {
      throw new AppError(404, 'NOT_FOUND', 'Endpoint not available');
    }
    const userId = actingUserId(req);
    const code = await generateValidTotpCode(db, userId);
    if (!code) {
      throw new AppError(404, 'NO_MFA_FACTOR', 'No active MFA factor enrolled for this user');
    }
    res.json({ data: { code } });
  });

  return router;
}

export function stepUpRouter(db: DbInstance): Router {
  const router = Router();

  // POST /api/auth/step-up — verify MFA code + grant a step-up session
  router.post('/', validate(StepUpBody), async (req, res) => {
    const userId = actingUserId(req);
    const body = (req as any).validated.body;
    const session = await grantStepUp(db, userId, body.code, body.scope as StepUpScope, {
      companyId: body.companyId ?? null,
    });
    res.status(201).json({ data: session });
  });

  // GET /api/auth/step-up/status?scope=... — check for a valid step-up session
  router.get('/status', async (req, res) => {
    const userId = actingUserId(req);
    const scope = req.query.scope as string;
    if (!scope) {
      throw new AppError(400, 'BAD_REQUEST', 'scope query parameter is required');
    }
    const has = await userHasStepUp(db, userId, scope as StepUpScope);
    res.json({ data: { hasStepUp: has, scope } });
  });

  return router;
}
