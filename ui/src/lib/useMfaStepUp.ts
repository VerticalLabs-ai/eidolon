import { useCallback, useRef, useState } from "react";
import { requestStepUp, ApiError, type StepUpSession } from "./api";

/**
 * Returns true when `err` is a 403 MFA_STEP_UP_REQUIRED error thrown by the
 * API client — i.e. a sensitive action was attempted without a valid step-up
 * session. Callers catch this and open the MFA challenge modal.
 */
export function isMfaStepUpRequired(err: unknown): err is ApiError {
  return (
    err instanceof ApiError &&
    err.status === 403 &&
    (err.body as { code?: string } | null | undefined)?.code ===
      "MFA_STEP_UP_REQUIRED"
  );
}

interface ChallengeOptions {
  /** Human-readable description of the sensitive action being gated. */
  actionLabel: string;
  /** Step-up scope matching the gated server route. */
  scope: StepUpSession["scope"];
  /** Optional company context for the step-up session. */
  companyId?: string;
  /**
   * Called with the step-up token after the user enters a valid TOTP code
   * and the server grants a step-up session. The caller retries the gated
   * operation with the token. Resolving completes the challenge (modal
   * closes); rejecting surfaces the error inline in the modal.
   */
  onStepUp: (stepUpToken: string) => Promise<void>;
}

/**
 * Reusable hook backing {@link MfaChallengeModal} for step-up
 * re-authentication (M8 enterprise security, VAL-SEC-002/003/008).
 *
 * Usage:
 *   const mfa = useMfaStepUp();
 *   ...
 *   try {
 *     await deleteCompany({ id, hard: true });
 *   } catch (err) {
 *     if (isMfaStepUpRequired(err)) {
 *       mfa.challenge({
 *         actionLabel: `Permanently delete "${name}"`,
 *         scope: "company_delete",
 *         companyId,
 *         onStepUp: async (token) => {
 *           await deleteCompany({ id, hard: true, stepUpToken: token });
 *           refresh();
 *         },
 *       });
 *     }
 *   }
 *   ...
 *   <MfaChallengeModal {...mfa.modalProps} />
 *
 * Dismissing the modal (onClose) abandons the sensitive action — no
 * mutation occurs, satisfying VAL-SEC-003.
 */
export function useMfaStepUp() {
  const [open, setOpen] = useState(false);
  const [actionLabel, setActionLabel] = useState("");
  const [scope, setScope] = useState<StepUpSession["scope"]>(
    "sensitive_action",
  );
  const companyIdRef = useRef<string | undefined>(undefined);
  const scopeRef = useRef<StepUpSession["scope"]>("sensitive_action");
  const onStepUpRef = useRef<
    ((stepUpToken: string) => Promise<void>) | null
  >(null);

  const challenge = useCallback((opts: ChallengeOptions) => {
    setActionLabel(opts.actionLabel);
    setScope(opts.scope);
    scopeRef.current = opts.scope;
    companyIdRef.current = opts.companyId;
    onStepUpRef.current = opts.onStepUp;
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    onStepUpRef.current = null;
  }, []);

  const onVerify = useCallback(async (code: string) => {
    const res = await requestStepUp(
      code,
      scopeRef.current,
      companyIdRef.current,
    );
    const token = res.data.stepUpToken;
    if (onStepUpRef.current) {
      await onStepUpRef.current(token);
    }
    setOpen(false);
    onStepUpRef.current = null;
  }, []);

  return {
    challenge,
    modalProps: {
      open,
      onClose: close,
      actionLabel,
      onVerify,
    },
  };
}
