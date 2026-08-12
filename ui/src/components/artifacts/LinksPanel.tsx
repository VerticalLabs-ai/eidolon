import { useState, useCallback, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";
import {
  Link2,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Bot,
  User,
  ExternalLink,
  FileText,
  Grid3x3,
  LayoutGrid,
  Presentation,
  GanttChartSquare,
  Images,
  BarChart3,
  AppWindow,
  Code2,
  AlertCircle,
} from "lucide-react";
import { clsx } from "clsx";
import type { LinksResponse, LinkRef, RelatedArtifact } from "@eidolon/shared";
import type { ArtifactType } from "@/lib/api";

// ---------------------------------------------------------------------------
// Smart artifact linking — Links panel (M3 — Artifact Intelligence & Discovery)
//
// Collapsible panel rendered in the ArtifactEditor sidebar below the revision
// history. Shows two sections:
//
//   • Linked From — thread items that @-mention this artifact, with thread
//     title, content snippet (truncated), author name, date, and a "View
//     thread" link that navigates to the thread.
//   • Related — artifacts scored by shared signals (same project, shared
//     folder, agent edited, co-mentioned), with reason badges and an "Open"
//     link that navigates to the artifact editor.
//
// Both sections show empty-state messages when no data is available. The
// panel is keyboard accessible: Tab moves focus to the panel header, Enter
// toggles collapse, Tab moves through rows, Enter activates navigation.
// ---------------------------------------------------------------------------

interface LinksPanelProps {
  companyId: string;
  artifactId: string;
  links: LinksResponse | undefined;
  isLoading: boolean;
  isError: boolean;
}

/** Icon for each artifact type (matches ArtifactEditor header icons). */
const TYPE_ICONS: Partial<Record<ArtifactType, typeof FileText>> = {
  document: FileText,
  sheet: Grid3x3,
  board: LayoutGrid,
  slide_deck: Presentation,
  timeline: GanttChartSquare,
  gallery: Images,
  dashboard: BarChart3,
  app: AppWindow,
  code: Code2,
};

/** Tailwind classes for reason badges (color-coded by signal type). */
const REASON_BADGE_CLASSES: Record<string, string> = {
  "Same project": "bg-accent/10 text-accent border-accent/20",
  "Shared folder": "bg-blue-500/10 text-blue-400 border-blue-500/20",
  "Agent edited": "bg-purple-500/10 text-purple-400 border-purple-500/20",
  "Co-mentioned": "bg-amber-500/10 text-amber-400 border-amber-500/20",
};

export function LinksPanel({
  companyId,
  links,
  isLoading,
  isError,
}: LinksPanelProps) {
  const [expanded, setExpanded] = useState(true);
  const navigate = useNavigate();

  const toggleExpand = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const handleHeaderKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleExpand();
      }
    },
    [toggleExpand],
  );

  const navigateToThread = useCallback(
    (item: LinkRef) => {
      // Navigate to the task thread or project thread based on the
      // navigation context provided by the backend.
      if (item.taskId) {
        navigate(`/company/${companyId}/tasks/${item.taskId}`);
      } else if (item.projectId) {
        navigate(`/company/${companyId}/projects/${item.projectId}`);
      }
    },
    [navigate, companyId],
  );

  const navigateToArtifact = useCallback(
    (artifact: RelatedArtifact) => {
      // Always navigate to the artifact editor route. The project page does
      // not render the artifact editor, so routing related artifacts through
      // /projects/:projectId?artifactId=... would leave the user on the
      // project page without the editor open (VAL-LINK-036).
      navigate(
        `/company/${companyId}/artifacts?artifactId=${encodeURIComponent(artifact.artifactId)}`,
      );
    },
    [navigate, companyId],
  );

  const linkedFrom = links?.linkedFrom ?? [];
  const related = links?.related ?? [];

  return (
    <div className="border-t border-white/[0.06]">
      {/* Panel header — clickable to toggle collapse, keyboard accessible */}
      <button
        type="button"
        onClick={toggleExpand}
        onKeyDown={handleHeaderKeyDown}
        aria-expanded={expanded}
        aria-controls="links-panel-content"
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-white/[0.02] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-text-secondary" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-text-secondary" />
        )}
        <Link2 className="h-4 w-4 text-accent" />
        <h3 className="text-sm font-semibold text-text-primary font-display">
          Links
        </h3>
        {(linkedFrom.length > 0 || related.length > 0) && (
          <span className="ml-auto text-[10px] text-text-secondary tabular-nums">
            {linkedFrom.length + related.length}
          </span>
        )}
      </button>

      {expanded && (
        <div
          id="links-panel-content"
          className="max-h-[40vh] overflow-y-auto"
        >
          {isLoading ? (
            <div className="flex items-center justify-center py-4">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
            </div>
          ) : isError ? (
            <div className="flex items-center gap-1.5 px-4 py-3 text-xs text-error/80">
              <AlertCircle className="h-3.5 w-3.5" />
              Failed to load links
            </div>
          ) : (
            <>
              {/* ── Linked From section ────────────────────────────────── */}
              <LinkedFromSection
                items={linkedFrom}
                onNavigate={navigateToThread}
              />

              {/* ── Related section ─────────────────────────────────────── */}
              <RelatedSection
                items={related}
                onNavigate={navigateToArtifact}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Linked From section
// ---------------------------------------------------------------------------

interface LinkedFromSectionProps {
  items: LinkRef[];
  onNavigate: (item: LinkRef) => void;
}

function LinkedFromSection({ items, onNavigate }: LinkedFromSectionProps) {
  return (
    <div className="border-b border-white/[0.04]">
      <h4 className="px-4 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
        Linked From
      </h4>
      {items.length === 0 ? (
        <p className="px-4 pb-3 pt-1 text-xs text-text-secondary italic">
          No mentions yet
        </p>
      ) : (
        <ul role="list" className="pb-2">
          {items.map((item) => (
            <LinkedFromRow
              key={item.threadItemId}
              item={item}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface LinkedFromRowProps {
  item: LinkRef;
  onNavigate: (item: LinkRef) => void;
}

function LinkedFromRow({ item, onNavigate }: LinkedFromRowProps) {
  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onNavigate(item);
    }
  };

  const canNavigate = !!(item.taskId || item.projectId);

  return (
    <li className="px-3 py-2 hover:bg-white/[0.02] transition-colors">
      <button
        type="button"
        onClick={() => onNavigate(item)}
        onKeyDown={handleKeyDown}
        disabled={!canNavigate}
        className="block w-full text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded disabled:cursor-default"
        aria-label={`View thread: ${item.threadTitle}`}
      >
        {/* Thread title */}
        <div className="flex items-center gap-1.5">
          <MessageSquare className="h-3 w-3 shrink-0 text-text-secondary" />
          <span className="truncate text-xs font-medium text-text-primary">
            {item.threadTitle}
          </span>
          {canNavigate && (
            <ExternalLink className="ml-auto h-3 w-3 shrink-0 text-text-secondary" />
          )}
        </div>

        {/* Content snippet — truncated to a single line with ellipsis */}
        {item.contentSnippet && (
          <p className="mt-1 line-clamp-2 text-[10px] text-text-secondary">
            {item.contentSnippet}
          </p>
        )}

        {/* Author + date */}
        <div className="mt-1 flex items-center gap-1.5 text-[10px] text-text-secondary">
          {item.author?.agentId ? (
            <Bot className="h-3 w-3 shrink-0" />
          ) : (
            <User className="h-3 w-3 shrink-0" />
          )}
          <span className="truncate">
            {item.authorName ?? "Unknown"}
          </span>
          <span className="text-text-muted">·</span>
          <span>
            {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
          </span>
        </div>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Related section
// ---------------------------------------------------------------------------

interface RelatedSectionProps {
  items: RelatedArtifact[];
  onNavigate: (artifact: RelatedArtifact) => void;
}

function RelatedSection({ items, onNavigate }: RelatedSectionProps) {
  return (
    <div>
      <h4 className="px-4 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
        Related
      </h4>
      {items.length === 0 ? (
        <p className="px-4 pb-3 pt-1 text-xs text-text-secondary italic">
          No related artifacts found
        </p>
      ) : (
        <ul role="list" className="pb-2">
          {items.map((artifact) => (
            <RelatedRow
              key={artifact.artifactId}
              artifact={artifact}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface RelatedRowProps {
  artifact: RelatedArtifact;
  onNavigate: (artifact: RelatedArtifact) => void;
}

function RelatedRow({ artifact, onNavigate }: RelatedRowProps) {
  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onNavigate(artifact);
    }
  };

  const Icon = TYPE_ICONS[artifact.type] ?? FileText;

  return (
    <li className="px-3 py-2 hover:bg-white/[0.02] transition-colors">
      <button
        type="button"
        onClick={() => onNavigate(artifact)}
        onKeyDown={handleKeyDown}
        className="block w-full text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded"
        aria-label={`Open artifact: ${artifact.title}`}
      >
        {/* Title + type icon */}
        <div className="flex items-center gap-1.5">
          <Icon className="h-3 w-3 shrink-0 text-text-secondary" />
          <span className="truncate text-xs font-medium text-text-primary">
            {artifact.title}
          </span>
          <ExternalLink className="ml-auto h-3 w-3 shrink-0 text-text-secondary" />
        </div>

        {/* Reason badges */}
        {artifact.reasons.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {artifact.reasons.map((reason) => (
              <span
                key={reason}
                className={clsx(
                  "inline-flex items-center rounded border px-1 py-0.5 text-[9px] font-medium",
                  REASON_BADGE_CLASSES[reason] ??
                    "bg-white/[0.04] text-text-secondary border-white/10",
                )}
              >
                {reason}
              </span>
            ))}
          </div>
        )}
      </button>
    </li>
  );
}
