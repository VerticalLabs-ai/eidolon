// ---------------------------------------------------------------------------
// SearchBar — global cross-artifact search input in the AppShell header.
// (M1 — Artifact Intelligence & Discovery)
//
// Behaviors:
//   • Always visible in the header on every in-app page (VAL-SEARCH-040).
//   • Cmd/Ctrl+K focuses the input (VAL-SEARCH-041).
//   • 300ms debounce before querying (VAL-SEARCH-042/046).
//   • Instant dropdown: top 5 artifacts + 3 thread items + 3 tasks
//     (VAL-SEARCH-043/044/045).
//   • Keyboard navigation: Arrow Down/Up moves highlight, Enter navigates,
//     Esc closes (VAL-SEARCH-047/048/049/050).
//   • Click navigates to the entity (VAL-SEARCH-051).
//   • Clears after navigation (VAL-SEARCH-065).
//   • Empty / loading / error states (VAL-SEARCH-063/064/067).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Search, Loader2, FileText, MessageSquare, ListTodo, AlertCircle } from "lucide-react";
import { useSearch } from "@/lib/hooks";
import type { SearchResult } from "@/lib/api";
import { resultRoute, renderSnippet } from "./search-utils";

const ARTIFACT_CAP = 5;
const THREAD_CAP = 3;
const TASK_CAP = 3;

