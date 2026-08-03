import { useState } from "react";
import { MessageCircle, Send } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useCreateThreadItem, useProjectThread, useProjectThreads, useUpdateThreadItem } from "@/lib/hooks";
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
}: {
  item: ProjectThreadItem;
  onResolve: (status: "accepted" | "rejected" | "answered") => void;
}) {
  if (item.kind !== "interaction" || item.status !== "pending") return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      <Button size="sm" onClick={() => onResolve("accepted")} aria-label="Accept interaction">Accept</Button>
      <Button size="sm" variant="danger" onClick={() => onResolve("rejected")} aria-label="Reject interaction">Reject</Button>
      <Button size="sm" variant="secondary" onClick={() => onResolve("answered")} aria-label="Answer interaction">Answer</Button>
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
  const threads = useProjectThreads?.(companyId, projectId, { status: "active" }) ?? {
    data: [],
    isLoading: false,
    isError: false,
  };
  const threadId = threads.data?.[0]?.id;
  const thread = useProjectThread?.(companyId, projectId, threadId) ?? {
    data: undefined,
    isLoading: false,
    isError: false,
  };
  const createItem = useCreateThreadItem?.(companyId, projectId, threadId ?? "") ?? {
    isPending: false,
    mutate: () => undefined,
  };
  const updateItem = useUpdateThreadItem?.(companyId, projectId, threadId ?? "") ?? {
    isPending: false,
    mutate: () => undefined,
  };
  const [content, setContent] = useState("");
  const items = thread.data?.items ?? [];

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = content.trim();
    if (!trimmed || !threadId || createItem.isPending) return;
    createItem.mutate({ kind: "comment", content: trimmed });
    setContent("");
  }

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
        {threads.isLoading || (threadId && thread.isLoading) ? (
          <div className="py-5 text-sm text-text-muted" role="status">Loading conversation…</div>
        ) : threads.isError || (threadId && thread.isError) ? (
          <div className="py-5 text-sm text-error">Conversation could not be loaded.</div>
        ) : !threadId ? (
          <div className="py-5 text-sm text-text-muted" role="status">No conversation yet</div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-text-muted">{thread.data?.title ?? "Project thread"}</p>
            {items.length === 0 ? (
              <p className="py-3 text-sm text-text-muted">No messages yet</p>
            ) : (
              <ul className="space-y-2" aria-label="Thread messages">
                {items.map((item) => (
                  <li key={item.id} className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-medium text-text-secondary">{author(item)}</span>
                      <span className="text-text-muted">
                        {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
                      </span>
                      <Badge variant={item.kind === "interaction" ? "warning" : "default"}>{item.kind}</Badge>
                      {item.kind === "interaction" && item.status !== "pending" && (
                        <Badge variant="success">{item.status}</Badge>
                      )}
                    </div>
                    {item.content && <p className="mt-1.5 text-sm text-text-primary">{item.content}</p>}
                    <InteractionActions
                      item={item}
                      onResolve={(status) => updateItem.mutate({ itemId: item.id, data: { status } })}
                    />
                  </li>
                ))}
              </ul>
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
                disabled={!content.trim() || createItem.isPending}
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
