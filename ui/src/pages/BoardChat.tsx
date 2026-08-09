import { useState, useEffect, useRef, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import {
  MessageCircle,
  Send,
  ChevronDown,
  Plus,
  ArrowLeft,
  Users,
  Bot,
  CheckSquare,
  Link2,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { clsx } from "clsx";
import {
  useChatThreads,
  useChatThread,
  useSendChatMessage,
  useAgents,
} from "@/lib/hooks";
import { useServerEvents } from "@/lib/ws";
import { useQueryClient } from "@tanstack/react-query";
import { EmptyState } from "@/components/ui/EmptyState";
import { MentionPicker, MentionChip } from "@/components/projects/MentionPicker";
import { ThreadArtifactCard } from "@/components/projects/ThreadArtifactCard";
import { ThreadMeetingCard } from "@/components/projects/ThreadMeetingCard";
import type { Agent, MentionableEntity } from "@/lib/api";

const BOARD_SENDER_ID = "__board__"; // Legacy sentinel; board messages now use null fromAgentId

type MentionEntry = { entityType: "agent" | "user"; entityId: string; label: string };

/** Render content with mention chips inline for persisted mentions. */
function renderMessageContent(
  content: string,
  mentions?: MentionEntry[],
): React.ReactNode {
  if (!mentions || mentions.length === 0) return content;
  const labels = mentions.map((m) => m.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const regex = new RegExp(`(@(?:${labels.join("|")}))`, "g");
  const parts = content.split(regex);
  return parts.map((part, i) => {
    const mention = mentions.find((m) => `@${m.label}` === part);
    if (mention) {
      return <MentionChip key={i} entityType={mention.entityType} label={mention.label} />;
    }
    return <span key={i}>{part}</span>;
  });
}

/** Role badge colors (muted, no gradients) */
const roleBadgeClass: Record<string, string> = {
  ceo: "bg-accent/15 text-accent",
  cto: "bg-neon-cyan/15 text-neon-cyan",
  cfo: "bg-success/15 text-success",
  engineer: "bg-neon-blue/15 text-neon-blue",
  designer: "bg-neon-purple/15 text-neon-purple",
  marketer: "bg-warning/15 text-warning",
  sales: "bg-accent/15 text-accent",
  support: "bg-success/15 text-success",
  hr: "bg-neon-purple/15 text-neon-purple",
  custom: "bg-white/10 text-text-secondary",
};

export function BoardChat() {
  const { companyId } = useParams();
  const qc = useQueryClient();

  // Data
  const { data: threads, isLoading: threadsLoading } = useChatThreads(companyId);
  const { data: agents } = useAgents(companyId);
  const sendChat = useSendChatMessage(companyId!);

  // Local state
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>();
  const [message, setMessage] = useState("");
  const [mentions, setMentions] = useState<MentionEntry[]>([]);
  const [targetAgentId, setTargetAgentId] = useState<string | undefined>();
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [showThreadList, setShowThreadList] = useState(true);
  const [pendingResponse, setPendingResponse] = useState(false);

  // Mention picker state
  const [showMentionPicker, setShowMentionPicker] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [pickerAnchor, setPickerAnchor] = useState<DOMRect | null>(null);
  const mentionStartRef = useRef<number>(-1);

  // Thread messages
  const { data: threadMessages } = useChatThread(companyId, activeThreadId);

  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const agentPickerRef = useRef<HTMLDivElement>(null);

  // Agent lookup
  const agentMap = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of agents ?? []) {
      m.set(a.id, a);
    }
    return m;
  }, [agents]);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [threadMessages]);

  // Listen for real-time message events
  useServerEvents(companyId, "message.sent", () => {
    qc.invalidateQueries({ queryKey: ["chat-threads", companyId] });
    if (activeThreadId) {
      qc.invalidateQueries({ queryKey: ["chat-thread", companyId, activeThreadId] });
    }
    setPendingResponse(false);
  });

  // Close agent picker on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (agentPickerRef.current && !agentPickerRef.current.contains(e.target as Node)) {
        setShowAgentPicker(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    }
  }, [message]);

  // Handle text input, detecting @ mention triggers (reuses the
  // MentionPicker/chip flow from ProjectThreadPanel).
  function handleTextChange(value: string) {
    setMessage(value);

    const lastAtIndex = value.lastIndexOf("@");
    if (lastAtIndex >= 0) {
      const preceding = lastAtIndex > 0 ? value[lastAtIndex - 1] : " ";
      if (preceding === " " || preceding === "\n" || lastAtIndex === 0) {
        const afterAt = value.slice(lastAtIndex + 1);
        if (!afterAt.includes(" ")) {
          setShowMentionPicker(true);
          setMentionQuery(afterAt);
          mentionStartRef.current = lastAtIndex;
          if (textareaRef.current) {
            setPickerAnchor(textareaRef.current.getBoundingClientRect());
          }
          return;
        }
      }
    }
    setShowMentionPicker(false);
  }

  function handleMentionSelect(entity: MentionableEntity) {
    const start = mentionStartRef.current;
    if (start < 0) return;
    const before = message.slice(0, start);
    const newText = `${before}@${entity.label} `;
    setMessage(newText);
    setMentions((prev) => [
      ...prev,
      { entityType: entity.entityType, entityId: entity.entityId, label: entity.label },
    ]);
    setShowMentionPicker(false);
    mentionStartRef.current = -1;
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  const handleSend = () => {
    const content = message.trim();
    if (!content) return;

    const threadId = activeThreadId;

    // Reconcile structured mentions against the current draft text: drop any
    // mention whose @Label was deleted from the input.
    const reconciledMentions = mentions.filter((m) => content.includes(`@${m.label}`));

    sendChat.mutate(
      {
        content,
        targetAgentId,
        threadId,
        mentions: reconciledMentions.length > 0 ? reconciledMentions : undefined,
      },
      {
        onSuccess: (res) => {
          setMessage("");
          setMentions([]);
          setPendingResponse(true);
          // If new thread, select it
          const result = (res as any)?.data ?? res;
          if (!threadId && result?.threadId) {
            setActiveThreadId(result.threadId);
          }
          // Invalidate thread list
          qc.invalidateQueries({ queryKey: ["chat-threads", companyId] });
          if (result?.threadId) {
            qc.invalidateQueries({ queryKey: ["chat-thread", companyId, result.threadId] });
          }
        },
      },
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Let the MentionPicker handle Arrow/Enter/Escape when open
    if (showMentionPicker) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const startNewThread = () => {
    setActiveThreadId(undefined);
    setMessage("");
    setMentions([]);
    setShowThreadList(false);
  };

  const selectedAgent = targetAgentId ? agentMap.get(targetAgentId) : undefined;

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Thread List (left panel) ─────────────────────────────────── */}
      <div
        className={clsx(
          "w-72 shrink-0 flex flex-col border-r border-white/[0.06] bg-surface transition-all duration-300",
          // Mobile: show/hide
          showThreadList ? "translate-x-0" : "-translate-x-full absolute inset-y-0 left-0 z-30",
          "sm:translate-x-0 sm:static sm:z-auto",
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3.5">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/15">
              <MessageCircle className="h-3.5 w-3.5 text-accent" />
            </div>
            <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
              Board Chat
            </h3>
          </div>
          <button
            onClick={startNewThread}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:text-accent hover:bg-accent/10 transition-all duration-200 cursor-pointer"
            title="New conversation"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>

        {/* Thread list */}
        <div className="flex-1 overflow-y-auto p-2.5 space-y-1">
          {threadsLoading ? (
            <div className="space-y-2 p-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-14 animate-pulse rounded-lg glass" />
              ))}
            </div>
          ) : !threads?.length ? (
            <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 mb-3">
                <MessageCircle className="h-5 w-5 text-accent/60" />
              </div>
              <p className="text-xs text-text-secondary">
                No conversations yet
              </p>
              <p className="text-[10px] text-text-muted mt-1">
                Send a message to get started
              </p>
            </div>
          ) : (
            threads.map((thread) => {
              const participantNames = thread.participantAgentIds
                .map((id) => agentMap.get(id)?.name ?? "Agent")
                .join(", ");

              return (
                <button
                  key={thread.id}
                  onClick={() => {
                    setActiveThreadId(thread.id);
                    setShowThreadList(false);
                  }}
                  className={clsx(
                    "w-full text-left rounded-lg px-3 py-2.5 transition-all duration-200 cursor-pointer group",
                    activeThreadId === thread.id
                      ? "bg-accent/[0.08] border border-accent/20"
                      : "hover:bg-white/[0.04] border border-transparent",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={clsx(
                        "text-xs font-medium truncate",
                        activeThreadId === thread.id
                          ? "text-accent"
                          : "text-text-primary group-hover:text-text-primary",
                      )}
                    >
                      {participantNames || "New chat"}
                    </span>
                    <span className="text-[9px] text-text-muted tabular-nums font-display shrink-0">
                      {thread.lastMessageAt
                        ? formatDistanceToNow(new Date(thread.lastMessageAt), {
                            addSuffix: false,
                          })
                        : ""}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] truncate text-text-secondary">
                    {thread.lastMessage}
                  </p>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* ── Chat Area (right panel) ──────────────────────────────────── */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Chat header */}
        <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-3">
          {/* Mobile back button */}
          <button
            onClick={() => setShowThreadList(true)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:text-accent hover:bg-accent/10 transition-all duration-200 sm:hidden cursor-pointer"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>

          <div className="flex items-center gap-2 min-w-0 flex-1">
            <Users className="h-4 w-4 text-text-secondary shrink-0" />
            <span className="text-sm font-medium text-text-primary truncate font-display">
              {activeThreadId
                ? (() => {
                    const thread = threads?.find((t) => t.id === activeThreadId);
                    if (!thread) return "Conversation";
                    return (
                      thread.participantAgentIds
                        .map((id) => agentMap.get(id)?.name ?? "Agent")
                        .join(", ") || "Conversation"
                    );
                  })()
                : "New Conversation"}
            </span>
          </div>

          {/* Agent selector */}
          <div className="relative" ref={agentPickerRef}>
            <button
              onClick={() => setShowAgentPicker(!showAgentPicker)}
              className={clsx(
                "flex items-center gap-1.5 rounded-md h-7 px-2.5 text-[11px] font-medium transition-all duration-200 cursor-pointer border",
                selectedAgent
                  ? "text-accent border-accent/25 bg-accent/[0.06]"
                  : "text-text-secondary border-white/[0.08] hover:border-white/[0.15] hover:text-text-primary",
              )}
            >
              <Bot className="h-3 w-3" />
              {selectedAgent ? selectedAgent.name : "Auto-route"}
              <ChevronDown className="h-3 w-3" />
            </button>

            {showAgentPicker && (
              <div className="absolute right-0 top-full mt-1 w-56 rounded-lg glass-raised border border-white/[0.08] shadow-xl shadow-black/40 z-50 py-1 animate-slide-up">
                <button
                  onClick={() => {
                    setTargetAgentId(undefined);
                    setShowAgentPicker(false);
                  }}
                  className={clsx(
                    "w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors duration-150 cursor-pointer",
                    !targetAgentId
                      ? "text-accent bg-accent/[0.06]"
                      : "text-text-secondary hover:text-text-primary hover:bg-white/[0.04]",
                  )}
                >
                  <div className="flex h-5 w-5 items-center justify-center rounded bg-white/10">
                    <Bot className="h-3 w-3" />
                  </div>
                  <div>
                    <span className="font-medium">Auto-route</span>
                    <p className="text-[10px] text-text-muted mt-0.5">
                      AI picks the best agent
                    </p>
                  </div>
                </button>
                <div className="h-px bg-white/[0.06] my-1" />
                {(agents ?? []).map((agent) => (
                  <button
                    key={agent.id}
                    onClick={() => {
                      setTargetAgentId(agent.id);
                      setShowAgentPicker(false);
                    }}
                    className={clsx(
                      "w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors duration-150 cursor-pointer",
                      targetAgentId === agent.id
                        ? "text-accent bg-accent/[0.06]"
                        : "text-text-secondary hover:text-text-primary hover:bg-white/[0.04]",
                    )}
                  >
                    <div
                      className={clsx(
                        "flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold font-display",
                        roleBadgeClass[agent.role] ?? roleBadgeClass.custom,
                      )}
                    >
                      {agent.name.charAt(0)}
                    </div>
                    <div className="min-w-0">
                      <span className="font-medium truncate block">
                        {agent.name}
                      </span>
                      <span className="text-[10px] text-text-muted capitalize">
                        {agent.title ?? agent.role}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Messages area */}
        <div className="flex-1 overflow-y-auto px-4 py-5 space-y-4 grid-bg">
          {!activeThreadId && !threadMessages?.length ? (
            <div className="flex flex-col items-center justify-center h-full">
              <EmptyState
                icon={<MessageCircle className="h-6 w-6" />}
                title="Talk to your AI company"
                description="Send a message to any agent. Messages are auto-routed based on content, or pick a specific agent."
                className="max-w-md"
              />
            </div>
          ) : (
            <>
              {(threadMessages ?? []).map((msg) => {
                const isBoard = !msg.fromAgentId || msg.fromAgentId === BOARD_SENDER_ID;
                const agent = !isBoard ? agentMap.get(msg.fromAgentId) : null;
                // Persisted mentions live in the message metadata (BoardChat
                // stores them on the user/bound message). Agent responses carry
                // artifactId/artifactType in metadata when an artifact was produced.
                const msgMentions = (msg.metadata?.mentions as MentionEntry[] | undefined);
                // VAL-CROSS-007: render ALL artifacts from metadata.artifacts[]
                // (agent can produce multiple). Fall back to single
                // metadata.artifactId/artifactType for backward compat.
                const msgMeta = msg.metadata as Record<string, unknown> | undefined;
                const artifactsList = Array.isArray(msgMeta?.artifacts)
                  ? (msgMeta.artifacts as Array<{ artifactId: string; artifactType: string }>)
                  : msgMeta?.artifactId != null && msgMeta?.artifactType != null
                    ? [{ artifactId: String(msgMeta.artifactId), artifactType: String(msgMeta.artifactType) }]
                    : [];
                // VAL-CROSS-026: task outcome link from metadata
                const taskId =
                  (msgMeta?.mentionDispatch as { taskId?: string } | undefined)?.taskId ??
                  (typeof msgMeta?.taskId === "string" ? msgMeta.taskId : undefined);
                // VAL-MEETING-015: meeting outcome card from metadata
                const meetingId: string | undefined =
                  typeof msgMeta?.meetingId === "string"
                    ? msgMeta.meetingId
                    : Array.isArray(msgMeta?.meetings)
                      ? (msgMeta.meetings as Array<{ meetingId: string }>)[0]?.meetingId
                      : undefined;

                return (
                  <div
                    key={msg.id}
                    className={clsx(
                      "flex gap-3 animate-fade-in",
                      isBoard ? "flex-row-reverse" : "flex-row",
                    )}
                  >
                    {/* Avatar */}
                    {isBoard ? (
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-bold text-accent font-display">
                        BD
                      </div>
                    ) : (
                      <div
                        className={clsx(
                          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold font-display",
                          roleBadgeClass[agent?.role ?? "custom"] ?? roleBadgeClass.custom,
                        )}
                      >
                        {agent?.name?.charAt(0) ?? "A"}
                      </div>
                    )}

                    {/* Message bubble */}
                    <div
                      className={clsx(
                        "max-w-[75%] min-w-0",
                        isBoard ? "text-right" : "text-left",
                      )}
                    >
                      {/* Sender info */}
                      <div
                        className={clsx(
                          "flex items-center gap-2 mb-1",
                          isBoard ? "justify-end" : "justify-start",
                        )}
                      >
                        <span className="text-[11px] font-medium text-text-primary font-display">
                          {isBoard ? "Board of Directors" : agent?.name ?? "Agent"}
                        </span>
                        {!isBoard && agent?.role && (
                          <span
                            className={clsx(
                              "inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider font-display",
                              roleBadgeClass[agent.role] ?? roleBadgeClass.custom,
                            )}
                          >
                            {agent.title ?? agent.role}
                          </span>
                        )}
                        <time className="text-[9px] text-text-muted tabular-nums font-display">
                          {msg.createdAt
                            ? formatDistanceToNow(
                                new Date(
                                  typeof msg.createdAt === "number"
                                    ? msg.createdAt
                                    : msg.createdAt,
                                ),
                                { addSuffix: true },
                              )
                            : ""}
                        </time>
                      </div>

                      {/* Bubble */}
                      <div
                        className={clsx(
                          "rounded-xl px-3.5 py-2.5 text-sm leading-relaxed",
                          isBoard
                            ? "bg-accent/[0.12] border border-accent/20 text-text-primary"
                            : "glass-raised text-text-secondary",
                        )}
                      >
                        <p className="whitespace-pre-wrap break-words text-left">
                          {renderMessageContent(msg.content, msgMentions)}
                        </p>
                      </div>

                      {/* Artifact card(s) from agent response metadata */}
                      {artifactsList.map((a) => (
                        <div key={a.artifactId} className="mt-1.5 max-w-full">
                          <ThreadArtifactCard
                            artifactId={a.artifactId}
                            artifactType={a.artifactType}
                            companyId={companyId!}
                            projectId={null}
                          />
                        </div>
                      ))}
                      {/* VAL-MEETING-015: meeting outcome card from agent response */}
                      {meetingId != null && (
                        <div key={`meeting-${meetingId}`} className="mt-1.5 max-w-full">
                          <ThreadMeetingCard
                            meetingId={meetingId}
                            companyId={companyId!}
                            projectId={null}
                          />
                        </div>
                      )}
                      {/* Task outcome link from agent response (VAL-CROSS-026) */}
                      {taskId != null && (
                        <Link
                          to={`/company/${companyId}/tasks/${encodeURIComponent(taskId)}`}
                          data-testid="thread-task-link"
                          data-task-id={taskId}
                          className="mt-1.5 max-w-full flex items-center gap-3 rounded-lg border border-white/[0.08] bg-white/[0.02] p-3 transition-colors hover:border-accent/30 hover:bg-accent/[0.04]"
                        >
                          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-accent/10 text-accent">
                            <CheckSquare className="h-4 w-4" aria-hidden="true" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium text-text-primary">Task created</div>
                            <div className="truncate text-xs text-text-muted">
                              Click to view task on the board
                            </div>
                          </div>
                          <Link2 className="h-3.5 w-3.5 text-text-muted" aria-hidden="true" />
                        </Link>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Thinking indicator */}
              {pendingResponse && (
                <div className="flex gap-3 animate-fade-in">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-[11px] font-bold text-text-secondary font-display">
                    <Bot className="h-4 w-4 animate-pulse" />
                  </div>
                  <div className="glass-raised rounded-xl px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-accent/60 animate-typing" />
                      <span
                        className="h-1.5 w-1.5 rounded-full bg-accent/60 animate-typing"
                        style={{ animationDelay: "0.15s" }}
                      />
                      <span
                        className="h-1.5 w-1.5 rounded-full bg-accent/60 animate-typing"
                        style={{ animationDelay: "0.3s" }}
                      />
                      <span className="ml-2 text-xs text-text-muted">
                        Agent is thinking...
                      </span>
                    </div>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        {/* ── Input Area ──────────────────────────────────────────────── */}
        <div className="border-t border-white/[0.06] p-3">
          <div className="relative flex items-end gap-2">
            <textarea
              ref={textareaRef}
              value={message}
              onChange={(e) => handleTextChange(e.target.value)}
              onKeyDown={handleKeyDown}
              aria-label="Message your AI company"
              placeholder={
                selectedAgent
                  ? `Message ${selectedAgent.name}... (use @ to mention)`
                  : "Message your AI company... (use @ to mention)"
              }
              rows={1}
              className="flex-1 resize-none rounded-lg glass px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-muted outline-none transition-all duration-200 focus:border-accent/25 focus:shadow-md focus:shadow-accent/5 border border-transparent min-h-[38px] max-h-[160px]"
            />
            {showMentionPicker && companyId && (
              <MentionPicker
                companyId={companyId}
                query={mentionQuery}
                onSelect={handleMentionSelect}
                onClose={() => setShowMentionPicker(false)}
                anchorRect={pickerAnchor}
              />
            )}
            <button
              onClick={handleSend}
              disabled={!message.trim() || sendChat.isPending}
              className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-lg bg-accent text-surface transition-all duration-200 hover:brightness-110 active:scale-[0.95] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
            >
              {sendChat.isPending ? (
                <svg
                  className="h-4 w-4 animate-spin"
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <circle
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    className="opacity-25"
                  />
                  <path
                    d="M4 12a8 8 0 018-8"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                  />
                </svg>
              ) : (
                <Send className="h-4 w-4" />
              )}
            </button>
          </div>

          {/* Active mention chips */}
          {mentions.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5 px-1">
              {mentions.map((m, i) => (
                <MentionChip key={i} entityType={m.entityType} label={m.label} />
              ))}
            </div>
          )}

          <p className="mt-1.5 text-[10px] text-text-muted px-1">
            Press Enter to send, Shift+Enter for new line. Type @ to mention an agent or teammate.
          </p>
        </div>
      </div>
    </div>
  );
}
