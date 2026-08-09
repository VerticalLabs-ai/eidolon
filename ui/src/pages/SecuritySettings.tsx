import { useState, useEffect, useCallback } from "react";
import {
  ShieldCheck,
  KeyRound,
  Plus,
  Trash2,
  Loader2,
  CheckCircle2,
  Smartphone,
  AlertTriangle,
} from "lucide-react";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { PageTransition } from "@/components/ui/PageTransition";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import {
  enrollMfaFactor,
  listMfaFactors,
  disableMfaFactor,
  type MfaFactor,
  type MfaEnrollment,
} from "@/lib/api";

/**
 * Security & MFA settings page (M8 enterprise security).
 *
 * VAL-SEC-001: a user enrolls a TOTP MFA factor from their account/security
 * settings; after enrollment the factor is active + listed. This page is the
 * enrollment surface and the factor-management list.
 */
export function SecuritySettings() {
  const queryClient = useQueryClient();

  const { data: factorsRes, isLoading } = useQuery({
    queryKey: ["mfa-factors"],
    queryFn: () => listMfaFactors(),
  });
  const factors: MfaFactor[] = factorsRes?.data ?? [];

  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollLabel, setEnrollLabel] = useState("");
  const [enrollment, setEnrollment] = useState<MfaEnrollment | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const enrollMutation = useMutation({
    mutationFn: (label?: string) => enrollMfaFactor(label),
  });

  const disableMutation = useMutation({
    mutationFn: (factorId: string) => disableMfaFactor(factorId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mfa-factors"] });
    },
  });

  async function handleEnroll(e: React.FormEvent) {
    e.preventDefault();
    setEnrolling(true);
    setEnrollError(null);
    try {
      const res = await enrollMutation.mutateAsync(enrollLabel.trim() || undefined);
      setEnrollment(res.data);
      queryClient.invalidateQueries({ queryKey: ["mfa-factors"] });
    } catch (err: any) {
      setEnrollError(err?.message ?? "Enrollment failed");
    } finally {
      setEnrolling(false);
    }
  }

  function closeEnroll() {
    setEnrollOpen(false);
    setEnrollment(null);
    setEnrollLabel("");
    setEnrollError(null);
    setCopied(false);
  }

  async function copySecret() {
    if (!enrollment) return;
    try {
      await navigator.clipboard.writeText(enrollment.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable; ignore.
    }
  }

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["mfa-factors"] });
  }, [queryClient]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <PageTransition>
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-6 w-6 text-neon-cyan" />
          <div>
            <h1 className="text-xl font-semibold font-display">Security</h1>
            <p className="text-sm text-text-secondary">
              Manage multi-factor authentication and sensitive-action
              protections.
            </p>
          </div>
        </div>

        {/* MFA factors card */}
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-text-secondary" />
              <h2 className="text-base font-semibold">Authenticator factors</h2>
            </div>
            <Button
              size="sm"
              onClick={() => {
                setEnrollOpen(true);
                setEnrollment(null);
              }}
              icon={<Plus className="h-3.5 w-3.5" />}
            >
              Add factor
            </Button>
          </div>

          <div className="mt-4 space-y-2">
            {isLoading ? (
              <div className="flex items-center gap-2 text-sm text-text-secondary">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading factors…
              </div>
            ) : factors.length === 0 ? (
              <div className="rounded-lg border border-dashed border-white/[0.08] p-6 text-center">
                <Smartphone className="mx-auto mb-2 h-8 w-8 text-text-secondary/60" />
                <p className="text-sm text-text-secondary">
                  No MFA factors enrolled. Add an authenticator to enable
                  step-up protection for sensitive actions.
                </p>
              </div>
            ) : (
              factors.map((factor) => (
                <div
                  key={factor.id}
                  className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5"
                >
                  <div className="flex items-center gap-3">
                    <Smartphone className="h-4 w-4 text-neon-cyan" />
                    <div>
                      <div className="text-sm font-medium">
                        {factor.label ?? "TOTP authenticator"}
                      </div>
                      <div className="text-xs text-text-secondary">
                        TOTP · enrolled{" "}
                        {new Date(factor.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="success">
                      <CheckCircle2 className="mr-1 h-3 w-3" />
                      Active
                    </Badge>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => disableMutation.mutate(factor.id)}
                      loading={disableMutation.isPending}
                      icon={<Trash2 className="h-3 w-3" />}
                      aria-label={`Remove factor ${factor.label ?? "TOTP"}`}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>

        {/* Step-up protection info card */}
        <Card className="p-5">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-text-secondary" />
            <h2 className="text-base font-semibold">Step-up protection</h2>
          </div>
          <p className="mt-2 text-sm text-text-secondary">
            Sensitive operations — permanently deleting a company, permanently
            deleting an artifact, or transferring artifact ownership — require
            step-up re-authentication. Completing an MFA challenge grants a
            short-lived authorization window (5 minutes) for the operation.
          </p>
          <ul className="mt-3 space-y-1.5 text-sm text-text-secondary">
            <li className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-neon-cyan" />
              <span>Permanent deletion is blocked until you verify an MFA code.</span>
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-neon-cyan" />
              <span>Dismissing the challenge leaves the resource unchanged.</span>
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-neon-cyan" />
              <span>
                Role downgrades or company removal invalidate the session for
                now-disallowed operations on the next request.
              </span>
            </li>
          </ul>
        </Card>

        {/* Enrollment modal */}
        <Modal
          open={enrollOpen}
          onClose={closeEnroll}
          title={enrollment ? "Add to your authenticator" : "Enroll MFA factor"}
          dismissible={!enrolling}
        >
          {!enrollment ? (
            <form onSubmit={handleEnroll} className="space-y-4">
              <div>
                <label
                  htmlFor="mfa-label"
                  className="mb-1.5 block text-xs font-medium text-text-secondary"
                >
                  Label (optional)
                </label>
                <Input
                  id="mfa-label"
                  value={enrollLabel}
                  onChange={(e) => setEnrollLabel(e.target.value)}
                  placeholder="e.g. Work phone"
                  disabled={enrolling}
                  maxLength={120}
                />
              </div>
              {enrollError && (
                <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-sm text-red-300">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{enrollError}</span>
                </div>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={closeEnroll}
                  disabled={enrolling}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={enrolling}>
                  {enrolling ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Enrolling…
                    </>
                  ) : (
                    "Generate secret"
                  )}
                </Button>
              </div>
            </form>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-text-secondary">
                Scan the setup key below in your authenticator app (e.g. Authy,
                Google Authenticator, 1Password). Then return here — the factor
                is already active.
              </p>
              <div className="rounded-lg border border-white/[0.06] bg-black/30 p-3">
                <div className="text-xs font-medium text-text-secondary">
                  Secret key
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <code className="flex-1 break-all font-mono text-sm text-neon-cyan">
                    {enrollment.secret}
                  </code>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={copySecret}
                    icon={
                      copied ? (
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      ) : undefined
                    }
                  >
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
              </div>
              <div className="rounded-lg border border-white/[0.06] bg-black/30 p-3">
                <div className="text-xs font-medium text-text-secondary">
                  otpauth URI
                </div>
                <code className="mt-1 block break-all font-mono text-xs text-text-secondary">
                  {enrollment.otpauthUri}
                </code>
              </div>
              <div className="flex items-center gap-2 rounded-lg border border-neon-cyan/20 bg-neon-cyan/5 p-2.5 text-sm">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-neon-cyan" />
                <span>
                  Factor <strong>{enrollment.factor.label ?? "TOTP"}</strong> is
                  active and listed in your security settings.
                </span>
              </div>
              <div className="flex justify-end pt-1">
                <Button onClick={closeEnroll}>Done</Button>
              </div>
            </div>
          )}
        </Modal>
      </div>
    </PageTransition>
  );
}
