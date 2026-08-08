import { useEffect, useRef } from "react";
import { FileText, Grid3x3, LayoutGrid, Presentation, GanttChartSquare, Images, BarChart3, AppWindow, Code2 } from "lucide-react";
import { clsx } from "clsx";
import { Modal } from "@/components/ui/Modal";
import type { ArtifactType } from "@/lib/api";

interface TypeOption {
  type: ArtifactType;
  label: string;
  description: string;
  icon: React.ReactNode;
  enabled: boolean;
}

const TYPE_OPTIONS: TypeOption[] = [
  {
    type: "document",
    label: "Document",
    description: "Rich text / markdown document",
    icon: <FileText className="h-5 w-5" />,
    enabled: true,
  },
  {
    type: "sheet",
    label: "Sheet",
    description: "Grid with columns, rows, and cells",
    icon: <Grid3x3 className="h-5 w-5" />,
    enabled: true,
  },
  {
    type: "board",
    label: "Board",
    description: "Kanban board with cards and columns",
    icon: <LayoutGrid className="h-5 w-5" />,
    enabled: true,
  },
  {
    type: "slide_deck",
    label: "Slides",
    description: "Slide deck with layouts and blocks",
    icon: <Presentation className="h-5 w-5" />,
    enabled: true,
  },
  {
    type: "timeline",
    label: "Timeline",
    description: "Gantt timeline with tasks and dependencies",
    icon: <GanttChartSquare className="h-5 w-5" />,
    enabled: false,
  },
  {
    type: "gallery",
    label: "Gallery",
    description: "Media gallery with captions",
    icon: <Images className="h-5 w-5" />,
    enabled: false,
  },
  {
    type: "dashboard",
    label: "Dashboard",
    description: "Data dashboard with widgets",
    icon: <BarChart3 className="h-5 w-5" />,
    enabled: false,
  },
  {
    type: "app",
    label: "App",
    description: "App builder with files",
    icon: <AppWindow className="h-5 w-5" />,
    enabled: false,
  },
  {
    type: "code",
    label: "Code",
    description: "Code editor with run support",
    icon: <Code2 className="h-5 w-5" />,
    enabled: false,
  },
];

interface ArtifactTypePickerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (type: ArtifactType) => void;
}

export function ArtifactTypePicker({
  open,
  onClose,
  onSelect,
}: ArtifactTypePickerProps) {
  const firstEnabledRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (open) {
      // Focus the first enabled option after the modal opens
      const timer = setTimeout(() => {
        firstEnabledRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title="Create Artifact">
      <p className="mb-4 text-sm text-text-secondary">
        Choose the type of artifact to create.
      </p>
      <div
        className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        role="listbox"
        aria-label="Artifact types"
      >
        {TYPE_OPTIONS.map((opt, index) => {
          const enabledIndex = TYPE_OPTIONS.findIndex((o) => o.enabled);
          const isFirstEnabled = index === enabledIndex;
          return (
            <button
              key={opt.type}
              ref={isFirstEnabled ? firstEnabledRef : undefined}
              disabled={!opt.enabled}
              onClick={() => onSelect(opt.type)}
              role="option"
              aria-selected={false}
              aria-label={`${opt.label} — ${opt.description}${!opt.enabled ? " (coming soon)" : ""}`}
              className={clsx(
                "flex items-start gap-3 rounded-lg border p-3 text-left transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface cursor-pointer",
                opt.enabled
                  ? "border-white/[0.08] hover:border-accent/30 hover:bg-accent/[0.04] text-text-primary"
                  : "border-white/[0.04] opacity-50 cursor-not-allowed text-text-secondary",
              )}
            >
              <span
                className={clsx(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                  opt.enabled
                    ? "bg-accent/10 text-accent"
                    : "bg-white/[0.04] text-text-secondary",
                )}
              >
                {opt.icon}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold font-display flex items-center gap-1.5">
                  {opt.label}
                  {!opt.enabled && (
                    <span className="text-[10px] font-normal text-text-secondary italic">
                      coming soon
                    </span>
                  )}
                </p>
                <p className="text-xs text-text-secondary mt-0.5">
                  {opt.description}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
