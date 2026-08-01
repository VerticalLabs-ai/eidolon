import { useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useCreateGoal, useUpdateGoal } from "@/lib/hooks";
import type { Agent, Goal, GoalLevel, GoalStatus } from "@/lib/api";

interface GoalFormModalProps {
  agents: Agent[];
  companyId: string;
  projectId?: string;
  defaultParentId?: string;
  goal?: Goal;
  goals: Goal[];
  onClose: () => void;
  ownerDataState?: "ready" | "loading" | "error";
}

const goalLevels: { value: GoalLevel; label: string }[] = [
  { value: "company", label: "Company" },
  { value: "department", label: "Department" },
  { value: "team", label: "Team" },
  { value: "individual", label: "Individual" },
];

const goalStatuses: { value: GoalStatus; label: string }[] = [
  { value: "draft", label: "Draft" },
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

const goalLevelRank: Record<GoalLevel, number> = {
  company: 0,
  department: 1,
  team: 2,
  individual: 3,
};

const goalSchema = z.object({
  title: z.string().trim().min(1, "Enter a goal title.").max(500, "Use 500 characters or fewer."),
  description: z.string().max(5000, "Use 5,000 characters or fewer."),
  level: z.enum(["company", "department", "team", "individual"]),
  status: z.enum(["draft", "active", "completed", "cancelled"]),
  parentId: z.union([z.literal(""), z.uuid("Choose a valid parent goal.")]),
  ownerAgentId: z.union([z.literal(""), z.uuid("Choose a valid owner.")]),
  progress: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.coerce.number({ error: "Enter progress from 0 to 100." })
      .int("Use a whole percentage.")
      .min(0, "Enter progress from 0 to 100.")
      .max(100, "Enter progress from 0 to 100."),
  ),
});

type GoalFormErrors = Partial<Record<keyof z.infer<typeof goalSchema>, string>>;

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1.5 text-xs text-error">
      {message}
    </p>
  );
}

function collectDescendantIds(goals: Goal[], rootId: string) {
  const descendants = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    for (const goal of goals) {
      if (goal.parentId === parentId && !descendants.has(goal.id)) {
        descendants.add(goal.id);
        queue.push(goal.id);
      }
    }
  }
  return descendants;
}

function childLevel(parent?: Goal): GoalLevel | null {
  if (!parent) return "company";
  return {
    company: "department",
    department: "team",
    team: "individual",
    individual: null,
  }[parent.level] as GoalLevel | null;
}

