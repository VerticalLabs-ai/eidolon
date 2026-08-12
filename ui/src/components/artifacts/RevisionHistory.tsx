import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { History, RotateCcw, Bot, User, GitCompareArrows } from "lucide-react";
import { clsx } from "clsx";
import type { ArtifactRevision } from "@/lib/api";

interface RevisionHistoryProps {
  revisions: ArtifactRevision[];
  currentVersion: number;
  onRestore: (version: number) => void;
  restoring?: boolean;
  readOnly?: boolean;
  /** Called when the user clicks Compare with two revisions selected. */
  onCompare?: (v1: number, v2: number) => void;
}

export function RevisionHistory({
  revisions,
  currentVersion,
  onRestore,
  restoring,
  readOnly,
  onCompare,
}: RevisionHistoryProps) {
  // Compare mode: toggle that reveals per-revision checkboxes. The user
  // selects exactly two revisions; a third selection replaces the earliest
  // selection so at most two are checked simultaneously (VAL-DIFF-050).
  const [compareMode, setCompareMode] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);

  // Show newest first
  const sorted = [...revisions].sort((a, b) => b.version - a.version);

  const canCompare = !!onCompare && selected.length === 2;

  const toggleCompareMode = () => {
    setCompareMode((prev) => {
      const next = !prev;
      if (!next) setSelected([]);
      return next;
    });
  };

  const handleSelect = (version: number) => {
    setSelected((prev) => {
      if (prev.includes(version)) {
        // Uncheck
        return prev.filter((v) => v !== version);
      }
      // At most two selected; replace the earliest selection (FIFO) when
      // a third would be added.
      if (prev.length >= 2) {
        return [prev[1], version];
      }
      return [...prev, version];
    });
  };

  const handleCompare = () => {
    if (!canCompare || !onCompare) return;
    // Always pass the lower version as v1 for a stable "from → to" reading
    // order (the API accepts either order — VAL-DIFF-011).
    const [a, b] = [...selected].sort((x, y) => x - y);
    onCompare(a, b);
  };

  return (
    <aside
      className="flex w-64 shrink-0 flex-col border-l border-white/[0.06] bg-surface/60"
      aria-label="Revision history"
    >
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
        <History className="h-4 w-4 text-accent" />
        <h3 className="text-sm font-semibold text-text-primary font-display">
          History
        </h3>
        {onCompare && (
          <button
            type="button"
            onClick={toggleCompareMode}
            aria-pressed={compareMode}
            className={clsx(
              "ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40",
              compareMode
                ? "bg-accent/15 text-accent"
                : "text-text-secondary hover:text-accent hover:bg-accent/10",
            )}
            title="Compare two revisions"
          >
            <GitCompareArrows className="h-3.5 w-3.5" />
            Compare
          </button>
        )}
      </div>

      {compareMode && onCompare && (
        <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2">
          <span className="text-[10px] text-text-secondary">
            {selected.length === 0
              ? "Select two revisions"
              : selected.length === 1
                ? "Select one more"
                : "Ready to compare"}
          </span>
          <button
            type="button"
            onClick={handleCompare}
            disabled={!canCompare}
            className="ml-auto inline-flex items-center gap-1 rounded-md bg-accent/15 px-2 py-1 text-[10px] font-medium text-accent transition-colors hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 disabled:pointer-events-none disabled:opacity-40"
          >
            <GitCompareArrows className="h-3 w-3" />
            Compare
          </button>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {sorted.length === 0 ? (
          <p className="px-4 py-6 text-xs text-text-secondary text-center">
            No revisions yet.
          </p>
        ) : (
          <ul role="list" className="divide-y divide-white/[0.04]">
            {sorted.map((rev) => {
              const isCurrent = rev.version === currentVersion;
              const canRestore = !isCurrent && !restoring && !readOnly;
              const checked = selected.includes(rev.version);
              return (
                <li
                  key={rev.id}
                  className={clsx(
                    "px-3 py-2.5",
                    isCurrent && "bg-accent/[0.04]",
                    compareMode && checked && "bg-accent/[0.08]",
                  )}
                >
                  <div className="flex items-center gap-2">
                    {compareMode && (
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => handleSelect(rev.version)}
                        aria-label={`Select revision v${rev.version} for comparison`}
                        className="h-3.5 w-3.5 rounded border-white/20 bg-white/[0.04] text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
                      />
                    )}
                    <span className="text-xs font-semibold text-text-primary tabular-nums">
                      v{rev.version}
                    </span>
                    {isCurrent && (
                      <span className="text-[10px] text-accent font-medium">
                        current
                      </span>
                    )}
                    <span className="ml-auto flex items-center gap-1 text-[10px] text-text-secondary">
                      {rev.editSource === "agent" ? (
                        <>
                          <Bot className="h-3 w-3" />
                          Agent
                        </>
                      ) : (
                        <>
                          <User className="h-3 w-3" />
                          User
                        </>
                      )}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[10px] text-text-secondary">
                    {formatDistanceToNow(new Date(rev.createdAt), {
                      addSuffix: true,
                    })}
                  </p>
                  {rev.message && (
                    <p className="mt-0.5 truncate text-[10px] text-text-secondary italic">
                      {rev.message}
                    </p>
                  )}
                  {canRestore && !compareMode && (
                    <button
                      onClick={() => onRestore(rev.version)}
                      disabled={restoring}
                      className="mt-1.5 flex items-center gap-1 text-[10px] text-accent hover:text-accent/80 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded disabled:opacity-40"
                      aria-label={`Restore version ${rev.version}`}
                    >
                      <RotateCcw className="h-3 w-3" />
                      Restore
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
