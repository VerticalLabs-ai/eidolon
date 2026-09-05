import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAnswerMissionRun } from '@/lib/hooks';
import type { MissionCurrentQuestionSet, MissionQuestionDefinition } from '@/lib/api';
import { HelpCircle, Send, Lock } from 'lucide-react';
import { buildDraftKey, readDraft, writeDraft, clearDraft } from '@/lib/mission-drafts';
import {
  makeAnswerIdempotencyKey,
  defaultDraftFor,
  draftDiffersFromDefault,
  mapAnswerValidationDetails,
  type DraftMap,
  type FieldErrors,
} from './mission-question-helpers';
import { QuestionControl, type InvalidRefRegistrar } from './MissionQuestionControls';

/**
 * Typed Mission question cards — the active card for a run's current open
 * (or invalidated) question set.
 *
 * Renders every supported question type in its persisted stable order with
 * exact help/default semantics, supports explicit correction while a set
 * remains open (edits are browser-local drafts until one atomic
 * submission), and closes an invalidated set as non-actionable.
 *
 * Authority: the question definitions, defaults, validation, set id/version
 * all come from the server snapshot. The browser never records an answer,
 * event, or resume context until the server applies one complete atomic
 * submission (VAL-MODEQ-068, VAL-MODEQ-109).
 *
 * Fulfils: VAL-MODEQ-045 (stable order), VAL-MODEQ-051 (scale labels),
 * VAL-MODEQ-053 (help), VAL-MODEQ-054 (persisted defaults / local drafts),
 * VAL-MODEQ-068 (explicit correction while open), VAL-MODEQ-076
 * (invalidated set is closed).
 */
