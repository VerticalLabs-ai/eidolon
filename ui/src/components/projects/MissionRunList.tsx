import { useMissionRunsPaginated } from '@/lib/hooks';
import type { MissionRunSummary } from '@/lib/api';
import { MissionRunCard } from './MissionRunCard';

/**
 * Flatten the paginated `useInfiniteQuery` pages into a single ordered run
 * list, deduplicating by run ID. Each page is ordered by (createdAt DESC,
 * id DESC) and the opaque cursor anchors the result set so concurrent
 * insertions or status changes do not duplicate or skip runs
 * (VAL-RUN-132).
 */
function flattenPages(
  pages: { runs: MissionRunSummary[]; nextCursor: string | null }[],
): MissionRunSummary[] {
  const seen = new Set<string>();
  const runs: MissionRunSummary[] = [];
  for (const page of pages) {
    for (const run of page.runs) {
      if (!seen.has(run.id)) {
        seen.add(run.id);
        runs.push(run);
      }
    }
  }
  return runs;
}

/**
 * Authoritative Mission run list for Project Work.
 *
 * Fetches the scoped run list from the server with cursor-based pagination
 * and renders one durable card per run. Each card has stable identity
 * (run ID, mode, creation time), textual authoritative lifecycle status, a
 * chronological event timeline, outcome links, and nonnegative budget state
 * (VAL-RUN-014, VAL-RUN-015, VAL-RUN-017, VAL-RUN-018, VAL-RUN-044,
 * VAL-RUN-060, VAL-RUN-074, VAL-RUN-095, VAL-RUN-098).
 *
 * The browser never infers or advances status; every visible field is
 * server-authoritative. Request text is tracked from the start mutation
 * and passed via the `requestTexts` prop.
 *
 * A "Load more" control fetches the next page using the opaque cursor so a
 * keyboard user can discover historical Missions beyond page one and return
 * with list position preserved (VAL-RUN-132).
 *
 * When `highlightRunId` is set (from a deep-link `?run=` query param), the
 * matching card receives a highlight indicator and scroll anchor
 * (VAL-RUN-097).
 *
 * On refetch failure, previous data is preserved so existing cards remain
 * visible as stale rather than disappearing (VAL-RUN-131).
 */
export function MissionRunList({
  companyId,
  projectId,
  requestTexts = {},
  highlightRunId,
}: {
  companyId: string;
  projectId: string;
  requestTexts?: Record<string, string>;
  /** Run ID to highlight from a deep link (VAL-RUN-097). */
  highlightRunId?: string;
}) {
  const runsQuery = useMissionRunsPaginated(companyId, projectId);
  const runs = flattenPages(runsQuery.data?.pages ?? []);

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

  const hasNextPage = runsQuery.hasNextPage;
  const isFetchingNextPage = runsQuery.isFetchingNextPage;

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
            highlighted={highlightRunId === run.id}
          />
        ))}
      </div>
      {/* Historical pagination: Load more (VAL-RUN-132) */}
      {hasNextPage && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={() => runsQuery.fetchNextPage()}
            disabled={isFetchingNextPage}
            aria-label={isFetchingNextPage ? 'Loading more runs' : 'Load more runs'}
            className="rounded-lg border border-white/[0.08] bg-white/[0.025] px-4 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/[0.06] focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
          >
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </section>
  );
}
