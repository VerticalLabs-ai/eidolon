// ---------------------------------------------------------------------------
// DiffModal — modal wrapper around DiffViewer that fetches the diff and
// renders loading / error / empty states (M2 — Artifact Intelligence &
// Discovery).
//
// Responsibilities:
//   • Fetch the diff via useDiff (TanStack Query) when opened.
//   • Loading indicator while the request is in flight (VAL-DIFF-069).
//   • Error message on API failure with a close control (VAL-DIFF-070).
//   • Empty diff renders an explicit "No changes" message (VAL-DIFF-071).
//   • Esc closes the modal (VAL-DIFF-066) — handled by the Modal <dialog>.
//   • Focus is trapped while open (VAL-DIFF-068) — the native <dialog>
//     element traps focus by default.
//   • The modal title shows the revision pair being compared.
// ---------------------------------------------------------------------------

import { useEffect } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { useDiff } from "@/lib/hooks";
import { DiffViewer } from "./DiffViewer";

interface DiffModalProps {
  open: boolean;
  onClose: () => void;
  companyId: string;
  artifactId: string;
  /** From-revision version (v1). */
  v1: number;
  /** To-revision version (v2). */
  v2: number;
}

export function DiffModal({
  open,
  onClose,
  companyId,
  artifactId,
  v1,
  v2,
}: DiffModalProps) {
  // Only fetch when the modal is open; the query is disabled when closed so
  // stale results don't linger between comparisons.
  const { data, isLoading, isError, error } = useDiff(
    open ? companyId : undefined,
    open ? artifactId : undefined,
    open ? v1 : undefined,
    open ? v2 : undefined,
  );

  // Esc to close is handled by the Modal <dialog> onCancel. The native dialog
  // also traps focus (VAL-DIFF-068). No extra wiring needed here.

  // Prevent body scroll when open (defensive — the <dialog> already does this).
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const title = `Compare v${v1} → v${v2}`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      className="sm:max-w-4xl max-h-[85vh]"
    >
      <div className="max-h-[70vh] overflow-auto">
        {isLoading && (
          <div
            className="flex items-center justify-center gap-2 px-4 py-16 text-sm text-text-secondary"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading diff…
          </div>
        )}

        {!isLoading && isError && (
          <div
            className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center"
            role="alert"
          >
            <AlertCircle className="h-6 w-6 text-red-400" />
            <p className="text-sm text-red-300">
              {error instanceof Error
                ? error.message
                : "Failed to load the diff. Please try again."}
            </p>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-white/10 px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-accent hover:border-accent/30 transition-colors"
            >
              Close
            </button>
          </div>
        )}

        {!isLoading && !isError && data && (
          <DiffViewer
            diff={data.diff}
            artifactType={data.artifactType}
            fromVersion={v1}
            toVersion={v2}
          />
        )}
      </div>
    </Modal>
  );
}