export function MissionQuestionCard({
  companyId,
  projectId,
  runId,
  questionSet,
  stateVersion,
  principalId,
}: {
  companyId: string;
  projectId: string;
  runId: string;
  questionSet: MissionCurrentQuestionSet;
  /** Current authoritative run state version, sent as `If-Match`. */
  stateVersion?: number;
  /** Authenticated principal ID for browser-local draft scoping
   * (VAL-MODEQ-134). Drafts are keyed by principal so a different user
   * cannot read another's unsubmitted answers. */
  principalId: string;
}) {
  const invalidated = questionSet.status === 'invalidated';
  const answered = questionSet.status === 'answered';
  const qc = useQueryClient();

  // Persisted order is authoritative (VAL-MODEQ-045).
  const orderedQuestions = useMemo(
    () => [...questionSet.questions].sort((a, b) => a.order - b.order),
    [questionSet.questions],
  );

  // sessionStorage draft key — scoped by principal, company, project, run,
  // set, and version so a draft never crosses identities or set versions
  // (VAL-MODEQ-134). Unsubmitted drafts survive same-tab reload/navigation
  // and are cleared on answer, invalidation, or terminalization.
  const draftKey = useMemo(
    () =>
      buildDraftKey({
        principalId,
        scope: 'question-answer',
        companyId,
        projectId,
        runId,
        cardVersion: `${questionSet.id}:v${questionSet.version}`,
      }),
    [principalId, companyId, projectId, runId, questionSet.id, questionSet.version],
  );

  // Browser-local drafts initialized from the immutable defaults, or from
  // the sessionStorage draft if one exists for this set+version (reload/
  // navigation recovery — VAL-MODEQ-082, VAL-MODEQ-134). Edits update only
  // this local state and create no answer revision, event, or resume
  // context until one atomic submission (VAL-MODEQ-068).
  const [drafts, setDrafts] = useState<DraftMap>(() => {
    const stored = readDraft(draftKey);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as DraftMap;
        if (parsed && typeof parsed === 'object') {
          // Merge with defaults so new questions (version change) get
          // their default rather than undefined.
          const merged: DraftMap = {};
          for (const q of orderedQuestions) {
            merged[q.questionKey] =
              q.questionKey in parsed ? parsed[q.questionKey] : defaultDraftFor(q);
          }
          return merged;
        }
      } catch {
        // Corrupted draft — fall through to defaults.
      }
    }
    const init: DraftMap = {};
    for (const q of orderedQuestions) {
      init[q.questionKey] = defaultDraftFor(q);
    }
    return init;
  });

  // Re-initialize drafts if the set identity/version changes (refresh,
  // replacement). The persisted defaults are re-read from the immutable
  // definition so refresh preserves them unchanged (VAL-MODEQ-045,
  // VAL-MODEQ-054). A stored draft for the new set+version is restored.
  useEffect(() => {
    const stored = readDraft(draftKey);
    const init: DraftMap = {};
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as DraftMap;
        for (const q of orderedQuestions) {
          init[q.questionKey] =
            q.questionKey in parsed ? parsed[q.questionKey] : defaultDraftFor(q);
        }
      } catch {
        for (const q of orderedQuestions) {
          init[q.questionKey] = defaultDraftFor(q);
        }
      }
    } else {
      for (const q of orderedQuestions) {
        init[q.questionKey] = defaultDraftFor(q);
      }
    }
    setDrafts(init);
    setFieldErrors({});
    setSubmitError(null);
  }, [questionSet.id, questionSet.version, orderedQuestions, draftKey]);

  // Clear the stored draft when the set is answered or invalidated — the
  // draft is no longer actionable (VAL-MODEQ-134).
  useEffect(() => {
    if (answered || invalidated) {
      clearDraft(draftKey);
    }
  }, [answered, invalidated, draftKey]);

  // Persist drafts to sessionStorage on every edit so they survive reload
  // and navigation (VAL-MODEQ-082, VAL-MODEQ-134). Never transmitted to a
  // server.
  function persistDrafts(next: DraftMap) {
    try {
      writeDraft(draftKey, JSON.stringify(next));
    } catch {
      // sessionStorage may be unavailable; ignore.
    }
  }

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Retained idempotency key for the current logical submission
  // (Normative Boundary 2 / VAL-MODEQ-133). Reused across recoverable
  // retries and lost-response re-submissions until the server confirms.
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const firstInvalidRef = useRef<HTMLElement | null>(null);

  const answerMutation = useAnswerMissionRun(companyId, projectId, runId);

  function updateDraft(key: string, value: unknown) {
    setDrafts((prev) => {
      const next = { ...prev, [key]: value };
      persistDrafts(next);
      return next;
    });
    setFieldErrors((prev) => {
      if (!prev[key]) {
        return prev;
      }
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (invalidated || answered || answerMutation.isPending) {
      return;
    }
    setFieldErrors({});
    setSubmitError(null);
    firstInvalidRef.current = null;

    // Only include answers the user explicitly supplied. Optional questions
    // with no edited value are omitted so omission stays distinguishable from
    // an explicit default/empty (VAL-MODEQ-056, VAL-MODEQ-140). Required
    // questions must be present.
    const answers: Record<string, unknown> = {};
    const errors: FieldErrors = {};
    for (const q of orderedQuestions) {
      const value = drafts[q.questionKey];
      const hasDefault = q.default !== null && q.default !== undefined;
      const isExplicit =
        draftDiffersFromDefault(q, value) || hasDefault
          ? true
          : value !== undefined && value !== null && value !== '';
      if (q.required) {
        const empty =
          value === undefined ||
          value === null ||
          value === '' ||
          (Array.isArray(value) && value.length === 0);
        if (empty) {
          errors[q.questionKey] = 'This question is required.';
          continue;
        }
      }
      if (isExplicit) {
        answers[q.questionKey] = value;
      }
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      // Move focus to the first invalid field (VAL-MODEQ-096).
      requestAnimationFrame(() => firstInvalidRef.current?.focus());
      return;
    }

    const key = idempotencyKey || makeAnswerIdempotencyKey(runId, questionSet.id);
    setIdempotencyKey(key);
    try {
      await answerMutation.mutateAsync({
        body: {
          questionSetId: questionSet.id,
          questionSetVersion: questionSet.version,
          answers,
        },
        idempotencyKey: key,
        ifMatch: stateVersion,
      });
      // Server confirmed the outcome: clear the retained key and the
      // stored draft so a later, distinct submission is a fresh logical
      // command (VAL-MODEQ-133, VAL-MODEQ-134).
      setIdempotencyKey('');
      clearDraft(draftKey);
      // Invalidate the inbox projection so the mission-question attention
      // item converges to the resolved state without duplicates
      // (VAL-CROSS-044, Normative Boundary 1).
      qc.invalidateQueries({ queryKey: ['inbox', companyId] });
    } catch (err) {
      handleSubmissionError(err);
    }
  }

  function handleSubmissionError(err: unknown) {
    const apiErr = err as {
      status?: number;
      body?: { code?: string; details?: unknown };
    };
    const code = apiErr?.body?.code;
    if (apiErr?.status === 412 || code === 'RUN_VERSION_MISMATCH') {
      setSubmitError('This Mission changed. Refresh to see the latest questions before answering.');
    } else if (code === 'QUESTION_SET_INVALIDATED') {
      setSubmitError('These questions are no longer active. Refresh to see the current questions.');
    } else if (apiErr?.status === 422 || code === 'ANSWER_VALIDATION_FAILED') {
      const mapped = mapAnswerValidationDetails(apiErr?.body?.details);
      if (Object.keys(mapped).length === 0) {
        setSubmitError('Some answers are invalid. Correct the highlighted fields and resubmit.');
      } else {
        setFieldErrors(mapped);
      }
      requestAnimationFrame(() => firstInvalidRef.current?.focus());
    } else if (code === 'QUESTION_SET_VERSION_MISMATCH') {
      setSubmitError(
        'The question set changed. Refresh to see the latest version before answering.',
      );
    } else if (apiErr?.status === 409 && code === 'INVALID_RUN_STATE') {
      setSubmitError('This Mission is no longer accepting answers.');
    } else {
      // Network error / lost response: the server may have applied the
      // command but the response was lost. Retain the key so the next
      // activation replays the identical logical command, and invalidate
      // the snapshot so TanStack Query refetches authoritative state —
      // if the answer was applied, the set will show as answered and the
      // card will update without a duplicate submission (VAL-MODEQ-133).
      setSubmitError('Could not submit answers. Your draft is preserved — try again.');
      qc.invalidateQueries({
        queryKey: ['mission-run-snapshot', companyId, projectId, runId],
      });
      qc.invalidateQueries({
        queryKey: ['mission-run-events', companyId, projectId, runId],
      });
    }
  }

  const pending = answerMutation.isPending;
  const fieldsetDisabled = invalidated || answered || pending;

  return (
    <section
      id={`mission-question-${questionSet.id}`}
      aria-labelledby={`question-set-heading-${questionSet.id}`}
      className="mt-3 rounded-xl border border-accent/20 bg-accent/[0.04] p-3 w-full max-w-full break-words"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <HelpCircle className="h-4 w-4 text-accent" aria-hidden="true" />
        <h4
          id={`question-set-heading-${questionSet.id}`}
          className="text-sm font-semibold text-text-primary font-display"
        >
          Questions
          <span className="ml-2 text-xs font-normal text-text-muted">
            Set {questionSet.ordinal} · version {questionSet.version}
          </span>
        </h4>
        {invalidated && (
          <span className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
            <Lock className="h-3 w-3" aria-hidden="true" />
            Invalidated
          </span>
        )}
        {answered && (
          <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
            Answered
          </span>
        )}
      </div>

      {invalidated && questionSet.invalidationReason && (
        <p className="mb-2 text-xs text-warning" role="status">
          This question set was invalidated: {questionSet.invalidationReason}
        </p>
      )}

      <form onSubmit={handleSubmit}>
        <fieldset
          disabled={fieldsetDisabled}
          aria-busy={pending || undefined}
          className="space-y-4"
          aria-describedby={`question-set-help-${questionSet.id}`}
        >
          <legend className="sr-only">
            Question set {questionSet.ordinal}, version {questionSet.version}
          </legend>
          <p id={`question-set-help-${questionSet.id}`} className="sr-only">
            Answer the following questions, then submit. Edits are kept as a local draft until you
            submit.
          </p>

          <ol className="space-y-4 list-none p-0">
            {orderedQuestions.map((q, index) => (
              <li key={q.questionKey} className="rounded-lg border border-white/[0.06] p-3">
                <QuestionField
                  question={q}
                  index={index}
                  value={drafts[q.questionKey]}
                  error={fieldErrors[q.questionKey]}
                  disabled={fieldsetDisabled}
                  onChange={(v) => updateDraft(q.questionKey, v)}
                  invalidRef={(el) => {
                    if (fieldErrors[q.questionKey] && !firstInvalidRef.current) {
                      firstInvalidRef.current = el;
                    }
                  }}
                />
              </li>
            ))}
          </ol>

          {submitError && (
            <p role="alert" className="text-xs text-error break-words">
              {submitError}
            </p>
          )}

          {!invalidated && !answered && (
            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={pending}
                className="inline-flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none disabled:opacity-50 disabled:cursor-not-allowed motion-reduce:transition-none"
              >
                <Send className="h-3.5 w-3.5" aria-hidden="true" />
                {pending ? 'Submitting…' : 'Submit answers'}
              </button>
              <span aria-live="polite" className="sr-only">
                {pending ? 'Submitting answers.' : ''}
              </span>
            </div>
          )}
        </fieldset>
      </form>
    </section>
  );
}

function QuestionField({
  question,
  index,
  value,
  error,
  disabled,
  onChange,
  invalidRef,
}: {
  question: MissionQuestionDefinition;
  index: number;
  value: unknown;
  error?: string;
  disabled: boolean;
  onChange: (value: unknown) => void;
  invalidRef: InvalidRefRegistrar;
}) {
  const helpId = `question-help-${question.questionKey}`;
  const errorId = `question-error-${question.questionKey}`;
  const labelId = `question-label-${question.questionKey}`;
  const isDraft = draftDiffersFromDefault(question, value);

  return (
    <div data-testid={`question-field-${question.questionKey}`}>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span id={labelId} className="text-sm font-medium text-text-primary break-words">
          {index + 1}. {question.label}
          {question.required && (
            <span className="ml-1 text-error" aria-hidden="true">
              *
            </span>
          )}
        </span>
        <span className="text-[10px] uppercase tracking-wide text-text-muted">
          {question.type.replace(/_/g, ' ')}
        </span>
        {isDraft && !error && (
          <span className="text-[10px] uppercase tracking-wide text-warning">Draft</span>
        )}
      </div>

      {question.help && (
        <p id={helpId} className="mb-1.5 text-xs text-text-muted break-words">
          {question.help}
        </p>
      )}

      <QuestionControl
        question={question}
        value={value}
        disabled={disabled}
        helpId={helpId}
        errorId={errorId}
        labelId={labelId}
        onChange={onChange}
        invalidRef={invalidRef}
        hasError={!!error}
      />

      {error && (
        <p id={errorId} role="alert" className="mt-1 text-xs text-error break-words">
          {error}
        </p>
      )}
    </div>
  );
}
