import { useRef, useState } from 'react';
import { Download, Loader2, CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-react';
import { downloadArtifactRevisionExport } from '@/lib/api';

/**
 * MissionArtifactExport — accessible, recoverable exact-revision export
 * controls.
 *
 * (feature m5-f15-stale-evidence-export-ui; VAL-RES-103)
 *
 * Export controls name the exact revision and format, work by keyboard,
 * expose pending/completed status without duplicate download, and show an
 * alert plus Retry on failure while remaining pinned to that revision.
 *
 * The browser never invents export state; every status transition is
 * backed by the actual download response. A pending export disables the
 * controls so a second activation does not trigger a duplicate download.
 * On failure, an alert surfaces the error and a Retry button re-issues
 * the exact same revision/format request.
 *
 * Accessibility:
 * - Each export button has an explicit accessible name including revision
 *   and format.
 * - Status is conveyed with text + icon, never color alone.
 * - Errors use `role="alert"`.
 * - Controls are keyboard operable (Enter/Space).
 * - The layout reflows at narrow mobile viewports.
 */

export type ExportFormat = 'markdown' | 'html';

type ExportState = 'idle' | 'pending' | 'completed' | 'failed';

interface FormatState {
  state: ExportState;
  errorMessage?: string;
}

/**
 * Render export controls for an exact artifact revision. Two format
 * buttons (Markdown, HTML) each with independent pending/completed/error
 * states. A pending export disables its button to prevent duplicate
 * downloads. On failure, an alert and Retry button appear, pinned to the
 * same revision and format.
 */
export function MissionArtifactExport({
  companyId,
  projectId,
  artifactId,
  artifactVersion,
}: {
  companyId: string;
  projectId: string;
  artifactId: string;
  artifactVersion: number;
}) {
  const [mdState, setMdState] = useState<FormatState>({ state: 'idle' });
  const [htmlState, setHtmlState] = useState<FormatState>({ state: 'idle' });
  // Track in-flight request to prevent duplicate downloads.
  const inFlightRef = useRef<Set<ExportFormat>>(new Set());

  async function handleExport(format: ExportFormat) {
    // Prevent duplicate download while a request is in-flight.
    if (inFlightRef.current.has(format)) {
      return;
    }
    inFlightRef.current.add(format);
    const setState = format === 'markdown' ? setMdState : setHtmlState;
    setState({ state: 'pending' });
    try {
      await downloadArtifactRevisionExport(
        companyId,
        projectId,
        artifactId,
        artifactVersion,
        format,
      );
      setState({ state: 'completed' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Export failed. Please try again.';
      setState({ state: 'failed', errorMessage: message });
    } finally {
      inFlightRef.current.delete(format);
    }
  }

  return (
    <section
      className="mb-3 w-full max-w-full break-words"
      aria-labelledby={`artifact-export-heading-${artifactId}-${artifactVersion}`}
      data-testid="mission-artifact-export"
    >
      <h4
        id={`artifact-export-heading-${artifactId}-${artifactVersion}`}
        className="text-xs font-medium text-text-secondary mb-1"
      >
        Export — Version {artifactVersion}
      </h4>

      <div className="flex flex-wrap items-center gap-2">
        <ExportButton
          format="markdown"
          artifactVersion={artifactVersion}
          state={mdState}
          onExport={() => handleExport('markdown')}
        />
        <ExportButton
          format="html"
          artifactVersion={artifactVersion}
          state={htmlState}
          onExport={() => handleExport('html')}
        />
      </div>
    </section>
  );
}

/** A single format export button with status and retry. */
function ExportButton({
  format,
  artifactVersion,
  state,
  onExport,
}: {
  format: ExportFormat;
  artifactVersion: number;
  state: FormatState;
  onExport: () => void;
}) {
  const formatLabel = format === 'markdown' ? 'Markdown' : 'HTML';
  const isPending = state.state === 'pending';
  const isCompleted = state.state === 'completed';
  const isFailed = state.state === 'failed';

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={onExport}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onExport();
          }
        }}
        disabled={isPending}
        aria-label={`Export version ${artifactVersion} as ${formatLabel}`}
        aria-busy={isPending}
        data-testid={`export-${format}-button`}
        className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
      >
        {isPending ? (
          <Loader2
            className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : isCompleted ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden="true" />
        ) : isFailed ? (
          <AlertTriangle className="h-3.5 w-3.5 text-error" aria-hidden="true" />
        ) : (
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        {formatLabel}
      </button>

      {/* Pending status (text + icon, never color alone) */}
      {isPending && (
        <p
          className="text-xs text-text-muted"
          aria-live="polite"
          data-testid={`export-${format}-pending`}
        >
          Exporting…
        </p>
      )}

      {/* Completed status */}
      {isCompleted && (
        <p
          className="text-xs text-success flex items-center gap-1"
          aria-live="polite"
          data-testid={`export-${format}-completed`}
        >
          <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
          Downloaded
        </p>
      )}

      {/* Failure: alert + retry, pinned to the same revision */}
      {isFailed && (
        <div role="alert" className="flex flex-col gap-1" data-testid={`export-${format}-error`}>
          <p className="text-xs text-error flex items-center gap-1 break-words">
            <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
            {state.errorMessage ?? 'Export failed.'}
          </p>
          <button
            type="button"
            onClick={onExport}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onExport();
              }
            }}
            aria-label={`Retry ${formatLabel} export for version ${artifactVersion}`}
            data-testid={`export-${format}-retry`}
            className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-error/30 bg-error/10 px-3 py-1 text-xs font-medium text-error transition-colors hover:bg-error/20 focus-visible:ring-2 focus-visible:ring-error/40 focus-visible:outline-none motion-reduce:transition-none"
          >
            <RefreshCw className="h-3 w-3" aria-hidden="true" />
            Retry {formatLabel}
          </button>
        </div>
      )}
    </div>
  );
}
