import { useEffect, useState } from "react";
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
import type { ProjectThreadItem } from "@/lib/api";

function author(item: ProjectThreadItem) {
  return item.authorUserId ?? item.authorAgentId ?? "Unknown author";
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

  // Composer targets the first active conversation thread, falling back to the
  // first active thread of any type. Items are aggregated across all threads.
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

  const [content, setContent] = useState("");

  // Clear the draft only after a successful post. A failed mutation preserves
  // the user's text so they can retry.
  useEffect(() => {
    if (createItem.isSuccess) {
      setContent("");
      createItem.reset?.();
    }
  }, [createItem.isSuccess]); // only re-run when success state flips on

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = content.trim();
    if (!trimmed || !targetThreadId || createItem.isPending) return;
    createItem.mutate({ kind: "comment", content: trimmed });
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
                      <span className="font-medium text-text-secondary">{author(item)}</span>
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
                    {item.content && <p className="mt-1.5 text-sm text-text-primary">{item.content}</p>}
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
            <form onSubmit={submit} className="flex gap-2 border-t border-white/[0.06] pt-3">
              <label className="sr-only" htmlFor="thread-comment">Post a comment</label>
              <input
                id="thread-comment"
                aria-label="Post a comment"
                value={content}
                onChange={(event) => setContent(event.target.value)}
                placeholder="Write a comment…"
                className="h-9 min-w-0 flex-1 rounded-md border border-white/10 bg-white/[0.03] px-3 text-sm text-text-primary outline-none focus:border-accent/60"
              />
              <Button
                type="submit"
                aria-label="Post comment"
                disabled={!content.trim() || createItem.isPending || !targetThreadId}
                loading={createItem.isPending}
                icon={<Send className="h-3.5 w-3.5" />}
              >
                Post
              </Button>
            </form>
          </div>
        )}
      </Card>
    </section>
  );
}
