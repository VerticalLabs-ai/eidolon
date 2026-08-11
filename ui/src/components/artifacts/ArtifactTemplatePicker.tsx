import { useEffect, useRef, useState } from "react";
import { FileText, Grid3x3, LayoutGrid, Presentation, GanttChartSquare, Images, BarChart3, AppWindow, Code2, Loader2, Copy } from "lucide-react";
import { clsx } from "clsx";
import { Modal } from "@/components/ui/Modal";
import { useArtifactTemplates } from "@/lib/hooks";
import type { ArtifactType } from "@/lib/api";

const TYPE_ICONS: Record<ArtifactType, React.ReactNode> = {
  document: <FileText className="h-4 w-4" />,
  sheet: <Grid3x3 className="h-4 w-4" />,
  board: <LayoutGrid className="h-4 w-4" />,
  slide_deck: <Presentation className="h-4 w-4" />,
  timeline: <GanttChartSquare className="h-4 w-4" />,
  gallery: <Images className="h-4 w-4" />,
  dashboard: <BarChart3 className="h-4 w-4" />,
  app: <AppWindow className="h-4 w-4" />,
  code: <Code2 className="h-4 w-4" />,
};

const TYPE_LABELS: Record<ArtifactType, string> = {
  document: "Document",
  sheet: "Sheet",
  board: "Board",
  slide_deck: "Slides",
  timeline: "Timeline",
  gallery: "Gallery",
  dashboard: "Dashboard",
  app: "App",
  code: "Code",
};

interface ArtifactTemplatePickerProps {
  open: boolean;
  onClose: () => void;
  companyId: string;
  /** Called when a template is selected. The parent creates the artifact. */
  onSelect: (templateId: string, templateName: string) => void;
  /** Optional type filter — when set, only templates of this type are shown.
   *  Used to filter by the active list type context (tech-debt fix). */
  filterType?: ArtifactType | null;
}

/**
 * Lists the company's artifact templates and lets the user pick one to clone
 * into a new artifact (VAL-TEMPLATE-014). When `filterType` is supplied, only
 * templates of that type are shown, matching the active list filter context.
 */
export function ArtifactTemplatePicker({
  open,
  onClose,
  companyId,
  onSelect,
  filterType = null,
}: ArtifactTemplatePickerProps) {
  const { data: templates = [], isLoading } = useArtifactTemplates(companyId, filterType ?? undefined);
  const firstRef = useRef<HTMLButtonElement | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSelectedId(null);
      const timer = setTimeout(() => firstRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title="Create from Template">
      <p className="mb-4 text-sm text-text-secondary">
        Choose a saved artifact template to clone into a new artifact.
      </p>
      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-accent" />
        </div>
      ) : templates.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <Copy className="h-8 w-8 text-text-secondary/40 mb-2" />
          <p className="text-sm text-text-secondary">No artifact templates yet</p>
          <p className="text-xs text-text-secondary/60 mt-1">
            Save an artifact as a template to reuse it here.
          </p>
        </div>
      ) : (
        <div
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          role="listbox"
          aria-label="Artifact templates"
        >
          {templates.map((tpl, index) => {
            const isSelected = selectedId === tpl.id;
            return (
              <button
                key={tpl.id}
                ref={index === 0 ? firstRef : undefined}
                onClick={() => setSelectedId(tpl.id)}
                role="option"
                aria-selected={isSelected}
                aria-label={`${tpl.name} — ${TYPE_LABELS[tpl.type]}`}
                className={clsx(
                  "flex items-start gap-3 rounded-lg border p-3 text-left transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface cursor-pointer",
                  isSelected
                    ? "border-accent/40 bg-accent/[0.06] text-text-primary"
                    : "border-white/[0.08] hover:border-accent/30 hover:bg-accent/[0.04] text-text-primary",
                )}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                  {TYPE_ICONS[tpl.type]}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold font-display">{tpl.name}</p>
                  <p className="text-xs text-text-secondary mt-0.5">
                    {TYPE_LABELS[tpl.type]}
                    {tpl.description ? ` · ${tpl.description}` : ""}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      )}
      <div className="mt-6 flex items-center justify-end gap-3">
        <button
          onClick={onClose}
          className="h-9 px-4 rounded-md text-sm font-medium text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
        >
          Cancel
        </button>
        <button
          onClick={() => {
            if (selectedId) {
              const tpl = templates.find((t) => t.id === selectedId);
              if (tpl) onSelect(selectedId, tpl.name);
            }
          }}
          disabled={!selectedId}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-md text-sm font-medium text-surface bg-accent transition-all duration-200 hover:brightness-110 active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          <Copy className="h-4 w-4" />
          Create Artifact
        </button>
      </div>
    </Modal>
  );
}
