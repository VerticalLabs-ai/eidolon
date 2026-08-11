import { useEffect, useRef, useState } from "react";
import { Loader2, Save } from "lucide-react";

interface SaveArtifactTemplateModalProps {
  artifactTitle: string;
  typeLabel: string;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (name: string, description: string) => void;
}

/**
 * Inline modal for saving the current artifact as an artifact-type template
 * (VAL-TEMPLATE-005). Captures a name + optional description.
 */
export function SaveArtifactTemplateModal({
  artifactTitle,
  typeLabel,
  pending,
  onCancel,
  onSubmit,
}: SaveArtifactTemplateModalProps) {
  const [name, setName] = useState(`${artifactTitle} Template`);
  const [description, setDescription] = useState("");
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => nameRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="glass-raised rounded-2xl w-full max-w-md mx-4 p-6 shadow-2xl border border-white/10">
        <h2 className="font-display text-lg font-semibold text-text-primary mb-1">
          Save Artifact as Template
        </h2>
        <p className="text-sm text-text-secondary mb-4">
          Capture this {typeLabel}'s current content as a reusable template.
        </p>
        <label className="block mb-3">
          <span className="text-xs font-medium text-text-secondary mb-1 block">
            Template Name
          </span>
          <input
            ref={nameRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full h-9 rounded-md bg-white/[0.04] border border-white/10 px-3 text-sm text-text-primary placeholder:text-text-secondary/40 focus:outline-none focus:ring-1 focus:ring-accent/50 focus:border-accent/50"
          />
        </label>
        <label className="block mb-4">
          <span className="text-xs font-medium text-text-secondary mb-1 block">
            Description (optional)
          </span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full rounded-md bg-white/[0.04] border border-white/10 px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/40 focus:outline-none focus:ring-1 focus:ring-accent/50 focus:border-accent/50"
          />
        </label>
        <div className="flex items-center justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={pending}
            className="h-9 px-4 rounded-md text-sm font-medium text-text-secondary hover:text-text-primary transition-colors cursor-pointer disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => name.trim() && onSubmit(name.trim(), description.trim())}
            disabled={!name.trim() || pending}
            className="inline-flex items-center gap-2 h-9 px-4 rounded-md text-sm font-medium text-surface bg-accent transition-all duration-200 hover:brightness-110 active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save Template
          </button>
        </div>
      </div>
    </div>
  );
}
