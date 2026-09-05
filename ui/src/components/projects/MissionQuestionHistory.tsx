import { useMissionQuestionSets } from '@/lib/hooks';
import type { MissionQuestionSetHistoryEntry } from '@/lib/api';
import { formatAnswerValue, answerForKey } from './mission-question-helpers';

/**
 * Reviewable, non-editable ordered record of a run's question sets and
 * accepted answers (VAL-MODEQ-110). Renders immutable definitions and
 * accepted answer values in persisted order; unsubmitted defaults are never
 * shown as submitted values. Invalidation is shown as a closed,
 * non-actionable entry. Composed into `MissionRunCard` below the active
 * card so users can review history without editing it.
 */
export function MissionQuestionHistory({
  companyId,
  projectId,
  runId,
}: {
  companyId: string;
  projectId: string;
  runId: string;
}) {
  const query = useMissionQuestionSets(companyId, projectId, runId);
  const sets = query.data?.questionSets ?? [];
  if (sets.length === 0) {
    return null;
  }
  return (
    <section
      aria-labelledby={`question-history-heading-${runId}`}
      className="mt-3 rounded-xl border border-white/[0.06] p-3 w-full max-w-full break-words"
    >
      <h4
        id={`question-history-heading-${runId}`}
        className="mb-2 text-sm font-semibold text-text-primary font-display"
      >
        Question history
      </h4>
      <ol className="space-y-3">
        {sets.map((entry) => (
          <HistoryEntry key={entry.id} entry={entry} />
        ))}
      </ol>
    </section>
  );
}

function HistoryEntry({ entry }: { entry: MissionQuestionSetHistoryEntry }) {
  const invalidated = entry.status === 'invalidated';
  const answered = entry.status === 'answered';
  const ordered = [...entry.questions].sort((a, b) => a.order - b.order);
  return (
    <li className="rounded-lg border border-white/[0.06] p-3">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-text-secondary">
          Set {entry.ordinal} · version {entry.version}
        </span>
        {answered && (
          <span className="text-[10px] uppercase tracking-wide text-success">Answered</span>
        )}
        {invalidated && (
          <span className="text-[10px] uppercase tracking-wide text-warning">Invalidated</span>
        )}
      </div>
      {invalidated && entry.invalidationReason && (
        <p className="mb-1.5 text-xs text-warning break-words">
          Invalidated: {entry.invalidationReason}
        </p>
      )}
      <dl className="space-y-1.5">
        {ordered.map((q) => {
          const answer = answerForKey(entry.answers, q.questionKey);
          const display = answer ? formatAnswerValue(answer.value, q) : '—';
          const redacted =
            answer !== undefined &&
            typeof answer.value === 'object' &&
            answer.value !== null &&
            'redacted' in answer.value;
          return (
            <div key={q.questionKey} className="grid grid-cols-[auto_1fr] gap-x-2">
              <dt className="text-xs font-medium text-text-secondary break-words">{q.label}</dt>
              <dd className="text-xs text-text-primary break-words">
                {display}
                {redacted && <span className="ml-1 text-[10px] text-text-muted">(restricted)</span>}
              </dd>
            </div>
          );
        })}
      </dl>
    </li>
  );
}
