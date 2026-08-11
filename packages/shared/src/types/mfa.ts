import { z } from 'zod';

/**
 * MFA + step-up authentication schemas (M8 enterprise security).
 *
 * These describe the request/response shapes for the MFA enrollment,
 * challenge, and step-up re-authentication surfaces. The server validates
 * incoming bodies against these and the UI consumes the response shapes.
 */

/** Supported MFA factor types. M8 ships TOTP. */
export const MfaFactorTypeSchema = z.enum(['totp']);
export type MfaFactorType = z.infer<typeof MfaFactorTypeSchema>;

/** MFA factor lifecycle status. */
export const MfaFactorStatusSchema = z.enum(['active', 'disabled']);
export type MfaFactorStatus = z.infer<typeof MfaFactorStatusSchema>;

/** Sensitive-operation scopes that a step-up session can authorize. */
export const StepUpScopeSchema = z.enum([
  'company_delete',
  'artifact_permanent_delete',
  'artifact_transfer',
  'sensitive_action',
]);
export type StepUpScope = z.infer<typeof StepUpScopeSchema>;

/** Body for enrolling a new TOTP MFA factor. */
export const EnrollMfaBodySchema = z.object({
  label: z.string().trim().max(120).optional(),
});
export type EnrollMfaBody = z.infer<typeof EnrollMfaBodySchema>;

/** Body for verifying a TOTP code (challenge or step-up grant). */
export const VerifyMfaBodySchema = z.object({
  code: z.string().trim().min(4).max(10),
});
export type VerifyMfaBody = z.infer<typeof VerifyMfaBodySchema>;

/** Body for requesting a step-up session after a successful MFA verify. */
export const RequestStepUpBodySchema = z.object({
  code: z.string().trim().min(4).max(10),
  scope: StepUpScopeSchema,
});
export type RequestStepUpBody = z.infer<typeof RequestStepUpBodySchema>;

/** A persisted MFA factor as returned to the client (never includes secret). */
export const MfaFactorSchema = z.object({
  id: z.string(),
  userId: z.string(),
  type: MfaFactorTypeSchema,
  label: z.string().nullable(),
  status: MfaFactorStatusSchema,
  createdAt: z.string(),
});
export type MfaFactor = z.infer<typeof MfaFactorSchema>;

/** Enrollment response: the new factor + the otpauth URI / secret for QR setup. */
export const MfaEnrollmentSchema = z.object({
  factor: MfaFactorSchema,
  otpauthUri: z.string(),
  secret: z.string(),
});
export type MfaEnrollment = z.infer<typeof MfaEnrollmentSchema>;

/** Step-up session response: the bearer token + expiry. */
export const StepUpSessionSchema = z.object({
  stepUpToken: z.string(),
  scope: StepUpScopeSchema,
  grantedAt: z.string(),
  expiresAt: z.string(),
});
export type StepUpSession = z.infer<typeof StepUpSessionSchema>;
