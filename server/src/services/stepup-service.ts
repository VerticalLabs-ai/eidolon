import { and, eq, gt, isNull, desc } from 'drizzle-orm';
import type { DbInstance } from '../types.js';
import { verifyTotpCode } from './mfa-service.js';
import { AppError } from '../middleware/error-handler.js';

/**
 * Step-up re-authentication service (M8 enterprise security).
 *
 * A step-up session is granted after a user re-verifies via MFA (or
 * re-enters credentials in production) and authorizes a sensitive operation
 * scope for a bounded validity window. Sensitive handlers check for a valid
 * (non-expired, non-revoked) step-up session before proceeding.
 *
 * The window default is 5 minutes. Step-up tokens are bearer tokens returned
 * to the client and presented back via the `X-Eidolon-Step-Up-Token` header
 * (or `?stepUpToken=` query) on the gated request.
 */

export const STEP_UP_DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

export type StepUpScope =
  | 'company_delete'
  | 'artifact_permanent_delete'
  | 'artifact_transfer'
  | 'sensitive_action';

/**
 * Grant a step-up session for a scope after verifying the MFA code.
 * Returns the new session token + expiry.
 */
export async function grantStepUp(
  db: DbInstance,
  userId: string,
  code: string,
  scope: StepUpScope,
  opts: { companyId?: string | null; ttlMs?: number } = {},
): Promise<{
  stepUpToken: string;
  scope: StepUpScope;
  grantedAt: string;
  expiresAt: string;
}> {
  const factorId = await verifyTotpCode(db, userId, code);
  if (!factorId) {
    throw new AppError(401, 'MFA_CODE_INVALID', 'The MFA code is invalid or expired');
  }

  const now = new Date();
  const ttl = opts.ttlMs ?? STEP_UP_DEFAULT_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttl);

  const [row] = await db.drizzle
    .insert(db.schema.stepUpSessions)
    .values({
      userId,
      companyId: opts.companyId ?? null,
      scope,
      grantedAt: now,
      expiresAt,
      revokedAt: null,
      consumed: false,
    })
    .returning();

  return {
    stepUpToken: row.id,
    scope: row.scope as StepUpScope,
    grantedAt: row.grantedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

/**
 * Look up a step-up session by token and verify it is valid for the given
 * scope: not expired, not revoked, not consumed. Does NOT consume it.
 */
export async function hasValidStepUp(
  db: DbInstance,
  token: string,
  scope: StepUpScope,
): Promise<boolean> {
  const now = new Date();
  const [row] = await db.drizzle
    .select()
    .from(db.schema.stepUpSessions)
    .where(eq(db.schema.stepUpSessions.id, token))
    .limit(1);

  if (!row) return false;
  if (row.scope !== scope) return false;
  if (row.revokedAt !== null) return false;
  if (row.consumed) return false;
  if (new Date(row.expiresAt).getTime() <= now.getTime()) return false;
  return true;
}

/**
 * Check whether the user has ANY valid (non-expired, non-revoked) step-up
 * session for the given scope. Used by the status endpoint and as a fallback
 * when a request omits the bearer token but the user recently stepped up.
 */
export async function userHasStepUp(
  db: DbInstance,
  userId: string,
  scope: StepUpScope,
): Promise<boolean> {
  const now = new Date();
  const rows = await db.drizzle
    .select()
    .from(db.schema.stepUpSessions)
    .where(
      and(
        eq(db.schema.stepUpSessions.userId, userId),
        eq(db.schema.stepUpSessions.scope, scope),
        isNull(db.schema.stepUpSessions.revokedAt),
        gt(db.schema.stepUpSessions.expiresAt, now),
      ),
    )
    .orderBy(desc(db.schema.stepUpSessions.expiresAt))
    .limit(1);
  return rows.length > 0;
}

/**
 * Resolve a valid step-up session for the user + scope. Honors an explicit
 * bearer token when present, otherwise falls back to any valid session the
 * user holds for that scope. Throws `MFA_REQUIRED` (403) when none is found.
 */
export async function requireStepUp(
  db: DbInstance,
  userId: string,
  scope: StepUpScope,
  token?: string | null,
): Promise<void> {
  if (token) {
    const valid = await hasValidStepUp(db, token, scope);
    if (valid) return;
  }
  const hasAny = await userHasStepUp(db, userId, scope);
  if (!hasAny) {
    throw new AppError(
      403,
      'MFA_STEP_UP_REQUIRED',
      'This action requires step-up re-authentication (MFA). Complete the MFA challenge and retry.',
      { scope },
    );
  }
}

/**
 * Consume (single-use) a step-up session so it cannot be reused. Optional —
 * scopes may choose single-use or windowed semantics. Windowed (reusable
 * within expiry) is the default for the bounded-window contract.
 */
export async function consumeStepUp(
  db: DbInstance,
  token: string,
): Promise<void> {
  await db.drizzle
    .update(db.schema.stepUpSessions)
    .set({ consumed: true })
    .where(eq(db.schema.stepUpSessions.id, token));
}

/**
 * Revoke all of a user's step-up sessions (e.g. on role downgrade / removal).
 */
export async function revokeUserStepUps(
  db: DbInstance,
  userId: string,
): Promise<void> {
  await db.drizzle
    .update(db.schema.stepUpSessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(db.schema.stepUpSessions.userId, userId),
        isNull(db.schema.stepUpSessions.revokedAt),
      ),
    );
}
