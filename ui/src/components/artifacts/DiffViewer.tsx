// ---------------------------------------------------------------------------
// DiffViewer — renders a structured revision diff (M2 — Artifact Intelligence
// & Discovery).
//
// Receives a `DiffResponse` (from the diff endpoint) and renders a type-
// specific view:
//   • document / code / app — line-level diff with +/- indicators (not
//     color-only, WCAG 1.4.1) in side-by-side or inline layout.
//   • sheet — cell-level highlighting (added/removed/modified cells).
//   • board — before/after card positions with moved-card indicators.
//   • slide_deck / timeline / gallery / dashboard — structured field-level
//     changes list (entity id, field, from → to).
//
// Accessibility:
//   • +/- text indicators and ARIA labels convey added/removed state, not
//     color alone (VAL-DIFF-055/067).
//   • Diff content is keyboard-navigable (Tab/arrow keys) via focusable
//     diff rows (VAL-DIFF-065).
//   • The side-by-side/inline toggle persists in localStorage (VAL-DIFF-063).
//   • A summary header shows additions/deletions/modifications counts
//     (VAL-DIFF-059).
//   • Empty diff renders an explicit "No changes" message (VAL-DIFF-071).
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import {
  Plus,
  Minus,
  Pencil,
  ArrowRight,
  Columns2,
  AlignLeft,
  Check,
} from "lucide-react";
import { clsx } from "clsx";
import type {
  DiffResult,
  DiffSummary,
  LineDiffResult,
  LineDiff,
  SheetDiffResult,
  BoardDiffResult,
  SlidesDiffResult,
  TimelineDiffResult,
  GalleryDiffResult,
  DashboardDiffResult,
  FileDiffResult,
} from "@eidolon/shared";
import type { ArtifactType } from "@/lib/api";

// localStorage key for the side-by-side vs inline preference (VAL-DIFF-063).
const DIFF_VIEW_PREF_KEY = "eidolon.diffViewMode";

type DiffViewMode = "split" | "inline";

function readDiffViewPref(): DiffViewMode {
  try {
    const v = localStorage.getItem(DIFF_VIEW_PREF_KEY);
    return v === "inline" ? "inline" : "split";
  } catch {
    return "split";
  }
}

