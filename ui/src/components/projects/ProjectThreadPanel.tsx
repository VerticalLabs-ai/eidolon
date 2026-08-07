import { useEffect, useRef, useState, useMemo } from "react";
import { MessageCircle, Send } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import {
  useCreateThreadItem,
  useProjectThreadItems,
  useResolveThreadItem,
} from "@/lib/hooks";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { MentionPicker, MentionChip } from "./MentionPicker";
import { ThreadArtifactCard } from "./ThreadArtifactCard";
import type { ProjectThreadItem, MentionableEntity } from "@/lib/api";

function author(item: ProjectThreadItem) {
  return item.authorUserId ?? item.authorAgentId ?? "Unknown author";
}

function isAgent(item: ProjectThreadItem) {
  return !!item.authorAgentId;
}

/** Render content with mention chips inline. */
function renderContent(content: string, mentions?: ProjectThreadItem["mentions"]): React.ReactNode {
  if (!mentions || mentions.length === 0) return content;

  // Build a regex that matches any mention label prefixed with @
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
  mentions: Array<{ entityType: "agent" | "user"; entityId: string; label: string }>;
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
      mentions: [...prev.mentions, { entityType: entity.entityType, entityId: entity.entityId, label: entity.label }],
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
                        {renderContent(item.content, item.mentions)}
                      </p>
                    )}
                    {/* Render artifact card if the agent produced an artifact */}
                    {item.payload?.artifactId != null && item.payload?.artifactType != null && (
                      <ThreadArtifactCard
                        artifactId={String(item.payload.artifactId)}
                        artifactType={String(item.payload.artifactType)}
                        companyId={companyId}
                        projectId={item.projectId ?? projectId}
                      />
                    )}
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
                className="h-9 min-w-0 flex-1 rounded-md border border-white/10 bg-white/[0.03] px-3 text-sm text-text-primary outline-none focus:border-accent/60"
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
            {/* Show active mention chips below the input */}
            {composer.mentions.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {composer.mentions.map((m, i) => (
                  <MentionChip key={i} entityType={m.entityType} label={m.label} />
                ))}
              </div>
            )}
          </div>
        )}
      </Card>
    </section>
  );
}
