import { ProjectFormModal } from "./ProjectFormModal";
import type { Project } from "@/lib/api";

interface CreateProjectModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (project: Project) => void;
  companyId: string;
}

export function CreateProjectModal({
  open,
  onClose,
  onCreated,
  companyId,
}: CreateProjectModalProps) {
  return (
    <ProjectFormModal
      open={open}
      companyId={companyId}
      onClose={onClose}
      onSaved={onCreated}
    />
  );
}