function writeDiffViewPref(mode: DiffViewMode) {
  try {
    localStorage.setItem(DIFF_VIEW_PREF_KEY, mode);
  } catch {
    // ignore storage failures (private mode, etc.)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when a DiffResult has no type-specific changes. */
function isDiffEmpty(diff: DiffResult): boolean {
  const s = diff.summary;
  return s.additions === 0 && s.deletions === 0 && s.modifications === 0;
}

/** Render an unknown value as a compact string for display. */
function fmtVal(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Extract a human-readable identifier from a record (id/title/name/path). */
function recordLabel(rec: Record<string, unknown>, fallback: string): string {
  return String(
    rec.id ?? rec.title ?? rec.name ?? rec.path ?? rec.caption ?? fallback,
  );
}

// ---------------------------------------------------------------------------
// Summary header (VAL-DIFF-059)
// ---------------------------------------------------------------------------

function DiffSummaryHeader({ summary }: { summary: DiffSummary }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      <span className="inline-flex items-center gap-1 font-medium text-emerald-400">
        <Plus className="h-3.5 w-3.5" />
        {summary.additions} addition{summary.additions === 1 ? "" : "s"}
      </span>
      <span className="inline-flex items-center gap-1 font-medium text-red-400">
        <Minus className="h-3.5 w-3.5" />
        {summary.deletions} deletion{summary.deletions === 1 ? "" : "s"}
      </span>
      <span className="inline-flex items-center gap-1 font-medium text-amber-400">
        <Pencil className="h-3.5 w-3.5" />
        {summary.modifications} modification{summary.modifications === 1 ? "" : "s"}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// View-mode toggle (side-by-side / inline) — persists in localStorage
// ---------------------------------------------------------------------------

interface ViewToggleProps {
  mode: DiffViewMode;
  onChange: (mode: DiffViewMode) => void;
}

function ViewToggle({ mode, onChange }: ViewToggleProps) {
  return (
    <div
      role="group"
      aria-label="Diff view mode"
      className="inline-flex items-center rounded-md border border-white/[0.08] bg-white/[0.02] p-0.5"
    >
      <button
        type="button"
        aria-pressed={mode === "split"}
        onClick={() => onChange("split")}
        className={clsx(
          "inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40",
          mode === "split"
            ? "bg-accent/15 text-accent"
            : "text-text-secondary hover:text-text-primary",
        )}
      >
        <Columns2 className="h-3.5 w-3.5" />
        Side by side
      </button>
      <button
        type="button"
        aria-pressed={mode === "inline"}
        onClick={() => onChange("inline")}
        className={clsx(
          "inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40",
          mode === "inline"
            ? "bg-accent/15 text-accent"
            : "text-text-secondary hover:text-text-primary",
        )}
      >
        <AlignLeft className="h-3.5 w-3.5" />
        Inline
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Line diff (document / code / app) — +/- indicators, not color-only
// ---------------------------------------------------------------------------

interface LineDiffViewProps {
  lines: LineDiff[];
  mode: DiffViewMode;
  fromVersion: number;
  toVersion: number;
}

function LineDiffView({ lines, mode, fromVersion, toVersion }: LineDiffViewProps) {
  if (mode === "split") {
    // Side-by-side: left column = from (removed + unchanged), right = to
    // (added + unchanged). Pair rows by index for alignment.
    const left: (LineDiff | null)[] = [];
    const right: (LineDiff | null)[] = [];
    for (const ln of lines) {
      if (ln.type === "unchanged") {
        left.push(ln);
        right.push(ln);
      } else if (ln.type === "removed") {
        left.push(ln);
        right.push(null);
      } else {
        // added
        left.push(null);
        right.push(ln);
      }
    }
    return (
      <div className="grid grid-cols-2 gap-px overflow-auto rounded-md border border-white/[0.06] bg-white/[0.02] text-xs">
        <div className="bg-white/[0.02]">
          <div className="sticky top-0 z-10 border-b border-white/[0.06] bg-surface/80 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-secondary backdrop-blur">
            v{fromVersion} (from)
          </div>
          <ul role="list">
            {left.map((ln, i) => (
              <LineRow key={`l-${i}`} line={ln} side="from" />
            ))}
          </ul>
        </div>
        <div className="bg-white/[0.02]">
          <div className="sticky top-0 z-10 border-b border-white/[0.06] bg-surface/80 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-secondary backdrop-blur">
            v{toVersion} (to)
          </div>
          <ul role="list">
            {right.map((ln, i) => (
              <LineRow key={`r-${i}`} line={ln} side="to" />
            ))}
          </ul>
        </div>
      </div>
    );
  }

  // Inline: single column with interleaved +/- entries
  return (
    <div className="overflow-auto rounded-md border border-white/[0.06] bg-white/[0.02] text-xs">
      <ul role="list">
        {lines.map((ln, i) => (
          <LineRow key={i} line={ln} side="inline" />
        ))}
      </ul>
    </div>
  );
}

interface LineRowProps {
  line: LineDiff | null;
  side: "from" | "to" | "inline";
}

function LineRow({ line, side }: LineRowProps) {
  if (!line) {
    return (
      <li
        tabIndex={0}
        className="flex min-h-[1.25rem] items-start gap-2 px-3 py-0.5 text-text-muted/30 select-none"
        aria-label="empty"
      >
        <span className="w-4 shrink-0 text-center text-text-muted/30"> </span>
        <span className="whitespace-pre font-mono">&nbsp;</span>
      </li>
    );
  }
  const isAdded = line.type === "added";
  const isRemoved = line.type === "removed";
  const isUnchanged = line.type === "unchanged";
  const indicator = isAdded ? "+" : isRemoved ? "-" : " ";
  const ariaLabel = isAdded
    ? "added line"
    : isRemoved
      ? "removed line"
      : "unchanged line";
  return (
    <li
      tabIndex={0}
      aria-label={ariaLabel}
      className={clsx(
        "flex min-h-[1.25rem] items-start gap-2 px-3 py-0.5 font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/40",
        isAdded && "bg-emerald-500/10",
        isRemoved && "bg-red-500/10",
        isUnchanged && "bg-transparent",
        side === "inline" && isAdded && "border-l-2 border-emerald-500/60",
        side === "inline" && isRemoved && "border-l-2 border-red-500/60",
      )}
    >
      <span
        className={clsx(
          "w-4 shrink-0 select-none text-center font-bold",
          isAdded && "text-emerald-400",
          isRemoved && "text-red-400",
          isUnchanged && "text-text-muted/40",
        )}
        aria-hidden
      >
        {indicator}
      </span>
      {line.lineNumber != null && (
        <span className="w-8 shrink-0 select-none text-right text-text-muted/40 tabular-nums">
          {line.lineNumber}
        </span>
      )}
      <span
        className={clsx(
          "whitespace-pre-wrap break-words",
          isAdded && "text-emerald-200",
          isRemoved && "text-red-200",
          isUnchanged && "text-text-secondary",
        )}
      >
        {line.content || " "}
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Sheet diff — cell-level highlighting (VAL-DIFF-056)
// ---------------------------------------------------------------------------

function SheetDiffView({ sheet }: { sheet: SheetDiffResult }) {
  const colChanges = sheet.columnChanges ?? [];
  const rowChanges = sheet.rowChanges ?? [];

  if (colChanges.length === 0 && rowChanges.length === 0) {
    return <EmptyDiff />;
  }

  return (
    <div className="space-y-4 text-xs">
      {colChanges.length > 0 && (
        <section>
          <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
            Column changes
          </h4>
          <ul role="list" className="space-y-1">
            {colChanges.map((c, i) => (
              <li
                key={i}
                tabIndex={0}
                aria-label={`column ${c.type}`}
                className={clsx(
                  "flex items-start gap-2 rounded px-2 py-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40",
                  c.type === "added" && "bg-emerald-500/10",
                  c.type === "removed" && "bg-red-500/10",
                  c.type === "modified" && "bg-amber-500/10",
                )}
              >
                <ChangeBadge type={c.type} />
                {c.type === "modified" ? (
                  <span className="min-w-0 flex-1">
                    Column <code className="text-text-primary">{c.columnId}</code>
                    <FieldDeltaList deltas={c.changes} />
                  </span>
                ) : (
                  <span className="min-w-0 flex-1">
                    Column{" "}
                    <code className="text-text-primary">
                      {recordLabel(c.column as Record<string, unknown>, `#${i}`)}
                    </code>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {rowChanges.length > 0 && (
        <section>
          <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
            Row changes
          </h4>
          <ul role="list" className="space-y-1">
            {rowChanges.map((r, i) => (
              <li
                key={i}
                tabIndex={0}
                aria-label={`row ${r.type}`}
                className={clsx(
                  "flex items-start gap-2 rounded px-2 py-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40",
                  r.type === "added" && "bg-emerald-500/10",
                  r.type === "removed" && "bg-red-500/10",
                  r.type === "modified" && "bg-amber-500/10",
                )}
              >
                <ChangeBadge type={r.type} />
                {r.type === "modified" ? (
                  <span className="min-w-0 flex-1">
                    Row <code className="text-text-primary">{r.rowId}</code>
                    <FieldDeltaList
                      deltas={r.cellDeltas.map((d) => ({
                        field: d.columnKey,
                        from: d.from,
                        to: d.to,
                      }))}
                    />
                  </span>
                ) : (
                  <span className="min-w-0 flex-1 text-text-secondary">
                    Row at index {r.index}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Board diff — before/after card positions (VAL-DIFF-057)
// ---------------------------------------------------------------------------

function BoardDiffView({ board }: { board: BoardDiffResult }) {
  const changes = board.cardChanges ?? [];
  if (changes.length === 0) return <EmptyDiff />;

  return (
    <div className="space-y-3 text-xs">
      <ul role="list" className="space-y-1.5">
        {changes.map((c, i) => {
          const label =
            c.type === "added" || c.type === "removed"
              ? recordLabel(c.card as Record<string, unknown>, `card #${i}`)
              : c.type === "moved"
                ? recordLabel(c.from as Record<string, unknown>, c.cardId)
                : c.cardId;
          return (
            <li
              key={i}
              tabIndex={0}
              aria-label={`card ${c.type}: ${label}`}
              className={clsx(
                "flex items-start gap-2 rounded px-2 py-1.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40",
                c.type === "added" && "bg-emerald-500/10",
                c.type === "removed" && "bg-red-500/10",
                c.type === "moved" && "bg-sky-500/10",
                c.type === "modified" && "bg-amber-500/10",
              )}
            >
              <ChangeBadge type={c.type} />
              <span className="min-w-0 flex-1">
                <span className="text-text-primary">{label}</span>
                {c.type === "moved" && (
                  <span className="mt-1 flex flex-wrap items-center gap-1 text-text-secondary">
                    <span className="rounded bg-white/[0.04] px-1.5 py-0.5">
                      col: {String((c.from as Record<string, unknown>).columnId ?? "—")}
                    </span>
                    <ArrowRight className="h-3 w-3 text-accent" />
                    <span className="rounded bg-white/[0.04] px-1.5 py-0.5">
                      col: {String((c.to as Record<string, unknown>).columnId ?? "—")}
                    </span>
                    <span className="rounded bg-white/[0.04] px-1.5 py-0.5">
                      order: {String((c.from as Record<string, unknown>).order ?? "—")}
                    </span>
                    <ArrowRight className="h-3 w-3 text-accent" />
                    <span className="rounded bg-white/[0.04] px-1.5 py-0.5">
                      order: {String((c.to as Record<string, unknown>).order ?? "—")}
                    </span>
                  </span>
                )}
                {c.type === "modified" && <FieldDeltaList deltas={c.changes} />}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Structured field-level changes list (slide_deck / timeline / gallery /
// dashboard) — VAL-DIFF-058
// ---------------------------------------------------------------------------

function SlidesDiffView({ slides }: { slides: SlidesDiffResult }) {
  const changes = slides.slideChanges ?? [];
  if (changes.length === 0) return <EmptyDiff />;
  return (
    <div className="space-y-2 text-xs">
      {changes.map((c, i) => (
        <div
          key={i}
          tabIndex={0}
          aria-label={`slide ${c.type}`}
          className={clsx(
            "rounded px-2 py-1.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40",
            c.type === "added" && "bg-emerald-500/10",
            c.type === "removed" && "bg-red-500/10",
            c.type === "reordered" && "bg-sky-500/10",
            c.type === "modified" && "bg-amber-500/10",
          )}
        >
          <div className="flex items-center gap-2">
            <ChangeBadge type={c.type} />
            <span className="text-text-primary">
              {c.type === "added" || c.type === "removed"
                ? recordLabel(c.slide as Record<string, unknown>, `slide #${c.index}`)
                : c.type === "reordered"
                  ? `Slide ${c.slideId}: index ${c.fromIndex} → ${c.toIndex}`
                  : `Slide ${c.slideId}`}
            </span>
          </div>
          {c.type === "modified" && (
            <div className="mt-1 pl-6">
              <BlockDeltaList deltas={c.blockDeltas} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function BlockDeltaList({
  deltas,
}: {
  deltas: Array<
    | { type: "added"; block: Record<string, unknown>; index: number }
    | { type: "removed"; block: Record<string, unknown>; index: number }
    | {
        type: "modified";
        blockIndex: number;
        changes: Array<{ field: string; from?: unknown; to?: unknown }>;
      }
  >;
}) {
  if (deltas.length === 0) return null;
  return (
    <ul role="list" className="space-y-1">
      {deltas.map((d, i) => (
        <li
          key={i}
          tabIndex={0}
          aria-label={`block ${d.type}`}
          className={clsx(
            "flex items-start gap-2 rounded px-2 py-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40",
            d.type === "added" && "bg-emerald-500/10",
            d.type === "removed" && "bg-red-500/10",
            d.type === "modified" && "bg-amber-500/10",
          )}
        >
          <ChangeBadge type={d.type} />
          {d.type === "modified" ? (
            <span className="min-w-0 flex-1">
              Block #{d.blockIndex}
              <FieldDeltaList deltas={d.changes} />
            </span>
          ) : (
            <span className="min-w-0 flex-1 text-text-secondary">
              Block #{d.index}:{" "}
              {recordLabel(d.block, "")}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function TimelineDiffView({ timeline }: { timeline: TimelineDiffResult }) {
  const changes = timeline.taskChanges ?? [];
  if (changes.length === 0) return <EmptyDiff />;
  return (
    <div className="space-y-2 text-xs">
      {changes.map((c, i) => (
        <div
          key={i}
          tabIndex={0}
          aria-label={`task ${c.type}`}
          className={clsx(
            "rounded px-2 py-1.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40",
            c.type === "added" && "bg-emerald-500/10",
            c.type === "removed" && "bg-red-500/10",
            c.type === "modified" && "bg-amber-500/10",
          )}
        >
          <div className="flex items-center gap-2">
            <ChangeBadge type={c.type} />
            <span className="text-text-primary">
              {c.type === "added" || c.type === "removed"
                ? recordLabel(c.task as Record<string, unknown>, `task #${i}`)
                : `Task ${c.taskId}`}
            </span>
          </div>
          {c.type === "modified" && (
            <div className="mt-1 pl-6">
              <FieldDeltaList deltas={c.fieldDeltas} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function GalleryDiffView({ gallery }: { gallery: GalleryDiffResult }) {
  const changes = gallery.itemChanges ?? [];
  if (changes.length === 0) return <EmptyDiff />;
  return (
    <div className="space-y-2 text-xs">
      {changes.map((c, i) => (
        <div
          key={i}
          tabIndex={0}
          aria-label={`item ${c.type}`}
          className={clsx(
            "rounded px-2 py-1.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40",
            c.type === "added" && "bg-emerald-500/10",
            c.type === "removed" && "bg-red-500/10",
            c.type === "modified" && "bg-amber-500/10",
          )}
        >
          <div className="flex items-center gap-2">
            <ChangeBadge type={c.type} />
            <span className="text-text-primary">
              {c.type === "added" || c.type === "removed"
                ? recordLabel(c.item as Record<string, unknown>, `item #${i}`)
                : `Item ${c.itemId}`}
            </span>
          </div>
          {c.type === "modified" && (
            <div className="mt-1 pl-6">
              <FieldDeltaList deltas={c.fieldDeltas} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function DashboardDiffView({ dashboard }: { dashboard: DashboardDiffResult }) {
  const ds = dashboard.dataSourceChanges ?? [];
  const wd = dashboard.widgetChanges ?? [];
  if (ds.length === 0 && wd.length === 0) return <EmptyDiff />;
  return (
    <div className="space-y-4 text-xs">
      {ds.length > 0 && (
        <section>
          <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
            Data source changes
          </h4>
          <div className="space-y-2">
            {ds.map((c, i) => (
              <div
                key={i}
                tabIndex={0}
                aria-label={`data source ${c.type}`}
                className={clsx(
                  "rounded px-2 py-1.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40",
                  c.type === "added" && "bg-emerald-500/10",
                  c.type === "removed" && "bg-red-500/10",
                  c.type === "modified" && "bg-amber-500/10",
                )}
              >
                <div className="flex items-center gap-2">
                  <ChangeBadge type={c.type} />
                  <span className="text-text-primary">
                    {c.type === "added" || c.type === "removed"
                      ? recordLabel(
                          c.dataSource as Record<string, unknown>,
                          `source #${i}`,
                        )
                      : `Source ${c.dataSourceId}`}
                  </span>
                </div>
                {c.type === "modified" && (
                  <div className="mt-1 pl-6">
                    <FieldDeltaList deltas={c.fieldDeltas} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      {wd.length > 0 && (
        <section>
          <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
            Widget changes
          </h4>
          <div className="space-y-2">
            {wd.map((c, i) => (
              <div
                key={i}
                tabIndex={0}
                aria-label={`widget ${c.type}`}
                className={clsx(
                  "rounded px-2 py-1.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40",
                  c.type === "added" && "bg-emerald-500/10",
                  c.type === "removed" && "bg-red-500/10",
                  c.type === "modified" && "bg-amber-500/10",
                )}
              >
                <div className="flex items-center gap-2">
                  <ChangeBadge type={c.type} />
                  <span className="text-text-primary">
                    {c.type === "added" || c.type === "removed"
                      ? recordLabel(
                          c.widget as Record<string, unknown>,
                          `widget #${i}`,
                        )
                      : `Widget ${c.widgetId}`}
                  </span>
                </div>
                {c.type === "modified" && (
                  <div className="mt-1 pl-6">
                    <FieldDeltaList deltas={c.fieldDeltas} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// File diff (app / code) — file-level + line diff within modified files
// ---------------------------------------------------------------------------

function FileDiffView({
  fileDiff,
  mode,
  fromVersion,
  toVersion,
}: {
  fileDiff: FileDiffResult;
  mode: DiffViewMode;
  fromVersion: number;
  toVersion: number;
}) {
  const changes = fileDiff.fileChanges ?? [];
  if (changes.length === 0) return <EmptyDiff />;
  return (
    <div className="space-y-3 text-xs">
      {changes.map((c, i) => (
        <div
          key={i}
          tabIndex={0}
          aria-label={`file ${c.type}: ${c.path}`}
          className={clsx(
            "rounded border px-2 py-1.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40",
            c.type === "added" && "border-emerald-500/20 bg-emerald-500/[0.04]",
            c.type === "removed" && "border-red-500/20 bg-red-500/[0.04]",
            c.type === "modified" && "border-amber-500/20 bg-amber-500/[0.04]",
          )}
        >
          <div className="flex items-center gap-2">
            <ChangeBadge type={c.type} />
            <code className="text-text-primary">{c.path}</code>
          </div>
          {c.type === "modified" && (
            <div className="mt-1.5">
              <LineDiffView
                lines={c.lineDiff.lines}
                mode={mode}
                fromVersion={fromVersion}
                toVersion={toVersion}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function ChangeBadge({
  type,
}: {
  type: "added" | "removed" | "modified" | "moved" | "reordered";
}) {
  const map = {
    added: { icon: Plus, label: "added", cls: "text-emerald-400" },
    removed: { icon: Minus, label: "removed", cls: "text-red-400" },
    modified: { icon: Pencil, label: "modified", cls: "text-amber-400" },
    moved: { icon: ArrowRight, label: "moved", cls: "text-sky-400" },
    reordered: { icon: ArrowRight, label: "reordered", cls: "text-sky-400" },
  } as const;
  const { icon: Icon, label, cls } = map[type];
  return (
    <span
      className={clsx(
        "inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-semibold",
        cls,
      )}
      aria-label={label}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {label}
    </span>
  );
}

function FieldDeltaList({
  deltas,
}: {
  deltas: Array<{ field: string; from?: unknown; to?: unknown }>;
}) {
  if (deltas.length === 0) return null;
  return (
    <ul role="list" className="mt-1 space-y-0.5">
      {deltas.map((d, i) => (
        <li
          key={i}
          tabIndex={0}
          aria-label={`field ${d.field} changed`}
          className="flex flex-wrap items-center gap-1 rounded px-1.5 py-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
        >
          <code className="text-text-primary">{d.field}</code>
          <span className="rounded bg-red-500/10 px-1 py-0.5 text-red-300">
            {fmtVal(d.from)}
          </span>
          <ArrowRight className="h-3 w-3 text-accent" aria-hidden />
          <span className="rounded bg-emerald-500/10 px-1 py-0.5 text-emerald-300">
            {fmtVal(d.to)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function EmptyDiff() {
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-4 py-10 text-sm text-text-secondary"
    >
      <Check className="h-4 w-4 text-emerald-400" />
      No changes between these revisions.
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main DiffViewer
// ---------------------------------------------------------------------------

export interface DiffViewerProps {
  diff: DiffResult;
  artifactType: ArtifactType;
  fromVersion: number;
  toVersion: number;
}

export function DiffViewer({
  diff,
  artifactType,
  fromVersion,
  toVersion,
}: DiffViewerProps) {
  const [mode, setMode] = useState<DiffViewMode>(readDiffViewPref);

  // Persist the toggle preference (VAL-DIFF-063).
  useEffect(() => {
    writeDiffViewPref(mode);
  }, [mode]);

  const showToggle =
    artifactType === "document" ||
    artifactType === "code" ||
    artifactType === "app";

  const empty = isDiffEmpty(diff);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <DiffSummaryHeader summary={diff.summary} />
        {showToggle && !empty && (
          <ViewToggle mode={mode} onChange={setMode} />
        )}
      </div>

      {empty ? (
        <EmptyDiff />
      ) : artifactType === "document" && diff.document ? (
        <LineDiffView
          lines={diff.document.lines}
          mode={mode}
          fromVersion={fromVersion}
          toVersion={toVersion}
        />
      ) : artifactType === "code" && diff.code ? (
        <FileDiffView
          fileDiff={diff.code}
          mode={mode}
          fromVersion={fromVersion}
          toVersion={toVersion}
        />
      ) : artifactType === "app" && diff.app ? (
        <FileDiffView
          fileDiff={diff.app}
          mode={mode}
          fromVersion={fromVersion}
          toVersion={toVersion}
        />
      ) : artifactType === "sheet" && diff.sheet ? (
        <SheetDiffView sheet={diff.sheet} />
      ) : artifactType === "board" && diff.board ? (
        <BoardDiffView board={diff.board} />
      ) : artifactType === "slide_deck" && diff.slides ? (
        <SlidesDiffView slides={diff.slides} />
      ) : artifactType === "timeline" && diff.timeline ? (
        <TimelineDiffView timeline={diff.timeline} />
      ) : artifactType === "gallery" && diff.gallery ? (
        <GalleryDiffView gallery={diff.gallery} />
      ) : artifactType === "dashboard" && diff.dashboard ? (
        <DashboardDiffView dashboard={diff.dashboard} />
      ) : (
        <EmptyDiff />
      )}
    </div>
  );
}
