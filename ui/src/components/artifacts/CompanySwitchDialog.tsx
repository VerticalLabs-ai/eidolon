import { AlertTriangle } from "lucide-react";

interface CompanySwitchDialogProps {
  open: boolean;
  saving?: boolean;
  error?: string | null;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
}

/**
 * Confirmation dialog shown when a company change is attempted while an
 * artifact editor has unsaved (dirty) changes. The dialog stays mounted
 * on save failure so the user can retry or discard.
 */
export function CompanySwitchDialog({
  open,
  saving,
  error,
  onCancel,
  onDiscard,
  onSave,
}: CompanySwitchDialogProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="company-switch-title"
    >
      <div className="w-full max-w-sm rounded-lg border border-white/[0.1] bg-surface p-5 shadow-2xl">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div>
            <h2
              id="company-switch-title"
              className="text-sm font-semibold text-text-primary"
            >
              Unsaved artifact changes
            </h2>
            <p className="mt-2 text-xs text-text-secondary">
              Save your draft before switching companies?
            </p>
          </div>
        </div>
        {error && (
          <div
            role="alert"
            className="mt-3 rounded-md border border-error/20 bg-error/10 px-3 py-2 text-xs text-error"
          >
            {error}
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="rounded px-3 py-2 text-xs text-text-secondary transition-colors hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded px-3 py-2 text-xs text-warning transition-colors hover:bg-warning/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/40"
            onClick={onDiscard}
            disabled={saving}
          >
            Discard
          </button>
          <button
            type="button"
            disabled={saving}
            className="rounded bg-accent px-3 py-2 text-xs font-medium text-surface transition-opacity disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onClick={onSave}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
