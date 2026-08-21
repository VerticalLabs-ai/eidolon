import { useMissionRuns } from '@/lib/hooks';
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

  if (runsQuery.isLoading) {
    return (
      <section aria-label="Mission runs" className="mx-auto max-w-6xl">
        <h2 className="mb-3 text-sm font-semibold text-text-primary font-display">Mission runs</h2>
        <p className="text-sm text-text-muted" role="status">
          Loading runs…
        </p>
      </section>
    );
  }

  if (runsQuery.isError) {
    return (
      <section aria-label="Mission runs" className="mx-auto max-w-6xl">
        <h2 className="mb-3 text-sm font-semibold text-text-primary font-display">Mission runs</h2>
        <p className="text-sm text-error" role="alert">
          Could not load Mission runs. The runs may still be running — try refreshing.
        </p>
      </section>
    );
  }

  if (runs.length === 0) {
    return null;
  }

  return (
    <section aria-label="Mission runs" className="mx-auto max-w-6xl">
      <h2 className="mb-3 text-sm font-semibold text-text-primary font-display">Mission runs</h2>
      <div className="space-y-4">
        {runs.map((run) => (
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
