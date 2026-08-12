import { useEffect, useRef, useState, useMemo } from "react";
import { MessageCircle, Send, CheckSquare, Link2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  useCreateThreadItem,
  useProjectThreadItems,
  useResolveThreadItem,
} from "@/lib/hooks";
import { useServerEvents } from "@/lib/ws";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { MentionPicker, MentionChip } from "./MentionPicker";
import { ThreadArtifactCard } from "./ThreadArtifactCard";
import { ThreadMeetingCard } from "./ThreadMeetingCard";
import { renderMentionContent } from "@/lib/mention-render";
import type { ProjectThreadItem, MentionableEntity } from "@/lib/api";

function author(item: ProjectThreadItem) {
  return item.authorUserId ?? item.authorAgentId ?? "Unknown author";
}

function isAgent(item: ProjectThreadItem) {
  return !!item.authorAgentId;
}

function InteractionActions({
  item,
  onResolve,
  disabled,
}: {
  item: ProjectThreadItem;
  onResolve: (status: "accepted" | "rejected" | "answered") => void;
  disabled?: boolean;
}) {
  if (item.kind !== "interaction" || item.status !== "pending") return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      <Button size="sm" onClick={() => onResolve("accepted")} aria-label="Accept interaction" disabled={disabled}>
        Accept
      </Button>
      <Button size="sm" variant="danger" onClick={() => onResolve("rejected")} aria-label="Reject interaction" disabled={disabled}>
        Reject
      </Button>
      <Button size="sm" variant="secondary" onClick={() => onResolve("answered")} aria-label="Answer interaction" disabled={disabled}>
        Answer
      </Button>
    </div>
  );
}

interface ComposerState {
  text: string;
  mentions: Array<{ entityType: "agent" | "user" | "artifact"; entityId: string; label: string; artifactType?: string }>;
}

