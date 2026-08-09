import { and, eq, desc } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';
import { AppError } from '../middleware/error-handler.js';
import type { DbInstance } from '../types.js';

/**
 * MFA service (M8 enterprise security).
 *
 * Enrolls and verifies TOTP MFA factors for a user. The TOTP secret is
 * generated with `otpauth`, stored base32-encoded in `user_mfa_factors`, and
 * verified against a ±1 step window to tolerate clock skew.
 *
 * In `local_trusted` mode the user id is `dev-user-000` or a created test
 * user. In Clerk mode it is the Clerk user id — Clerk MFA enrollment is the
 * production path; this server-side factor store is the dev/validation and
 * local-trusted surface, and is also the fallback when Clerk MFA is not
 * configured for a user.
 */

const TOTP_ISSUER = 'Eidolon';
const TOTP_WINDOW = 1; // ±1 step (30s) tolerance

function buildTotp(secret: Secret, label: string): TOTP {
  return new TOTP({
    issuer: TOTP_ISSUER,
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret,
  });
}

/**
 * Enroll a new TOTP factor for a user. Generates a secret, persists the
 * factor as `status=active`, and returns the otpauth URI + base32 secret so
 * the UI can render a QR code for the authenticator app.
 */
export async function enrollTotpFactor(
  db: DbInstance,
  userId: string,
  opts: { label?: string; companyId?: string | null; accountLabel?: string } = {},
): Promise<{
  factor: {
    id: string;
    userId: string;
    type: 'totp';
    label: string | null;
    status: 'active' | 'disabled';
    createdAt: string;
  };
  otpauthUri: string;
  secret: string;
}> {
  const secret = new Secret({ size: 20 });
  const label = opts.accountLabel ?? userId;
  const totp = buildTotp(secret, label);
  const [row] = await db.drizzle
    .insert(db.schema.userMfaFactors)
    .values({
      userId,
      companyId: opts.companyId ?? null,
      type: 'totp',
      secret: secret.base32,
      label: opts.label ?? null,
      status: 'active',
    })
    .returning();

  return {
    factor: {
      id: row.id,
      userId: row.userId,
      type: row.type,
      label: row.label,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    },
    otpauthUri: totp.toString(),
    secret: secret.base32,
  };
}

/**
 * List a user's MFA factors (active by default). Never returns the secret.
 */
export async function listMfaFactors(
  db: DbInstance,
  userId: string,
  opts: { includeDisabled?: boolean } = {},
): Promise<
  Array<{
    id: string;
    userId: string;
    type: 'totp';
    label: string | null;
    status: 'active' | 'disabled';
    createdAt: string;
  }>
> {
  const conditions = [eq(db.schema.userMfaFactors.userId, userId)];
  if (!opts.includeDisabled) {
    conditions.push(eq(db.schema.userMfaFactors.status, 'active'));
  }
  const rows = await db.drizzle
    .select()
    .from(db.schema.userMfaFactors)
    .where(and(...conditions))
    .orderBy(desc(db.schema.userMfaFactors.createdAt));

  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    type: r.type,
    label: r.label,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Verify a TOTP code against the user's active factors. Returns the matching
 * factor id on success, or null if no factor validates the code.
 */
export async function verifyTotpCode(
  db: DbInstance,
  userId: string,
  code: string,
): Promise<string | null> {
  const factors = await db.drizzle
    .select()
    .from(db.schema.userMfaFactors)
    .where(
      and(
        eq(db.schema.userMfaFactors.userId, userId),
        eq(db.schema.userMfaFactors.status, 'active'),
      ),
    );

  for (const factor of factors) {
    try {
      const secret = Secret.fromBase32(factor.secret);
      const totp = buildTotp(secret, factor.label ?? userId);
      const delta = totp.validate({ token: code, window: TOTP_WINDOW });
      if (delta !== null) {
        return factor.id;
      }
    } catch {
      // Skip malformed secrets rather than failing the whole verify.
      continue;
    }
  }
  return null;
}

/**
 * Disable (revoke) an MFA factor. Sets status=disabled; the row is retained
 * for audit history.
 */
export async function disableMfaFactor(
  db: DbInstance,
  userId: string,
  factorId: string,
): Promise<void> {
  const [updated] = await db.drizzle
    .update(db.schema.userMfaFactors)
    .set({ status: 'disabled', updatedAt: new Date() })
    .where(
      and(
        eq(db.schema.userMfaFactors.id, factorId),
        eq(db.schema.userMfaFactors.userId, userId),
      ),
    )
    .returning();

  if (!updated) {
    throw new AppError(404, 'MFA_FACTOR_NOT_FOUND', 'MFA factor not found for this user');
  }
}

/**
 * Returns true if the user has at least one active MFA factor enrolled.
 */
export async function hasActiveMfa(
  db: DbInstance,
  userId: string,
): Promise<boolean> {
  const factors = await listMfaFactors(db, userId);
  return factors.length > 0;
}

/**
 * Generate a valid TOTP code for a user's first active factor. Used by the
 * local-trusted validation helper so validators/agents can produce a valid
 * code without a real authenticator device. Guarded to `local_trusted` mode
 * by the caller (the route handler).
 */
export async function generateValidTotpCode(
  db: DbInstance,
  userId: string,
): Promise<string | null> {
  const factors = await db.drizzle
    .select()
    .from(db.schema.userMfaFactors)
    .where(
      and(
        eq(db.schema.userMfaFactors.userId, userId),
        eq(db.schema.userMfaFactors.status, 'active'),
      ),
    )
    .orderBy(desc(db.schema.userMfaFactors.createdAt))
    .limit(1);

  if (factors.length === 0) return null;
  const factor = factors[0];
  const secret = Secret.fromBase32(factor.secret);
  const totp = buildTotp(secret, factor.label ?? userId);
  return totp.generate();
}
