import { useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { useCreateProjectThread } from "@/lib/hooks";
import { Button } from "@/components/ui/Button";
import type { ProjectThreadType } from "@/lib/api";

const threadTypes: { value: ProjectThreadType; label: string }[] = [
  { value: "conversation", label: "Conversation" },
  { value: "plan_review", label: "Plan review" },
  { value: "decision_review", label: "Decision review" },
  { value: "standup", label: "Standup" },
];

export function ProjectThreadComposer({
  companyId,
  projectId,
}: {
  companyId: string;
  projectId: string;
}) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<ProjectThreadType>("conversation");
  const createThread = useCreateProjectThread?.(companyId, projectId) ?? {
    isPending: false,
    mutate: () => undefined,
  };
  const trimmedTitle = title.trim();

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trimmedTitle || createThread.isPending) return;
    createThread.mutate({ title: trimmedTitle, type });
    setTitle("");
  }

  return (
    <section aria-label="Create project thread" data-testid="project-thread-composer">
      <form onSubmit={submit} className="space-y-3">
        <div className="flex items-center gap-2">
          <MessageSquarePlus className="h-4 w-4 text-accent" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-text-primary">New thread</h2>
        </div>
        <label className="block text-xs text-text-secondary" htmlFor="thread-title">
          Thread title
        </label>
        <input
          id="thread-title"
          aria-label="Thread title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="What should this conversation cover?"
          className="h-9 w-full rounded-md border border-white/10 bg-white/[0.03] px-3 text-sm text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus:border-accent/60"
        />
        <label className="block text-xs text-text-secondary" htmlFor="thread-type">
          Thread type
        </label>
        <select
          id="thread-type"
          aria-label="Thread type"
          value={type}
          onChange={(event) => setType(event.target.value as ProjectThreadType)}
          className="h-9 w-full rounded-md border border-white/10 bg-surface px-3 text-sm text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus:border-accent/60"
        >
          {threadTypes.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <Button type="submit" disabled={!trimmedTitle} loading={createThread.isPending}>
          Create thread
        </Button>
      </form>
    </section>
  );
}