export function ProjectThreadPanel({
  companyId,
  projectId,
}: {
  companyId: string;
  projectId: string;
}) {
  const { data: items, threads, isLoading, isError } =
    useProjectThreadItems?.(companyId, projectId) ?? {
      data: [],
      threads: [],
      isLoading: false,
      isError: false,
    };

  const targetThread =
    threads.find((t) => t.type === "conversation") ?? threads[0];
  const targetThreadId = targetThread?.id;

  const createItem = useCreateThreadItem?.(companyId, projectId, targetThreadId ?? "") ?? {
    isPending: false,
    isSuccess: false,
    isError: false,
    mutate: () => undefined,
    reset: () => undefined,
  };
  const resolveItem = useResolveThreadItem?.(companyId, projectId) ?? {
    isPending: false,
    mutate: () => undefined,
  };

  const qc = useQueryClient();
  const [composer, setComposer] = useState<ComposerState>({ text: "", mentions: [] });
  const [showPicker, setShowPicker] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [pickerAnchor, setPickerAnchor] = useState<DOMRect | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mentionStartRef = useRef<number>(-1);

  // Clear the draft only after a successful post.
  useEffect(() => {
    if (createItem.isSuccess) {
      setComposer({ text: "", mentions: [] });
      createItem.reset?.();
    }
  }, [createItem.isSuccess]);

  // Realtime: live-render new/updated thread items without reload (VAL-MENTION-012).
  // Invalidating the thread query keys triggers TanStack Query to refetch, so a
  // second client sees new mention items appear live.
  useServerEvents(companyId, "project.thread.item.created", () => {
    qc.invalidateQueries({ queryKey: ["project-threads", companyId, projectId] });
    qc.invalidateQueries({ queryKey: ["project-thread", companyId, projectId] });
  });
  useServerEvents(companyId, "project.thread.item.updated", () => {
    qc.invalidateQueries({ queryKey: ["project-threads", companyId, projectId] });
    qc.invalidateQueries({ queryKey: ["project-thread", companyId, projectId] });
  });

  // Handle text input, detecting @ mentions
  function handleTextChange(value: string) {
    setComposer((prev) => ({ ...prev, text: value }));

    // Check for @ mention trigger
    const lastAtIndex = value.lastIndexOf("@");
    if (lastAtIndex >= 0) {
      // Check if @ is at start or preceded by whitespace
      const preceding = lastAtIndex > 0 ? value[lastAtIndex - 1] : " ";
      if (preceding === " " || preceding === "\n" || lastAtIndex === 0) {
        // Extract the query after @
        const afterAt = value.slice(lastAtIndex + 1);
        // Only show picker if there's no space in the query (still typing the name)
        if (!afterAt.includes(" ")) {
          setShowPicker(true);
          setMentionQuery(afterAt);
          mentionStartRef.current = lastAtIndex;
          // Get the input element's bounding rect for picker positioning
          if (inputRef.current) {
            setPickerAnchor(inputRef.current.getBoundingClientRect());
          }
          return;
        }
      }
    }
    setShowPicker(false);
  }

  function handleMentionSelect(entity: MentionableEntity) {
    const start = mentionStartRef.current;
    if (start < 0) return;

    const before = composer.text.slice(0, start);
    const newText = `${before}@${entity.label} `;
    setComposer((prev) => ({
      text: newText,
      mentions: [
        ...prev.mentions,
        {
          entityType: entity.entityType,
          entityId: entity.entityId,
          label: entity.label,
          ...(entity.artifactType ? { artifactType: entity.artifactType } : {}),
        },
      ],
    }));
    setShowPicker(false);
    mentionStartRef.current = -1;

    // Refocus the input
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = composer.text.trim();
    if (!trimmed || !targetThreadId || createItem.isPending) return;

    // Reconcile structured mentions against the current draft text.
    // Chips are tracked separately from the editable text input, so a user
    // can delete the @Label text while the structured mention entry lingers.
    // Drop any mention whose @Label is no longer present in the draft to
    // prevent dispatching stale mentions.
    const reconciledMentions = composer.mentions.filter((m) =>
      trimmed.includes(`@${m.label}`),
    );

    createItem.mutate({
      kind: "comment",
      content: trimmed,
      mentions: reconciledMentions.length > 0 ? reconciledMentions : undefined,
    });
  }

  function resolveInteraction(
    item: ProjectThreadItem,
    status: "accepted" | "rejected" | "answered",
  ) {
    const threadId = item.projectThreadId ?? targetThreadId;
    if (!threadId || resolveItem.isPending) return;
    resolveItem.mutate({ threadId, itemId: item.id, data: { status } });
  }

  const hasThreads = threads.length > 0;
  const trimmedText = composer.text.trim();

  return (
    <section aria-label="Project conversation" data-testid="project-thread-panel">
      <Card
        animated={false}
        header={
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/10 text-accent">
              <MessageCircle className="h-4 w-4" />
            </span>
            <h2 className="text-sm font-semibold text-text-primary font-display">Conversation</h2>
          </div>
        }
      >
        {isLoading ? (
          <div className="py-5 text-sm text-text-muted" role="status">
            Loading conversation…
          </div>
        ) : isError ? (
          <div className="py-5 text-sm text-error">Conversation could not be loaded.</div>
        ) : !hasThreads ? (
          <div className="py-5 text-sm text-text-muted" role="status">No conversation yet</div>
        ) : (
          <div className="space-y-3">
            {targetThread && (
              <p className="text-xs text-text-muted">{targetThread.title}</p>
            )}
            {items.length === 0 ? (
              <p className="py-3 text-sm text-text-muted">No messages yet</p>
            ) : (
              <ul className="space-y-2" aria-label="Thread messages">
                {items.map((item) => (
                  <li key={item.id} className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-medium text-text-secondary">
                        {isAgent(item) ? "🤖 " : ""}{author(item)}
                      </span>
                      <time
                        className="text-text-muted"
                        dateTime={item.createdAt}
                        data-testid="thread-item-timestamp"
                      >
                        {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
                      </time>
                      <Badge variant={item.kind === "interaction" ? "warning" : "default"}>
                        {item.kind}
                      </Badge>
                      {item.kind === "interaction" && item.status !== "pending" && (
                        <Badge variant="success">{item.status}</Badge>
                      )}
                    </div>
                    {item.content && (
                      <p className="mt-1.5 text-sm text-text-primary">
                        {renderMentionContent(item.content, item.mentions, companyId)}
                      </p>
                    )}
                    {/* Render artifact card(s) if the agent produced artifact(s) */}
                    {(() => {
                      const p = item.payload as Record<string, unknown>;
                      // VAL-CROSS-007: render ALL artifacts from payload.artifacts[]
                      // (agent can produce multiple). Fall back to single
                      // payload.artifactId/artifactType for backward compat.
                      const artifactsList = Array.isArray(p?.artifacts)
                        ? (p.artifacts as Array<{ artifactId: string; artifactType: string }>)
                        : p?.artifactId != null && p?.artifactType != null
                          ? [{ artifactId: String(p.artifactId), artifactType: String(p.artifactType) }]
                          : [];
                      return artifactsList.map((a) => (
                        <ThreadArtifactCard
                          key={a.artifactId}
                          artifactId={a.artifactId}
                          artifactType={a.artifactType}
                          companyId={companyId}
                          projectId={item.projectId ?? projectId}
                        />
                      ));
                    })()}
                    {/* VAL-CROSS-026: render task outcome link when agent
                        response includes task data alongside artifacts */}
                    {(() => {
                      const p = item.payload as Record<string, unknown>;
                      const taskId =
                        (p?.mentionDispatch as { taskId?: string } | undefined)?.taskId ??
                        (typeof p?.taskId === "string" ? p.taskId : undefined);
                      if (!taskId) return null;
                      return (
                        <Link
                          to={`/company/${companyId}/tasks/${encodeURIComponent(taskId)}`}
                          data-testid="thread-task-link"
                          data-task-id={taskId}
                          className="mt-2 flex items-center gap-3 rounded-lg border border-white/[0.08] bg-white/[0.02] p-3 transition-colors hover:border-accent/30 hover:bg-accent/[0.04]"
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
                      );
                    })()}
                    {/* VAL-MEETING-015: render meeting card when the agent
                        response references a meeting outcome (summarize /
                        action-items / create). */}
                    {(() => {
                      const p = item.payload as Record<string, unknown>;
                      const meetingId =
                        typeof p?.meetingId === "string"
                          ? p.meetingId
                          : Array.isArray(p?.meetings) && (p.meetings as Array<{ meetingId: string }>)[0]?.meetingId;
                      if (!meetingId) return null;
                      return (
                        <ThreadMeetingCard
                          key={`meeting-${meetingId}`}
                          meetingId={meetingId}
                          companyId={companyId}
                          projectId={item.projectId ?? projectId}
                        />
                      );
                    })()}
                    <InteractionActions
                      item={item}
                      onResolve={(status) => resolveInteraction(item, status)}
                      disabled={resolveItem.isPending}
                    />
                  </li>
                ))}
              </ul>
            )}
            {createItem.isError && (
              <p role="alert" className="text-sm text-error">
                Could not post your comment. Your draft is preserved so you can try again.
              </p>
            )}
            {resolveItem.isError && (
              <p role="alert" className="text-sm text-error">
                Could not resolve the interaction. Please try again.
              </p>
            )}
            <form onSubmit={submit} className="relative flex gap-2 border-t border-white/[0.06] pt-3">
              <label className="sr-only" htmlFor="thread-comment">Post a comment</label>
              <input
                ref={inputRef}
                id="thread-comment"
                aria-label="Post a comment"
                value={composer.text}
                onChange={(event) => handleTextChange(event.target.value)}
                placeholder="Write a comment… use @ to mention"
                className="h-9 min-w-0 flex-1 rounded-md border border-white/10 bg-white/[0.03] px-3 text-sm text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus:border-accent/60"
              />
              {showPicker && (
                <MentionPicker
                  companyId={companyId}
                  query={mentionQuery}
                  onSelect={handleMentionSelect}
                  onClose={() => setShowPicker(false)}
                  anchorRect={pickerAnchor}
                />
              )}
              <Button
                type="submit"
                aria-label="Post comment"
                disabled={!trimmedText || createItem.isPending || !targetThreadId}
                loading={createItem.isPending}
                icon={<Send className="h-3.5 w-3.5" />}
              >
                Post
              </Button>
            </form>
            {/* Show active mention chips below the input. Artifact mentions
                render as inline ThreadArtifactCard references; agent/user
                mentions render as compact chips. */}
            {composer.mentions.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {composer.mentions.map((m, i) =>
                  m.entityType === "artifact" ? (
                    <ThreadArtifactCard
                      key={`composer-artifact-${i}`}
                      artifactId={m.entityId}
                      artifactType={m.artifactType ?? "document"}
                      companyId={companyId}
                      projectId={projectId}
                    />
                  ) : (
                    <MentionChip key={i} entityType={m.entityType} label={m.label} />
                  ),
                )}
              </div>
            )}
          </div>
        )}
      </Card>
    </section>
  );
}
