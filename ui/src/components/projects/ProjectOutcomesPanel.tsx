import { useState } from "react";
import {
  ClipboardCheck,
  Check,
  ExternalLink,
  FileText,
  GitPullRequest,
  Package,
  Plus,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  useProjectOutcomes,
  useCreateProjectOutcome,
  useUpdateProjectOutcome,
} from "@/lib/hooks";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import type {
  ProjectOutcome,
  ProjectOutcomeStatus,
  ProjectOutcomeType,
} from "@/lib/api";

const typeFilters: Array<"all" | ProjectOutcomeType> = [
  "all",
  "document",
  "pull_request",
  "audit",
  "review",
  "delivery_summary",
];

const typeIcon: Record<ProjectOutcomeType, React.ReactNode> = {
  document: <FileText className="h-4 w-4" />,
  pull_request: <GitPullRequest className="h-4 w-4" />,
  audit: <ShieldCheck className="h-4 w-4" />,
  review: <ClipboardCheck className="h-4 w-4" />,
  delivery_summary: <Package className="h-4 w-4" />,
};

const typeLabel: Record<ProjectOutcomeType, string> = {
  document: "Document",
  pull_request: "Pull request",
  audit: "Audit",
  review: "Review",
  delivery_summary: "Delivery summary",
};

const statusVariant: Record<
  ProjectOutcomeStatus,
  "default" | "success" | "warning" | "info" | "error"
> = {
  pending: "warning",
  completed: "success",
  failed: "error",
};

const statusLabel: Record<ProjectOutcomeStatus, string> = {
  pending: "Pending",
  completed: "Completed",
  failed: "Failed",
};

function OutcomeContext({ outcome }: { outcome: ProjectOutcome }) {
  const parts: string[] = [];
  if (outcome.taskId) parts.push(`Task: ${outcome.taskId}`);
  if (outcome.planId) parts.push(`Plan: ${outcome.planId}`);
  if (outcome.planStepId) parts.push(`Step: ${outcome.planStepId}`);
  if (parts.length === 0) return null;
  return (
    <p
      className="mt-1 text-[11px] text-text-muted"
      data-testid={`outcome-context-${outcome.id}`}
    >
      {parts.join(" · ")}
    </p>
  );
}

