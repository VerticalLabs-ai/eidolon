import { useEffect, useState } from "react";
import { ShieldCheck, Loader2, AlertTriangle } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ApiError, generateValidMfaCode } from "@/lib/api";

interface MfaChallengeModalProps {
  open: boolean;
  onClose: () => void;
  /** Human-readable description of the sensitive action being gated. */
  actionLabel: string;
  /**
   * Called with a valid TOTP code after the user submits. The caller is
   * responsible for invoking the gated operation (e.g. requesting a step-up
   * session then performing the action). Resolving with a value completes
   * the challenge; rejecting surfaces the error inline.
   */
  onVerify: (code: string) => Promise<void>;
  /** When true, a "dev: autofill code" button is shown (local_trusted only). */
  showDevAutofill?: boolean;
}

/**
 * MFA challenge / step-up re-authentication modal (M8 enterprise security).
 *
 * Used to gate sensitive actions (company permanent delete, artifact
 * permanent delete, ownership transfer) behind an MFA challenge. The user
 * enters a TOTP code; a valid code proceeds, an invalid code is rejected
 * inline, and dismissing the modal leaves the protected resource unchanged
 * (VAL-SEC-002/003).
 */
export function MfaChallengeModal({
  open,
  onClose,
  actionLabel,
  onVerify,
  showDevAutofill = true,
}: MfaChallengeModalProps) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setCode("");
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim() || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await onVerify(code.trim());
      // Success — the caller closes the modal.
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.body && typeof err.body === "object" && "message" in err.body
            ? String((err.body as any).message)
            : err.message
          : "Verification failed";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDevAutofill() {
    try {
      const res = await generateValidMfaCode();
      setCode(res.data.code);
    } catch {
      setError("No active MFA factor found. Enroll a factor first.");
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="MFA Challenge" dismissible={!submitting}>
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-neon-cyan" />
          <p className="text-sm text-text-secondary">
            This action requires step-up re-authentication.
            <span className="block text-text-primary font-medium mt-1">
              {actionLabel}
            </span>
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="mfa-code"
              className="mb-1.5 block text-xs font-medium text-text-secondary"
            >
              Authenticator code
            </label>
            <Input
              id="mfa-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="000000"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={10}
              autoFocus
              disabled={submitting}
              aria-invalid={!!error}
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-sm text-red-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center justify-between gap-3 pt-1">
            {showDevAutofill ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleDevAutofill}
                disabled={submitting}
              >
                Dev: autofill code
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={onClose}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!code.trim() || submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Verifying…
                  </>
                ) : (
                  "Verify"
                )}
              </Button>
            </div>
          </div>
        </form>
      </div>
    </Modal>
  );
}
