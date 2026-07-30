import { useState } from "react";
import { z } from "zod";
import { Modal } from "@/components/ui/Modal";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useCreateProject } from "@/lib/hooks";
import type { Project, ProjectStatus } from "@/lib/api";

interface CreateProjectModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (project: Project) => void;
  companyId: string;
}

const projectStatuses: { value: ProjectStatus; label: string }[] = [
  { value: "planning", label: "Planning" },
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" },
  { value: "archived", label: "Archived" },
];

const projectSchema = z.object({
  name: z.string().trim().min(1, "Enter a project name.").max(255, "Use 255 characters or fewer."),
  description: z.string().max(5000, "Use 5,000 characters or fewer."),
  status: z.enum(["planning", "active", "completed", "archived"]),
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

export function CreateProjectModal({
  open,
  onClose,
  onCreated,
  companyId,
}: CreateProjectModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<ProjectStatus>("planning");
  const [repoUrl, setRepoUrl] = useState("");
  const [errors, setErrors] = useState<ProjectFormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const mutation = useCreateProject(companyId);

  function resetForm() {
    setName("");
    setDescription("");
    setStatus("planning");
    setRepoUrl("");
    setErrors({});
    setSubmitError(null);
    mutation.reset();
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
    mutation.mutate(
      {
        name: parsed.data.name,
        description: parsed.data.description.trim() || undefined,
        status: parsed.data.status,
        repoUrl: parsed.data.repoUrl || null,
      },
      {
        onSuccess: (project) => {
          resetForm();
          onClose();
          onCreated(project);
        },
        onError: (error) => {
          setSubmitError(
            error instanceof Error
              ? error.message
              : "Project creation failed. Check your connection and try again.",
          );
        },
      },
    );
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Create Project"
      dismissible={!mutation.isPending}
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
            disabled={mutation.isPending}
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
            disabled={mutation.isPending}
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
            disabled={mutation.isPending}
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
            disabled={mutation.isPending}
          />
          <FieldError id="project-repository-url-error" message={errors.repoUrl} />
        </div>

        {submitError && (
          <div
            role="alert"
            aria-live="polite"
            className="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error"
          >
            Project was not created: {submitError} Your entries are still here; correct the issue and retry.
          </div>
        )}

        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={handleClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            Create Project
          </Button>
        </div>
      </form>
    </Modal>
  );
}