function OutcomeRow({
  outcome,
  onUpdateStatus,
  pending,
}: {
  outcome: ProjectOutcome;
  onUpdateStatus: (status: ProjectOutcomeStatus) => void;
  pending: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const canUpdate = outcome.status === "pending";

  return (
    <li
      className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3"
      data-testid={`outcome-${outcome.id}`}
    >
      <div className="flex items-start gap-3">
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent"
          data-testid={`outcome-type-icon-${outcome.type}`}
        >
          {typeIcon[outcome.type]}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-sm font-medium text-text-primary">{outcome.title}</h3>
            <span data-testid={`outcome-status-${outcome.status}`}>
              <Badge variant={statusVariant[outcome.status]}>
                {statusLabel[outcome.status]}
              </Badge>
            </span>
          </div>
          {outcome.description && (
            <p className="mt-1 text-xs leading-relaxed text-text-secondary">
              {outcome.description}
            </p>
          )}
          <OutcomeContext outcome={outcome} />
          {outcome.referenceUrl && (
            <a
              href={outcome.referenceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1.5 inline-flex items-center gap-1 text-xs text-accent hover:underline"
              data-testid={`outcome-reference-${outcome.id}`}
            >
              <span className="truncate max-w-xs">{outcome.referenceUrl}</span>
              <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
            </a>
          )}
        </div>
      </div>
      {canUpdate && (
        <div className="relative mt-2 flex justify-end">
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            loading={pending}
            onClick={() => setMenuOpen((open) => !open)}
            data-testid={`outcome-status-action-${outcome.id}`}
          >
            Update status
          </Button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-10 mt-1 w-40 rounded-md border border-white/[0.08] bg-surface p-1 shadow-lg">
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-text-primary hover:bg-white/[0.05]"
                onClick={() => {
                  setMenuOpen(false);
                  onUpdateStatus("completed");
                }}
                data-testid={`outcome-status-completed-${outcome.id}`}
              >
                <Check className="h-3 w-3 text-success" />
                Mark completed
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-text-primary hover:bg-white/[0.05]"
                onClick={() => {
                  setMenuOpen(false);
                  onUpdateStatus("failed");
                }}
                data-testid={`outcome-status-failed-${outcome.id}`}
              >
                <X className="h-3 w-3 text-error" />
                Mark failed
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function CreateOutcomeModal({
  open,
  onClose,
  onCreate,
  pending,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (data: {
    type: ProjectOutcomeType;
    title: string;
    description?: string;
    referenceUrl?: string;
  }) => void;
  pending: boolean;
}) {
  const [type, setType] = useState<ProjectOutcomeType>("document");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [referenceUrl, setReferenceUrl] = useState("");
  const trimmedTitle = title.trim();

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trimmedTitle || pending) return;
    onCreate({
      type,
      title: trimmedTitle,
      description: description.trim() || undefined,
      referenceUrl: referenceUrl.trim() || undefined,
    });
    setTitle("");
    setDescription("");
    setReferenceUrl("");
    setType("document");
  }

  return (
    <Modal open={open} onClose={onClose} title="Create outcome" dismissible={!pending}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="block text-xs text-text-secondary" htmlFor="outcome-type">
            Type
          </label>
          <select
            id="outcome-type"
            aria-label="Outcome type"
            value={type}
            onChange={(e) => setType(e.target.value as ProjectOutcomeType)}
            className="mt-1 h-9 w-full rounded-md border border-white/10 bg-surface px-3 text-sm text-text-primary outline-none focus:border-accent/60"
            data-testid="outcome-type-select"
          >
            {typeFilters
              .filter((value): value is ProjectOutcomeType => value !== "all")
              .map((value) => (
                <option key={value} value={value}>
                  {typeLabel[value]}
                </option>
              ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-text-secondary" htmlFor="outcome-title">
            Title
          </label>
          <input
            id="outcome-title"
            aria-label="Outcome title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What is the outcome?"
            className="mt-1 h-9 w-full rounded-md border border-white/10 bg-white/[0.03] px-3 text-sm text-text-primary outline-none focus:border-accent/60"
            data-testid="outcome-title-input"
          />
        </div>
        <div>
          <label className="block text-xs text-text-secondary" htmlFor="outcome-description">
            Description (optional)
          </label>
          <textarea
            id="outcome-description"
            aria-label="Outcome description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Add context…"
            rows={2}
            className="mt-1 w-full resize-none rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/60"
          />
        </div>
        <div>
          <label className="block text-xs text-text-secondary" htmlFor="outcome-reference-url">
            Reference URL (optional)
          </label>
          <input
            id="outcome-reference-url"
            aria-label="Reference URL"
            value={referenceUrl}
            onChange={(e) => setReferenceUrl(e.target.value)}
            placeholder="https://…"
            className="mt-1 h-9 w-full rounded-md border border-white/10 bg-white/[0.03] px-3 text-sm text-text-primary outline-none focus:border-accent/60"
            data-testid="outcome-reference-url-input"
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={!trimmedTitle || pending}
            loading={pending}
            aria-label="Save outcome"
          >
            Save outcome
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function ProjectOutcomesPanel({
  companyId,
  projectId,
}: {
  companyId: string;
  projectId: string;
}) {
  const [typeFilter, setTypeFilter] = useState<"all" | ProjectOutcomeType>("all");
  const [createOpen, setCreateOpen] = useState(false);

  const { data: outcomes, isLoading, isError } = useProjectOutcomes(
    companyId,
    projectId,
    typeFilter === "all" ? undefined : { type: typeFilter },
  );
  const createOutcome = useCreateProjectOutcome(companyId, projectId);
  const updateOutcome = useUpdateProjectOutcome(companyId, projectId);

  return (
    <section aria-label="Project outcomes" data-testid="project-outcomes-panel">
      <Card
        animated={false}
        header={
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/10 text-accent">
              <Package className="h-4 w-4" />
            </span>
            <h2 className="text-sm font-semibold text-text-primary font-display">Outcomes</h2>
          </div>
        }
      >
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div
            className="flex flex-wrap gap-1.5"
            role="group"
            aria-label="Outcome type filter"
          >
            {typeFilters.map((value) => (
              <button
                key={value}
                type="button"
                className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                  typeFilter === value
                    ? "bg-accent/20 text-accent"
                    : "bg-white/[0.04] text-text-muted hover:text-text-primary"
                }`}
                aria-pressed={typeFilter === value}
                onClick={() => setTypeFilter(value)}
                data-testid={`outcome-filter-${value}`}
              >
                {value === "all" ? "All" : typeLabel[value]}
              </button>
            ))}
          </div>
          <div className="ml-auto">
            <Button
              size="sm"
              icon={<Plus className="h-3 w-3" />}
              onClick={() => setCreateOpen(true)}
              aria-label="Create outcome"
            >
              New outcome
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="py-5 text-sm text-text-muted" role="status">
            Loading outcomes…
          </div>
        ) : isError ? (
          <div className="py-5 text-sm text-error">Outcomes could not be loaded.</div>
        ) : !outcomes || outcomes.length === 0 ? (
          <div className="py-5 text-sm text-text-muted" role="status">
            No outcomes yet
          </div>
        ) : (
          <ul className="space-y-2">
            {outcomes.map((outcome) => (
              <OutcomeRow
                key={outcome.id}
                outcome={outcome}
                pending={updateOutcome.isPending}
                onUpdateStatus={(status) =>
                  updateOutcome.mutate({ outcomeId: outcome.id, data: { status } })
                }
              />
            ))}
          </ul>
        )}
      </Card>

      <CreateOutcomeModal
        open={createOpen}
        pending={createOutcome.isPending}
        onClose={() => setCreateOpen(false)}
        onCreate={(data) => {
          createOutcome.mutate(data);
          setCreateOpen(false);
        }}
      />
    </section>
  );
}
