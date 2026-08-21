import { useEffect, useState } from 'react';
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
  useEffect(() => {
    if (startMission.isSuccess) {
      onDraftChange('');
      startMission.reset();
    }
  }, [startMission, onDraftChange]);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || !selectedThreadId || startMission.isPending) {
      return;
    }
    const idempotencyKey = `mission-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    startMission.mutate({
      idempotencyKey,
      body: {
        projectThreadId: selectedThreadId,
        mode: missionMode,
        request: { text: trimmed },
      },
    });
  }

  const trimmedDraft = draft.trim();

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

  // Independent drafts for each mode (lifted up so they survive mode switches).
  const [chatDraft, setChatDraft] = useState('');
  const [missionDraft, setMissionDraft] = useState('');
  const [missionMode, setMissionMode] = useState<MissionMode>('auto');

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
