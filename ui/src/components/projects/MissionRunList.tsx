import { useMissionRuns } from '@/lib/hooks';
import type { MissionRunSummary } from '@/lib/api';
import { MissionRunCard } from './MissionRunCard';

/**
 * Authoritative Mission run list for Project Work.
 *
 * Fetches the scoped run list from the server and renders one durable card
 * per run. Each card has stable identity (run ID, mode, creation time),
 * textual authoritative lifecycle status, a chronological event timeline,
 * outcome links, and nonnegative budget state (VAL-RUN-014, VAL-RUN-015,
 * VAL-RUN-017, VAL-RUN-018, VAL-RUN-044, VAL-RUN-060, VAL-RUN-074,
 * VAL-RUN-095, VAL-RUN-098).
 *
 * The browser never infers or advances status; every visible field is
 * server-authoritative. Request text is tracked from the start mutation
 * and passed via the `requestTexts` prop; when unavailable, the card shows
 * the request content hash as a stable identifier.
 *
 * On refetch failure, previous data is preserved so existing cards remain
 * visible as stale rather than disappearing (VAL-RUN-131). A Retry button
 * is offered to re-request the exact company/project-scoped list.
 */
export function MissionRunList({
  companyId,
  projectId,
  requestTexts = {},
}: {
  companyId: string;
  projectId: string;
  requestTexts?: Record<string, string>;
}) {
  const runsQuery = useMissionRuns(companyId, projectId);
  const runs = runsQuery.data?.runs ?? [];

  // Loading state: only show when there is no previous data.
  if (runsQuery.isLoading && !runsQuery.data) {
    return (
      <section aria-label="Mission runs" className="mx-auto max-w-6xl">
        <h2 className="mb-3 text-sm font-semibold text-text-primary font-display">Mission runs</h2>
        <p className="text-sm text-text-muted" role="status">
          Loading runs…
        </p>
      </section>
    );
  }

  // Error state with no previous data: show error with Retry.
  if (runsQuery.isError && !runsQuery.data) {
    return (
      <section aria-label="Mission runs" className="mx-auto max-w-6xl">
        <h2 className="mb-3 text-sm font-semibold text-text-primary font-display">Mission runs</h2>
        <p className="text-sm text-error mb-2" role="alert">
          Could not load Mission runs. The runs may still be running — try refreshing.
        </p>
        <button
          type="button"
          onClick={() => runsQuery.refetch()}
          className="text-sm text-accent underline hover:text-accent/80 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none rounded"
          aria-label="Retry loading Mission runs"
        >
          Retry
        </button>
      </section>
    );
  }

  // Error state with previous data: show stale indicator + Retry above cards.
  const showStaleBanner = runsQuery.isError && !!runsQuery.data;

  if (runs.length === 0 && !showStaleBanner) {
    return null;
  }

  return (
    <section aria-label="Mission runs" className="mx-auto max-w-6xl">
      <h2 className="mb-3 text-sm font-semibold text-text-primary font-display">Mission runs</h2>
      {showStaleBanner && (
        <div className="mb-3 rounded-lg border border-warning/20 bg-warning/5 px-3 py-2">
          <p className="text-xs text-warning mb-1.5" role="status" aria-live="polite">
            Some data may be outdated due to a connection issue.
          </p>
          <button
            type="button"
            onClick={() => runsQuery.refetch()}
            className="text-xs text-accent underline hover:text-accent/80 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none rounded"
            aria-label="Retry loading Mission runs"
          >
            Retry
          </button>
        </div>
      )}
      <div className="space-y-4">
        {runs.map((run: MissionRunSummary) => (
          <MissionRunCard
            key={run.id}
            companyId={companyId}
            projectId={projectId}
            run={run}
            requestText={requestTexts[run.id]}
          />
        ))}
      </div>
    </section>
  );
}
