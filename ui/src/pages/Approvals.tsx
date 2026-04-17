import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  ShieldCheck,
  Clock,
  Check,
  X as XIcon,
  Plus,
  MessageSquare,
} from "lucide-react";
import { clsx } from "clsx";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageTransition } from "@/components/ui/PageTransition";
import { Tabs, type Tab } from "@/components/ui/Tabs";
import {
  useApprovals,
  useApproval,
  useCreateApproval,
  useDecideApproval,
  useCancelApproval,
  useAddApprovalComment,
} from "@/lib/hooks";
import type {
  Approval,
  ApprovalKind,
  ApprovalPriority,
  ApprovalStatus,
} from "@/lib/api";

const statusTabs: Tab[] = [
  { id: "pending", label: "Pending" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
  { id: "cancelled", label: "Cancelled" },
];

const kindLabels: Record<ApprovalKind, string> = {
  budget_change: "Budget change",
  agent_termination: "Agent termination",
  task_review: "Task review",
  custom: "Custom",
};

const priorityVariant: Record<
  ApprovalPriority,
  "info" | "warning" | "error" | "success"
> = {
  low: "info",
  medium: "info",
  high: "warning",
  critical: "error",
};

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function ApprovalRow({
  approval,
  selected,
  onSelect,
}: {
  approval: Approval;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={clsx(
        "w-full rounded-lg border px-4 py-3 text-left transition-all duration-200",
        selected
          ? "border-accent/40 bg-accent/[0.05]"
          : "border-white/[0.06] hover:border-white/[0.12] hover:bg-white/[0.02]",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium text-text-primary">
              {approval.title}
            </p>
            <Badge variant={priorityVariant[approval.priority]}>
              {approval.priority}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-text-secondary">
            {kindLabels[approval.kind]} · {formatRelative(approval.createdAt)}
          </p>
        </div>
      </div>
    </button>
  );
}

function ApprovalDetail({
  companyId,
  approvalId,
}: {
  companyId: string;
  approvalId: string;
}) {
  const { data, isLoading } = useApproval(companyId, approvalId);
  const decide = useDecideApproval(companyId);
  const cancel = useCancelApproval(companyId);
  const addComment = useAddApprovalComment(companyId);
  const [note, setNote] = useState("");
  const [comment, setComment] = useState("");

  if (isLoading || !data) {
    return (
      <Card className="h-full p-6">
        <p className="text-sm text-text-secondary">Loading approval…</p>
      </Card>
    );
  }

  const { approval, comments } = data;
  const isPending = approval.status === "pending";

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-white/[0.06] p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-text-primary">
              {approval.title}
            </h2>
            <div className="mt-1 flex items-center gap-2 text-xs text-text-secondary">
              <Badge variant={priorityVariant[approval.priority]}>
                {approval.priority}
              </Badge>
              <span>·</span>
              <span>{kindLabels[approval.kind]}</span>
              <span>·</span>
              <span>{approval.status}</span>
            </div>
          </div>
        </div>
        {approval.description && (
          <p className="mt-3 whitespace-pre-wrap text-sm text-text-secondary">
            {approval.description}
          </p>
        )}
        {Object.keys(approval.payload).length > 0 && (
          <pre className="mt-3 max-h-40 overflow-auto rounded-md bg-black/40 p-3 text-[11px] leading-relaxed text-text-secondary">
            {JSON.stringify(approval.payload, null, 2)}
          </pre>
        )}
        {approval.resolutionNote && (
          <p className="mt-3 rounded-md border border-white/[0.06] bg-white/[0.02] p-3 text-xs text-text-secondary">
            <span className="font-medium text-text-primary">Resolution:</span>{" "}
            {approval.resolutionNote}
          </p>
        )}
      </div>

      {isPending && (
        <div className="space-y-3 border-b border-white/[0.06] p-5">
          <Textarea
            label="Resolution note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add context before deciding…"
            rows={2}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() =>
                decide.mutate(
                  { id: approval.id, decision: "approved", resolutionNote: note },
                  { onSuccess: () => setNote("") },
                )
              }
              disabled={decide.isPending}
            >
              <Check className="mr-1.5 h-4 w-4" />
              Approve
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                decide.mutate(
                  { id: approval.id, decision: "rejected", resolutionNote: note },
                  { onSuccess: () => setNote("") },
                )
              }
              disabled={decide.isPending}
            >
              <XIcon className="mr-1.5 h-4 w-4" />
              Reject
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                cancel.mutate(
                  { id: approval.id, resolutionNote: note },
                  { onSuccess: () => setNote("") },
                )
              }
              disabled={cancel.isPending}
            >
              Cancel request
            </Button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto p-5">
        <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-text-secondary">
          <MessageSquare className="h-3.5 w-3.5" />
          Comments ({comments.length})
        </div>
        <div className="space-y-2">
          {comments.length === 0 && (
            <p className="text-xs text-text-secondary">No comments yet.</p>
          )}
          {comments.map((c) => (
            <div
              key={c.id}
              className="rounded-md border border-white/[0.06] bg-white/[0.02] p-3"
            >
              <p className="text-[11px] text-text-secondary">
                {c.authorAgentId ? `agent ${c.authorAgentId.slice(0, 6)}` : "user"} ·{" "}
                {formatRelative(c.createdAt)}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-text-primary">
                {c.content}
              </p>
            </div>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!comment.trim()) return;
            addComment.mutate(
              { id: approval.id, content: comment.trim() },
              { onSuccess: () => setComment("") },
            );
          }}
          className="mt-4 flex gap-2"
        >
          <Input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Add a comment…"
            className="flex-1"
          />
          <Button type="submit" disabled={addComment.isPending}>
            Post
          </Button>
        </form>
      </div>
    </Card>
  );
}

function NewApprovalModal({
  companyId,
  open,
  onClose,
}: {
  companyId: string;
  open: boolean;
  onClose: () => void;
}) {
  const mutation = useCreateApproval(companyId);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<ApprovalKind>("custom");
  const [priority, setPriority] = useState<ApprovalPriority>("medium");

  function reset() {
    setTitle("");
    setDescription("");
    setKind("custom");
    setPriority("medium");
  }

  return (
    <Modal open={open} onClose={onClose} title="Request approval">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          mutation.mutate(
            {
              title: title.trim(),
              description: description.trim() || undefined,
              kind,
              priority,
            },
            {
              onSuccess: () => {
                reset();
                onClose();
              },
            },
          );
        }}
        className="space-y-4"
      >
        <Input
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Increase CTO budget to $25k/mo"
          required
        />
        <Textarea
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Why is this needed?"
          rows={3}
        />
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as ApprovalKind)}
            options={[
              { value: "custom", label: "Custom" },
              { value: "budget_change", label: "Budget change" },
              { value: "agent_termination", label: "Agent termination" },
              { value: "task_review", label: "Task review" },
            ]}
          />
          <Select
            label="Priority"
            value={priority}
            onChange={(e) =>
              setPriority(e.target.value as ApprovalPriority)
            }
            options={[
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
              { value: "critical", label: "Critical" },
            ]}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            Submit request
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function Approvals() {
  const { companyId } = useParams();
  const [activeStatus, setActiveStatus] = useState<ApprovalStatus>("pending");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const { data: approvals, isLoading } = useApprovals(companyId, activeStatus);

  const visible = useMemo(() => approvals ?? [], [approvals]);
  const selected =
    visible.find((a) => a.id === selectedId) ?? visible[0] ?? null;

  return (
    <PageTransition>
      <div className="flex h-full flex-col">
        <div className="shrink-0 bg-surface">
          <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-success/15">
                <ShieldCheck className="h-4 w-4 text-success" />
              </div>
              <div>
                <h1 className="text-lg font-bold text-text-primary font-display tracking-wide">
                  Approvals
                </h1>
                <p className="text-[11px] text-text-secondary">
                  Governance queue for budget changes, terminations, and reviews
                </p>
              </div>
            </div>
            <Button onClick={() => setCreating(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              New request
            </Button>
          </div>
          <Tabs
            tabs={statusTabs}
            activeTab={activeStatus}
            onTabChange={(id) => {
              setActiveStatus(id as ApprovalStatus);
              setSelectedId(null);
            }}
          />
        </div>

        <div className="grid flex-1 grid-cols-[minmax(0,320px)_1fr] gap-4 overflow-hidden p-5">
          <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
            {isLoading ? (
              <p className="text-sm text-text-secondary">Loading…</p>
            ) : visible.length === 0 ? (
              <EmptyState
                icon={<Clock className="h-6 w-6" />}
                title={`No ${activeStatus} approvals`}
                description={
                  activeStatus === "pending"
                    ? "Nothing is waiting on a decision right now."
                    : `You'll see ${activeStatus} requests here.`
                }
              />
            ) : (
              visible.map((a) => (
                <ApprovalRow
                  key={a.id}
                  approval={a}
                  selected={(selected?.id ?? null) === a.id}
                  onSelect={() => setSelectedId(a.id)}
                />
              ))
            )}
          </div>

          <div className="min-h-0 overflow-hidden">
            {selected ? (
              <ApprovalDetail companyId={companyId!} approvalId={selected.id} />
            ) : (
              <Card className="flex h-full items-center justify-center p-6">
                <p className="text-sm text-text-secondary">
                  Select an approval to see details.
                </p>
              </Card>
            )}
          </div>
        </div>

        <NewApprovalModal
          companyId={companyId!}
          open={creating}
          onClose={() => setCreating(false)}
        />
      </div>
    </PageTransition>
  );
}
