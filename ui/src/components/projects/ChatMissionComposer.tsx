import { useEffect, useRef, useState } from 'react';
import { Send, Rocket } from 'lucide-react';
import {
  useFeatureFlags,
  useProjectThreads,
  useCreateThreadItem,
  useStartMissionRun,
} from '@/lib/hooks';
import { Button } from '@/components/ui/Button';
import type { MissionMode } from '@/lib/api';

type ComposerMode = 'chat' | 'mission';

const MISSION_MODES: { value: MissionMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'fast', label: 'Fast' },
  { value: 'deep_work', label: 'Deep Work' },
  { value: 'analyst', label: 'Analyst' },
];

const MODE_COST_CEILINGS: Record<MissionMode, number> = {
  auto: 10_000,
  fast: 500,
  deep_work: 5_000,
  analyst: 5_000,
};

function resolvePreviewMode(mode: MissionMode, request: string): MissionMode {
  if (mode !== 'auto') {
    return mode;
  }
  const normalized = request.toLowerCase();
  if (/\b(research|sources?|citations?|web)\b/.test(normalized)) {
    return 'analyst';
  }
  if (/\b(and|then|compare|multiple|dependencies?)\b/.test(normalized)) {
    return 'deep_work';
  }
  return 'fast';
}

/** Chat form: posts a comment to the selected thread through the legacy path. */
function ChatForm({
  draft,
  onDraftChange,
  selectedThreadId,
  createThreadItem,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  selectedThreadId: string;
  createThreadItem: ReturnType<typeof useCreateThreadItem>;
}) {
  useEffect(() => {
    if (createThreadItem.isSuccess) {
      onDraftChange('');
      createThreadItem.reset();
    }
  }, [createThreadItem, onDraftChange]);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || !selectedThreadId || createThreadItem.isPending) {
      return;
    }
    createThreadItem.mutate({ kind: 'comment', content: trimmed });
  }

  const trimmedDraft = draft.trim();

  return (
    <form onSubmit={submit} className="space-y-2">
      <label className="sr-only" htmlFor="chat-input">
        Chat message
      </label>
      <input
        id="chat-input"
        aria-label="Chat message"
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        placeholder="Write a message…"
        className="h-9 w-full rounded-md border border-white/10 bg-white/[0.03] px-3 text-sm text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus:border-accent/60"
      />
      <Button
        type="submit"
        aria-label="Send"
        disabled={!trimmedDraft || !selectedThreadId || createThreadItem.isPending}
        loading={createThreadItem.isPending}
        icon={<Send className="h-3.5 w-3.5" />}
      >
        Send
      </Button>
      {createThreadItem.isError && (
        <p role="alert" className="text-sm text-error">
          Could not send your message. Your draft is preserved so you can try again.
        </p>
      )}
    </form>
  );
}

/** Generate a stable random idempotency key for a logical Mission start.
 * Reused across recoverable re-submissions so the server's
 * exactly-one-outcome guarantee holds after a lost network response
 * (Normative Boundary 2 / VAL-RUN-130). Matches MissionCancelDialog's
 * key-retention pattern. */
function makeStartIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `mission-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Mission form: starts an asynchronous durable Mission run. */
function MissionForm({
  draft,
  onDraftChange,
  missionMode,
  onModeChange,
  selectedThreadId,
  startMission,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  missionMode: MissionMode;
  onModeChange: (mode: MissionMode) => void;
  selectedThreadId: string;
  startMission: ReturnType<typeof useStartMissionRun>;
}) {
  const [costLimit, setCostLimit] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const costLimitRef = useRef<HTMLInputElement>(null);
  // Stable idempotency key for the current logical start. Generated on the
  // first activation and reused across recoverable re-submissions; cleared
  // on success (Normative Boundary 2 / VAL-RUN-130).
  const [idempotencyKey, setIdempotencyKey] = useState('');
  // Synchronous in-flight guard. `startMission.isPending` is updated
  // asynchronously after React re-renders, so a rapid second activation can
  // slip through before the button is disabled. This ref is set
  // synchronously on the first activation and blocks a second POST
  // immediately, then resets when the mutation settles so a recoverable
  // re-submission can proceed (VAL-RUN-016).
  const submittingRef = useRef(false);
  useEffect(() => {
    if (startMission.isSuccess) {
      onDraftChange('');
      // Success: the server confirmed the outcome. Clear the retained key
      // so a later, distinct start is a fresh logical command.
      setIdempotencyKey('');
      startMission.reset();
    }
  }, [startMission, onDraftChange]);

  // Reset the synchronous guard once the mutation has reached a settled
  // outcome (success or recoverable error) and is no longer pending, so a
  // later, distinct logical start can proceed. The retained idempotency key
  // is preserved for replay. This effect runs after every render: two
  // activations in the same event tick (or separated only by an act flush
  // while the mock never transitions `isPending`) keep the ref true and block
  // the duplicate; once the mutation reports a settled outcome, the ref
  // resets so a deliberate re-submission can proceed (VAL-RUN-016,
  // VAL-RUN-130).
  useEffect(() => {
    if (!startMission.isPending && (startMission.isSuccess || startMission.isError)) {
      submittingRef.current = false;
    }
  });

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Synchronous double-activation guard: block a second POST before the
    // async fetch begins, before `isPending` can flip (VAL-RUN-016).
    if (submittingRef.current) {
      return;
    }
    const trimmed = draft.trim();
    if (!trimmed || !selectedThreadId || startMission.isPending) {
      return;
    }
    const ceiling = MODE_COST_CEILINGS[resolvePreviewMode(missionMode, trimmed)];
    let requestedCost: number | undefined;
    if (costLimit.trim()) {
      const parsed = Number(costLimit);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setValidationError('Maximum mission cost must be greater than zero.');
        costLimitRef.current?.focus();
        return;
      }
      if (!Number.isInteger(parsed * 100)) {
        setValidationError('Maximum mission cost must use cents (up to two decimals).');
        costLimitRef.current?.focus();
        return;
      }
      requestedCost = Math.round(parsed * 100);
      if (requestedCost > ceiling) {
        setValidationError(
          `Maximum mission cost cannot exceed the effective hard ceiling of $${(ceiling / 100).toFixed(2)}.`,
        );
        costLimitRef.current?.focus();
        return;
      }
    }
    setValidationError(null);
    // Reuse the retained key across recoverable re-submissions; generate a
    // fresh key only for a new logical start (after a confirmed success
    // cleared the retained key). This preserves the exactly-one-outcome
    // contract when a network response is lost (Normative Boundary 2 /
    // VAL-RUN-130, VAL-RUN-052, VAL-RUN-016).
    const key = idempotencyKey || makeStartIdempotencyKey();
    setIdempotencyKey(key);
    // Synchronously mark in-flight so a rapid second activation cannot fire
    // a second POST before `isPending` flips (VAL-RUN-016).
    submittingRef.current = true;
    startMission.mutate({
      idempotencyKey: key,
      body: {
        projectThreadId: selectedThreadId,
        mode: missionMode,
        request: { text: trimmed },
        ...(requestedCost === undefined ? {} : { limits: { costCents: requestedCost } }),
      },
    });
  }

  const trimmedDraft = draft.trim();
  const resolvedMode = resolvePreviewMode(missionMode, trimmedDraft);
  const isProvisional = missionMode === 'auto' && !trimmedDraft;
  const ceiling = MODE_COST_CEILINGS[isProvisional ? 'auto' : resolvedMode];
  const displayedCost = costLimit.trim() ? Number(costLimit) * 100 : ceiling;

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-xs text-text-muted">
        Mission sends an asynchronous durable request. It will appear as a run card with questions,
        plans, and cited artifacts as it progresses.
      </p>
      <div>
        <label
          className="block text-xs font-medium text-text-secondary mb-1"
          htmlFor="mission-mode"
        >
          Mission mode
        </label>
        <select
          id="mission-mode"
          aria-label="Mission mode"
          value={missionMode}
          onChange={(e) => onModeChange(e.target.value as MissionMode)}
          className="h-9 w-full rounded-md border border-white/10 bg-surface px-3 text-sm text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus:border-accent/60"
        >
          {MISSION_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      <div className="rounded-lg border border-white/[0.08] bg-white/[0.025] px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-xs font-medium text-text-secondary">
            {isProvisional ? 'Provisional hard ceiling' : 'Effective hard ceiling'}
          </p>
          <p className="text-sm font-semibold tabular-nums text-text-primary">
            ${(displayedCost / 100).toFixed(2)}
          </p>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
          {isProvisional
            ? 'Auto will resolve to a concrete mode after you describe the request.'
            : `Resolved ${resolvedMode.replace('_', ' ')} mode. A lower limit narrows the run; it never adds headroom.`}
        </p>
        <label
          className="mt-2 block text-xs font-medium text-text-secondary"
          htmlFor="mission-cost-limit"
        >
          Maximum mission cost
          <input
            ref={costLimitRef}
            id="mission-cost-limit"
            aria-label="Maximum mission cost"
            inputMode="decimal"
            type="number"
            min="0"
            step="0.01"
            value={costLimit}
            onChange={(event) => {
              setCostLimit(event.target.value);
              if (validationError) {
                setValidationError(null);
              }
            }}
            aria-invalid={validationError ? 'true' : undefined}
            aria-describedby={validationError ? 'mission-validation-error' : undefined}
            placeholder={(ceiling / 100).toFixed(2)}
            className="mt-1 h-9 w-full rounded-md border border-white/10 bg-white/[0.03] px-3 text-sm text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus:border-accent/60"
          />
        </label>
      </div>
      <div>
        <label
          className="block text-xs font-medium text-text-secondary mb-1"
          htmlFor="mission-input"
        >
          Mission request
        </label>
        <textarea
          id="mission-input"
          aria-label="Mission request"
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          placeholder="Describe what you want the agent to do…"
          rows={3}
          className="w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus:border-accent/60 resize-y"
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
      </div>
      <Button
        type="submit"
        aria-label="Start mission"
        disabled={!trimmedDraft || !selectedThreadId || startMission.isPending}
        loading={startMission.isPending}
        icon={<Rocket className="h-3.5 w-3.5" />}
      >
        Start Mission
      </Button>
      {validationError && (
        <p id="mission-validation-error" role="alert" className="text-sm text-error">
          {validationError}
        </p>
      )}
      {startMission.isError && (
        <p role="alert" className="text-sm text-error">
          Could not start the Mission. Your request is preserved so you can try again.
        </p>
      )}
    </form>
  );
}

/**
 * Fail-closed Chat/Mission segmented composer for Project Work.
 *
 * The `missionAgentIntelligence` feature flag is evaluated server-side. When
 * the flag is absent, malformed, disabled, or still loading, Mission controls
 * are hidden and only the legacy Chat path is exposed. The browser never
 * inspects raw flag configuration.
 *
 * Chat and Mission maintain independent drafts so switching between them
 * preserves unsent text. Drafts are scoped to the component instance, so
 * navigating to another project (which re-mounts with different props) starts
 * with empty drafts.
 *
 * Both modes bind submissions to the selected conversation thread ID.
 */
export function ChatMissionComposer({
  companyId,
  projectId,
}: {
  companyId: string;
  projectId: string;
}) {
  const flagsQuery = useFeatureFlags(companyId);
  const missionEnabled = flagsQuery.data?.flags?.missionAgentIntelligence === true;

  const threadsQuery = useProjectThreads(companyId, projectId, {
    status: 'active',
    type: 'conversation',
  });
  const conversationThreads = threadsQuery.data ?? [];
  const [selectedThreadId, setSelectedThreadId] = useState(conversationThreads[0]?.id ?? '');

  // Sync the selected thread when the list loads or changes.
  useEffect(() => {
    const exists = conversationThreads.some((t) => t.id === selectedThreadId);
    if (conversationThreads.length > 0 && !exists) {
      setSelectedThreadId(conversationThreads[0].id);
    }
  }, [conversationThreads, selectedThreadId]);

  // Composer mode: Chat is always available; Mission only when the flag is on.
  const [mode, setMode] = useState<ComposerMode>('chat');

  // If the flag transitions from on to off while Mission is selected, fall
  // back to Chat so the user is never stranded on a hidden mode.
  useEffect(() => {
    if (!missionEnabled && mode === 'mission') {
      setMode('chat');
    }
  }, [missionEnabled, mode]);

  // Independent drafts for each mode, persisted to sessionStorage so they
  // survive tab navigation within Project Work (VAL-RUN-112). The storage
  // key is scoped by company/project so switching scope does not leak
  // drafts from another company/project (VAL-CROSS-069, VAL-CROSS-070).
  const draftStorageKey = `mission-drafts:${companyId}:${projectId}`;
  const [chatDraft, setChatDraft] = useState(() => {
    try {
      const stored = sessionStorage.getItem(draftStorageKey);
      return stored ? (JSON.parse(stored).chatDraft ?? '') : '';
    } catch {
      return '';
    }
  });
  const [missionDraft, setMissionDraft] = useState(() => {
    try {
      const stored = sessionStorage.getItem(draftStorageKey);
      return stored ? (JSON.parse(stored).missionDraft ?? '') : '';
    } catch {
      return '';
    }
  });
  const [missionMode, setMissionMode] = useState<MissionMode>('auto');

  // Persist drafts to sessionStorage whenever they change.
  useEffect(() => {
    try {
      sessionStorage.setItem(draftStorageKey, JSON.stringify({ chatDraft, missionDraft }));
    } catch {
      // sessionStorage may be unavailable (private mode); ignore.
    }
  }, [draftStorageKey, chatDraft, missionDraft]);

  // Thread item creation (legacy Chat path).
  const createThreadItem = useCreateThreadItem(companyId, projectId, selectedThreadId);

  // Mission start.
  const startMission = useStartMissionRun(companyId, projectId);

  const hasThreads = conversationThreads.length > 0;

  return (
    <section aria-label="Chat and Mission composer" data-testid="chat-mission-composer">
      {/* Thread selector */}
      {missionEnabled && hasThreads && (
        <div className="mb-3">
          <label
            className="block text-xs font-medium text-text-secondary mb-1"
            htmlFor="thread-selector"
          >
            Conversation thread
          </label>
          <select
            id="thread-selector"
            aria-label="Conversation thread"
            value={selectedThreadId}
            onChange={(e) => setSelectedThreadId(e.target.value)}
            className="h-9 w-full rounded-md border border-white/10 bg-surface px-3 text-sm text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus:border-accent/60"
          >
            {conversationThreads.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* No-thread guidance */}
      {missionEnabled && !hasThreads && (
        <p className="mb-3 text-sm text-text-muted" role="status">
          Create a conversation thread first to start a Mission.
        </p>
      )}

      {/* Chat / Mission segmented control */}
      <fieldset className="mb-3" role="radiogroup" aria-label="Chat or Mission">
        <legend className="sr-only">Chat or Mission</legend>
        <div className="inline-flex rounded-lg border border-white/10 bg-white/[0.02] p-0.5">
          <label
            className={`flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              mode === 'chat'
                ? 'bg-accent/15 text-accent'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            <input
              type="radio"
              name="composer-mode"
              value="chat"
              checked={mode === 'chat'}
              onChange={() => setMode('chat')}
              className="sr-only"
              aria-checked={mode === 'chat'}
            />
            <Send className="h-3.5 w-3.5" aria-hidden="true" />
            Chat
          </label>
          {missionEnabled && (
            <label
              className={`flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                mode === 'mission'
                  ? 'bg-accent/15 text-accent'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              <input
                type="radio"
                name="composer-mode"
                value="mission"
                checked={mode === 'mission'}
                onChange={() => setMode('mission')}
                className="sr-only"
                aria-checked={mode === 'mission'}
              />
              <Rocket className="h-3.5 w-3.5" aria-hidden="true" />
              Mission
            </label>
          )}
        </div>
      </fieldset>

      {/* Chat composer */}
      {mode === 'chat' && (
        <ChatForm
          draft={chatDraft}
          onDraftChange={setChatDraft}
          selectedThreadId={selectedThreadId}
          createThreadItem={createThreadItem}
        />
      )}

      {/* Mission composer */}
      {mode === 'mission' && missionEnabled && (
        <MissionForm
          draft={missionDraft}
          onDraftChange={setMissionDraft}
          missionMode={missionMode}
          onModeChange={setMissionMode}
          selectedThreadId={selectedThreadId}
          startMission={startMission}
        />
      )}
    </section>
  );
}