const ARTIFACT_TYPES: Record<string, string> = {
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

interface FlatRow {
  result: SearchResult;
  group: "artifact" | "thread_item" | "task";
  groupIndex: number;
}

export function SearchBar() {
  const { companyId } = useParams();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const { data, isLoading, isError } = useSearch(companyId, query);

  // ── Group + cap results for the dropdown ──────────────────────────────
  const { flatRows, groups } = useMemo(() => {
    const results = data?.results ?? [];
    const artifacts = results.filter((r) => r.entityType === "artifact").slice(0, ARTIFACT_CAP);
    const threads = results.filter((r) => r.entityType === "thread_item").slice(0, THREAD_CAP);
    const tasks = results.filter((r) => r.entityType === "task").slice(0, TASK_CAP);
    const rows: FlatRow[] = [
      ...artifacts.map((r, i) => ({ result: r, group: "artifact" as const, groupIndex: i })),
      ...threads.map((r, i) => ({ result: r, group: "thread_item" as const, groupIndex: i })),
      ...tasks.map((r, i) => ({ result: r, group: "task" as const, groupIndex: i })),
    ];
    return {
      flatRows: rows,
      groups: { artifact: artifacts, thread_item: threads, task: tasks },
    };
  }, [data?.results]);

  // ── Cmd/Ctrl+K focuses the search bar (VAL-SEARCH-041) ─────────────────
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // ── Open dropdown when typing; close on outside click ─────────────────
  useEffect(() => {
    if (query.trim().length >= 2) {
      setOpen(true);
    } else {
      setOpen(false);
    }
  }, [query]);

  useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  // Keep activeIndex in range when the row set changes.
  useEffect(() => {
    if (activeIndex >= flatRows.length) setActiveIndex(0);
  }, [flatRows.length, activeIndex]);

  // ── Navigate to a result and clear the bar (VAL-SEARCH-049/051/065) ───
  const navigateTo = useCallback(
    (result: SearchResult) => {
      const route = companyId ? resultRoute(result, companyId) : null;
      if (route) {
        navigate(route);
      }
      setQuery("");
      setOpen(false);
      inputRef.current?.blur();
    },
    [companyId, navigate],
  );

  const goToFullResults = useCallback(() => {
    if (!companyId || query.trim().length < 2) return;
    const params = new URLSearchParams({ q: query.trim() });
    navigate(`/company/${companyId}/search?${params.toString()}`);
    setQuery("");
    setOpen(false);
    inputRef.current?.blur();
  }, [companyId, query, navigate]);

  // ── Keyboard handling (VAL-SEARCH-047/048/049/050) ─────────────────────
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (!open && query.trim().length >= 2) {
          setOpen(true);
          return;
        }
        setOpen(true);
        setActiveIndex((i) => (flatRows.length === 0 ? 0 : (i + 1) % flatRows.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setOpen(true);
        setActiveIndex((i) =>
          flatRows.length === 0 ? 0 : (i - 1 + flatRows.length) % flatRows.length,
        );
      } else if (e.key === "Enter") {
        if (flatRows.length > 0) {
          e.preventDefault();
          navigateTo(flatRows[activeIndex].result);
        } else {
          goToFullResults();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    },
    [open, query, flatRows, activeIndex, navigateTo, goToFullResults],
  );

  const showDropdown = open && query.trim().length >= 2;
  const hasResults = flatRows.length > 0;

  return (
    <div ref={containerRef} className="relative flex-1 max-w-md" role="search">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary"
          aria-hidden
        />
        <input
          ref={inputRef}
          type="search"
          role="searchbox"
          aria-label="Search artifacts, threads, and tasks"
          aria-expanded={showDropdown}
          aria-controls="search-dropdown"
          placeholder="Search artifacts, threads, tasks…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => {
            if (query.trim().length >= 2) setOpen(true);
          }}
          className="h-9 w-full rounded-lg border border-white/[0.06] bg-white/[0.03] pl-9 pr-16 text-sm text-text-primary placeholder:text-text-secondary outline-none transition-colors focus:border-accent/40 focus:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-accent/30"
        />
        <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
          ⌘K
        </kbd>
      </div>

      {showDropdown && (
        <div
          id="search-dropdown"
          role="listbox"
          aria-label="Search results"
          className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-xl border border-white/[0.08] bg-surface-overlay shadow-2xl"
        >
          {isLoading && (
            <div className="flex items-center gap-2 px-4 py-6 text-sm text-text-secondary">
              <Loader2 className="h-4 w-4 animate-spin" />
              Searching…
            </div>
          )}

          {!isLoading && isError && (
            <div className="flex items-center gap-2 px-4 py-6 text-sm text-red-400">
              <AlertCircle className="h-4 w-4 shrink-0" />
              Search failed. Try again.
            </div>
          )}

          {!isLoading && !isError && !hasResults && (
            <div className="px-4 py-6 text-center text-sm text-text-secondary">
              No results for “{query.trim()}”.
            </div>
          )}

          {!isLoading && !isError && hasResults && (
            <>
              {groups.artifact.length > 0 && (
                <DropdownGroup
                  heading="Artifacts"
                  icon={FileText}
                  rows={groups.artifact.map((r, i) => flatRows[i])}
                  activeIndex={activeIndex}
                  startIndex={0}
                  onHover={setActiveIndex}
                  onClick={navigateTo}
                  query={query}
                />
              )}
              {groups.thread_item.length > 0 && (
                <DropdownGroup
                  heading="Threads"
                  icon={MessageSquare}
                  rows={groups.thread_item.map(
                    (r, i) => flatRows[groups.artifact.length + i],
                  )}
                  activeIndex={activeIndex}
                  startIndex={groups.artifact.length}
                  onHover={setActiveIndex}
                  onClick={navigateTo}
                  query={query}
                />
              )}
              {groups.task.length > 0 && (
                <DropdownGroup
                  heading="Tasks"
                  icon={ListTodo}
                  rows={groups.task.map(
                    (r, i) => flatRows[groups.artifact.length + groups.thread_item.length + i],
                  )}
                  activeIndex={activeIndex}
                  startIndex={groups.artifact.length + groups.thread_item.length}
                  onHover={setActiveIndex}
                  onClick={navigateTo}
                  query={query}
                />
              )}
              <button
                type="button"
                onClick={goToFullResults}
                className="flex w-full items-center justify-center border-t border-white/[0.06] px-4 py-2.5 text-xs font-medium text-accent transition-colors hover:bg-accent/[0.06]"
              >
                See all results
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dropdown group
// ---------------------------------------------------------------------------

interface DropdownGroupProps {
  heading: string;
  icon: React.ComponentType<{ className?: string }>;
  rows: FlatRow[];
  activeIndex: number;
  startIndex: number;
  onHover: (index: number) => void;
  onClick: (result: SearchResult) => void;
  query: string;
}

function DropdownGroup({
  heading,
  icon: Icon,
  rows,
  activeIndex,
  startIndex,
  onHover,
  onClick,
  query,
}: DropdownGroupProps) {
  return (
    <div className="border-b border-white/[0.04] last:border-b-0">
      <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-text-secondary">
        <Icon className="h-3 w-3" />
        {heading}
      </div>
      <ul role="presentation">
        {rows.map((row, i) => {
          const absoluteIndex = startIndex + i;
          const active = absoluteIndex === activeIndex;
          return (
            <li key={`${row.result.entityType}-${row.result.entityId}`}>
              <button
                type="button"
                role="option"
                aria-selected={active}
                onMouseEnter={() => onHover(absoluteIndex)}
                onClick={() => onClick(row.result)}
                className={
                  "flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors " +
                  (active ? "bg-accent/[0.08]" : "hover:bg-white/[0.03]")
                }
              >
                <span className="mt-0.5 shrink-0 text-[10px] font-medium uppercase text-text-muted">
                  {row.result.entityType === "artifact"
                    ? (ARTIFACT_TYPES[row.result.artifactType ?? ""] ?? "Artifact")
                    : row.result.entityType === "thread_item"
                      ? "Thread"
                      : "Task"}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-text-primary">
                    {row.result.title}
                  </span>
                  {row.result.snippet && (
                    <span className="block truncate text-xs text-text-secondary">
                      {renderSnippet(row.result.snippet, query)}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
