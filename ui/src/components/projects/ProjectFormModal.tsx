import { useEffect, useState } from "react";
import { z } from "zod";
import { Modal } from "@/components/ui/Modal";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useCreateProject, useUpdateProject } from "@/lib/hooks";
import type { Project, ProjectStatus } from "@/lib/api";

interface ProjectFormModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: (project: Project) => void;
  companyId: string;
  project?: Project;
}

const projectStatuses: { value: ProjectStatus; label: string }[] = [
  { value: "planning", label: "Planning" },
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" },
];

const projectSchema = z.object({
  name: z.string().trim().min(1, "Enter a project name.").max(255, "Use 255 characters or fewer."),
  description: z.string().max(5000, "Use 5,000 characters or fewer."),
  status: z.enum(["planning", "active", "completed"]),
  repoUrl: z.union([
    z.literal(""),
    z.url("Enter a complete repository URL, such as https://github.com/org/repo."),
  ]),
});

type ProjectFormErrors = Partial<Record<keyof z.infer<typeof projectSchema>, string>>;

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;

  return (
    <p id={id} role="alert" className="mt-1.5 text-xs text-error">
      {message}
    </p>
  );
}

export function ProjectFormModal({
  open,
  onClose,
  onSaved,
  companyId,
  project,
}: ProjectFormModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<ProjectStatus>("planning");
  const [repoUrl, setRepoUrl] = useState("");
  const [errors, setErrors] = useState<ProjectFormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const createMutation = useCreateProject(companyId);
  const updateMutation = useUpdateProject(companyId);
  const isEditing = !!project;
  const isPending = createMutation.isPending || updateMutation.isPending;

  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? "");
    setDescription(project?.description ?? "");
    setStatus(project?.status === "archived" ? "planning" : (project?.status ?? "planning"));
    setRepoUrl(project?.repoUrl ?? "");
    setErrors({});
    setSubmitError(null);
  }, [open, project]);

  function resetForm() {
    setName("");
    setDescription("");
    setStatus("planning");
    setRepoUrl("");
    setErrors({});
    setSubmitError(null);
    createMutation.reset();
    updateMutation.reset();
  }

  function handleClose() {
    resetForm();
    onClose();
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitError(null);

    const parsed = projectSchema.safeParse({ name, description, status, repoUrl });
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      setErrors({
        name: fieldErrors.name?.[0],
        description: fieldErrors.description?.[0],
        status: fieldErrors.status?.[0],
        repoUrl: fieldErrors.repoUrl?.[0],
      });
      return;
    }

    setErrors({});
    const data = {
      name: parsed.data.name,
      description: parsed.data.description.trim() || null,
      status: parsed.data.status,
      repoUrl: parsed.data.repoUrl || null,
    };
    const callbacks = {
      onSuccess: (savedProject: Project) => {
        resetForm();
        onClose();
        onSaved(savedProject);
      },
      onError: (error: Error) => {
        setSubmitError(
          error instanceof Error
            ? error.message
            : `Project ${isEditing ? "update" : "creation"} failed. Check your connection and try again.`,
        );
      },
    };

    if (project) {
      updateMutation.mutate({ projectId: project.id, data }, callbacks);
    } else {
      createMutation.mutate(
        { ...data, description: data.description ?? undefined },
        callbacks,
      );
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={isEditing ? "Edit Project" : "Create Project"}
      dismissible={!isPending}
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Input
            label="Project name"
            placeholder="e.g., Runtime reliability"
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? "project-name-error" : undefined}
            className="text-base placeholder:text-text-primary/60 sm:text-sm"
            autoFocus
            maxLength={255}
            disabled={isPending}
            required
          />
          <FieldError id="project-name-error" message={errors.name} />
        </div>
        <div>
          <Textarea
            label="Description"
            placeholder="What outcome does this project own?"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            aria-invalid={!!errors.description}
            aria-describedby={errors.description ? "project-description-error" : undefined}
            className="text-base placeholder:text-text-primary/60 sm:text-sm"
            maxLength={5000}
            rows={3}
            disabled={isPending}
          />
          <FieldError id="project-description-error" message={errors.description} />
        </div>
        <div>
          <Select
            label="Status"
            options={projectStatuses}
            value={status}
            onChange={(event) => setStatus(event.target.value as ProjectStatus)}
            aria-invalid={!!errors.status}
            aria-describedby={errors.status ? "project-status-error" : undefined}
            className="text-base sm:text-sm"
            disabled={isPending}
          />
          <FieldError id="project-status-error" message={errors.status} />
        </div>
        <div>
          <Input
            label="Repository URL"
            type="url"
            inputMode="url"
            placeholder="https://github.com/organization/repository"
            value={repoUrl}
            onChange={(event) => setRepoUrl(event.target.value)}
            aria-invalid={!!errors.repoUrl}
            aria-describedby={errors.repoUrl ? "project-repository-url-error" : undefined}
            className="text-base placeholder:text-text-primary/60 sm:text-sm"
            disabled={isPending}
          />
          <FieldError id="project-repository-url-error" message={errors.repoUrl} />
        </div>

        {submitError && (
          <div
            role="alert"
            aria-live="polite"
            className="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error"
          >
            Project was not {isEditing ? "updated" : "created"}: {submitError} Your entries are still here; correct the issue and retry.
          </div>
        )}

        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={handleClose} disabled={isPending}>
            Cancel
          </Button>
          <Button type="submit" loading={isPending}>
            {isEditing ? "Save Changes" : "Create Project"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