export function GoalFormModal({
  agents,
  companyId,
  projectId,
  defaultParentId,
  goal,
  goals,
  onClose,
  ownerDataState = "ready",
}: GoalFormModalProps) {
  const defaultParent = goals.find((item) => item.id === defaultParentId);
  const [title, setTitle] = useState(goal?.title ?? "");
  const [description, setDescription] = useState(goal?.description ?? "");
  const [level, setLevel] = useState<GoalLevel>(goal?.level ?? childLevel(defaultParent) ?? "individual");
  const [status, setStatus] = useState<GoalStatus>(goal?.status ?? "draft");
  const [parentId, setParentId] = useState(goal?.parentId ?? defaultParentId ?? "");
  const [ownerAgentId, setOwnerAgentId] = useState(goal?.ownerAgentId ?? "");
  const [progress, setProgress] = useState(String(goal?.progress ?? 0));
  const [errors, setErrors] = useState<GoalFormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const createMutation = useCreateGoal(companyId);
  const updateMutation = useUpdateGoal(companyId);
  const isPending = createMutation.isPending || updateMutation.isPending;

  const unavailableParents = goal ? collectDescendantIds(goals, goal.id) : new Set<string>();
  if (goal) unavailableParents.add(goal.id);
  const parentOptions = [
    { value: "", label: "No parent (root goal)" },
    ...goals
      .filter(
        (item) => !unavailableParents.has(item.id)
          && goalLevelRank[item.level] < goalLevelRank[level],
      )
      .map((item) => ({ value: item.id, label: item.title })),
  ];
  const currentOwnerIsUnavailable = Boolean(
    goal?.ownerAgentId && !agents.some((agent) => agent.id === goal.ownerAgentId),
  );
  const ownerOptions = [
    { value: "", label: "Unassigned" },
    ...(currentOwnerIsUnavailable && goal?.ownerAgentId
      ? [{
          value: goal.ownerAgentId,
          label: ownerDataState === "loading" ? "Current owner (loading)" : "Current owner (unavailable)",
        }]
      : []),
    ...agents.map((agent) => ({ value: agent.id, label: agent.name })),
  ];

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitError(null);

    const parsed = goalSchema.safeParse({
      title,
      description,
      level,
      status,
      parentId,
      ownerAgentId,
      progress,
    });
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      setErrors({
        title: fieldErrors.title?.[0],
        description: fieldErrors.description?.[0],
        level: fieldErrors.level?.[0],
        status: fieldErrors.status?.[0],
        parentId: fieldErrors.parentId?.[0],
        ownerAgentId: fieldErrors.ownerAgentId?.[0],
        progress: fieldErrors.progress?.[0],
      });
      return;
    }

    if (parsed.data.parentId) {
      const selectedParent = goals.find((item) => item.id === parsed.data.parentId);
      if (
        !selectedParent
        || goalLevelRank[parsed.data.level] <= goalLevelRank[selectedParent.level]
      ) {
        setErrors({ parentId: "Choose a parent above this goal's level." });
        return;
      }
    }

    setErrors({});
    const sharedData = {
      title: parsed.data.title,
      description: parsed.data.description.trim(),
      level: parsed.data.level,
      status: parsed.data.status,
      parentId: parsed.data.parentId || null,
      ownerAgentId: parsed.data.ownerAgentId || null,
      progress: parsed.data.progress,
      ...(projectId ? { projectId } : {}),
    };
    const callbacks = {
      onSuccess: onClose,
      onError: (error: Error) => {
        setSubmitError(error.message || "Goal changes could not be saved. Try again.");
      },
    };

    if (goal) {
      updateMutation.mutate(
        {
          goalId: goal.id,
          data: { ...sharedData, description: sharedData.description || null },
        },
        callbacks,
      );
    } else {
      createMutation.mutate(
        {
          ...sharedData,
          description: sharedData.description || undefined,
        },
        callbacks,
      );
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={goal ? "Edit Goal" : defaultParentId ? "Add Child Goal" : "Create Goal"}
      dismissible={!isPending}
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Input
            label="Title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-invalid={!!errors.title}
            aria-describedby={errors.title ? "goal-title-error" : undefined}
            autoFocus
            disabled={isPending}
            maxLength={500}
            required
          />
          <FieldError id="goal-title-error" message={errors.title} />
        </div>

        <div>
          <Textarea
            label="Description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            aria-invalid={!!errors.description}
            aria-describedby={errors.description ? "goal-description-error" : undefined}
            disabled={isPending}
            maxLength={5000}
            rows={3}
          />
          <FieldError id="goal-description-error" message={errors.description} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Select
              label="Level"
              options={goalLevels}
              value={level}
              onChange={(event) => setLevel(event.target.value as GoalLevel)}
              aria-invalid={!!errors.level}
              aria-describedby={errors.level ? "goal-level-error" : undefined}
              disabled={isPending}
            />
            <FieldError id="goal-level-error" message={errors.level} />
          </div>
          <div>
            <Select
              label="Status"
              options={goalStatuses}
              value={status}
              onChange={(event) => setStatus(event.target.value as GoalStatus)}
              aria-invalid={!!errors.status}
              aria-describedby={errors.status ? "goal-status-error" : undefined}
              disabled={isPending}
            />
            <FieldError id="goal-status-error" message={errors.status} />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Select
              label="Parent goal"
              options={parentOptions}
              value={parentId}
              onChange={(event) => setParentId(event.target.value)}
              aria-invalid={!!errors.parentId}
              aria-describedby={errors.parentId ? "goal-parent-error" : undefined}
              disabled={isPending}
            />
            <FieldError id="goal-parent-error" message={errors.parentId} />
          </div>
          <div>
            <Select
              label="Owner"
              options={ownerOptions}
              value={ownerAgentId}
              onChange={(event) => setOwnerAgentId(event.target.value)}
              aria-invalid={!!errors.ownerAgentId}
              aria-describedby={errors.ownerAgentId ? "goal-owner-error" : undefined}
              disabled={isPending || ownerDataState !== "ready"}
            />
            <FieldError id="goal-owner-error" message={errors.ownerAgentId} />
            {ownerDataState !== "ready" && (
              <p className="mt-1.5 text-xs text-text-secondary">
                Owner changes are unavailable until the agent directory {ownerDataState === "loading" ? "loads" : "can be loaded"}.
              </p>
            )}
          </div>
        </div>

        <div>
          <Input
            label="Progress (%)"
            type="number"
            min={0}
            max={100}
            step={1}
            value={progress}
            onChange={(event) => setProgress(event.target.value)}
            aria-invalid={!!errors.progress}
            aria-describedby={errors.progress ? "goal-progress-error" : undefined}
            disabled={isPending}
            inputMode="numeric"
          />
          <FieldError id="goal-progress-error" message={errors.progress} />
        </div>

        {submitError && (
          <div
            role="alert"
            aria-live="polite"
            className="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error"
          >
            Goal changes were not saved: {submitError} Your entries are still here.
          </div>
        )}

        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button type="submit" loading={isPending}>
            {goal ? "Save Changes" : "Create Goal"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
