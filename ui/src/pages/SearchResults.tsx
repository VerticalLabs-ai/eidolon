// ---------------------------------------------------------------------------
// SearchResults — full cross-artifact search results page.
// (M1 — Artifact Intelligence & Discovery)
//
// Route: /company/:companyId/search?q=...&type=...&folderId=...&authorId=...
//        &dateFrom=...&dateTo=...&offset=...
//
// Features:
//   • Filter sidebar: type checkboxes, folder dropdown, author dropdown,
//     date range picker (VAL-SEARCH-054..058).
//   • Result rows with context snippets + query highlighting (VAL-SEARCH-059).
//   • Pagination (VAL-SEARCH-060/061).
//   • Each result links to its entity (VAL-SEARCH-062).
//   • Empty / loading / error states (VAL-SEARCH-063/064/067).
//   • URL is shareable — cold load renders the same filtered results
//     (VAL-SEARCH-075) because all filters live in the query string.
// ---------------------------------------------------------------------------

import { useCallback, useMemo } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Search,
  Loader2,
  AlertCircle,
  FileText,
  MessageSquare,
  ListTodo,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useSearch, useFolders, useSearchAuthors } from "@/lib/hooks";
import type { SearchResult, ArtifactType } from "@/lib/api";
import { resultRoute, renderSnippet } from "@/components/search/search-utils";

const PAGE_SIZE = 20;

const ALL_TYPES: { value: ArtifactType; label: string }[] = [
  { value: "document", label: "Document" },
  { value: "sheet", label: "Sheet" },
  { value: "board", label: "Board" },
  { value: "slide_deck", label: "Slides" },
  { value: "timeline", label: "Timeline" },
  { value: "gallery", label: "Gallery" },
  { value: "dashboard", label: "Dashboard" },
  { value: "app", label: "App" },
  { value: "code", label: "Code" },
];

const ARTIFACT_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  ALL_TYPES.map((t) => [t.value, t.label]),
);

export function SearchResults() {
  const { companyId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const q = searchParams.get("q") ?? "";
  const typeFilter = searchParams.get("type") ?? "";
  const folderId = searchParams.get("folderId") ?? "";
  const authorId = searchParams.get("authorId") ?? "";
  const dateFrom = searchParams.get("dateFrom") ?? "";
  const dateTo = searchParams.get("dateTo") ?? "";
  const offset = Math.max(0, Number(searchParams.get("offset") ?? "0"));

  // Sidebar filter data sources.
  // Pass `undefined` (not `null`) for projectId so useFolders fetches ALL
  // folders for the company — both company-level (project_id IS NULL) and
  // project-scoped. Passing `null` would filter to project_id IS NULL only,
  // leaving the dropdown empty when folders are project-scoped.
  // (VAL-SEARCH-056)
  const { data: folders = [] } = useFolders(companyId, undefined);
  const { data: authors = [] } = useSearchAuthors(companyId);

  const filters = useMemo(
    () => ({
      type: typeFilter || undefined,
      folderId: folderId || undefined,
      authorId: authorId || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      limit: PAGE_SIZE,
      offset,
    }),
    [typeFilter, folderId, authorId, dateFrom, dateTo, offset],
  );

  const { data, isLoading, isError } = useSearch(companyId, q, filters);

  const results = data?.results ?? [];
  const total = data?.total ?? 0;
  const hasQuery = q.trim().length >= 2;

  // ── URL sync helpers ──────────────────────────────────────────────────
  const updateParam = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(searchParams);
      if (value) next.set(key, value);
      else next.delete(key);
      // Reset pagination when a filter changes.
      if (key !== "offset") next.delete("offset");
      setSearchParams(next, { replace: false });
    },
    [searchParams, setSearchParams],
  );

  const handlePage = useCallback(
    (newOffset: number) => {
      const next = new URLSearchParams(searchParams);
      if (newOffset > 0) next.set("offset", String(newOffset));
      else next.delete("offset");
      setSearchParams(next, { replace: false });
    },
    [searchParams, setSearchParams],
  );

  const navigateTo = useCallback(
    (result: SearchResult) => {
      if (!companyId) return;
      const route = resultRoute(result, companyId);
      if (route) navigate(route);
    },
    [companyId, navigate],
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="p-5 sm:p-6">
      <div className="mx-auto flex max-w-6xl gap-6">
        {/* ── Filter sidebar (VAL-SEARCH-054) ─────────────────────────── */}
        <aside className="w-56 shrink-0 space-y-5">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
            Filters
          </h2>

          {/* Type checkboxes (VAL-SEARCH-055) */}
          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium text-text-secondary">Type</legend>
            {ALL_TYPES.map((t) => (
              <label
                key={t.value}
                className="flex cursor-pointer items-center gap-2 text-sm text-text-secondary hover:text-text-primary"
              >
                <input
                  type="checkbox"
                  checked={typeFilter === t.value}
                  onChange={(e) => updateParam("type", e.target.checked ? t.value : "")}
                  className="h-3.5 w-3.5 rounded border-white/20 bg-white/[0.04] accent-accent"
                />
                {t.label}
              </label>
            ))}
          </fieldset>

          {/* Folder dropdown (VAL-SEARCH-056) */}
          <div className="space-y-1.5">
            <label htmlFor="filter-folder" className="text-xs font-medium text-text-secondary">
              Folder
            </label>
            <select
              id="filter-folder"
              value={folderId}
              onChange={(e) => updateParam("folderId", e.target.value)}
              className="h-8 w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-2 text-sm text-text-primary outline-none focus:border-accent/40"
            >
              <option value="">All folders</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>

          {/* Author dropdown (VAL-SEARCH-057) */}
          <div className="space-y-1.5">
            <label htmlFor="filter-author" className="text-xs font-medium text-text-secondary">
              Author
            </label>
            <select
              id="filter-author"
              value={authorId}
              onChange={(e) => updateParam("authorId", e.target.value)}
              className="h-8 w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-2 text-sm text-text-primary outline-none focus:border-accent/40"
            >
              <option value="">Anyone</option>
              {authors.map((a) => (
                <option key={a.entityId} value={a.entityId}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>

          {/* Date range (VAL-SEARCH-058) */}
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-text-secondary">Updated</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => updateParam("dateFrom", e.target.value)}
              aria-label="Updated from"
              className="h-8 w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-2 text-sm text-text-primary outline-none focus:border-accent/40"
            />
            <input
              type="date"
              value={dateTo}
              onChange={(e) => updateParam("dateTo", e.target.value)}
              aria-label="Updated to"
              className="h-8 w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-2 text-sm text-text-primary outline-none focus:border-accent/40"
            />
          </div>

          {(typeFilter || folderId || authorId || dateFrom || dateTo) && (
            <button
              type="button"
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.delete("type");
                next.delete("folderId");
                next.delete("authorId");
                next.delete("dateFrom");
                next.delete("dateTo");
                next.delete("offset");
                setSearchParams(next, { replace: false });
              }}
              className="text-xs font-medium text-accent hover:underline"
            >
              Clear filters
            </button>
          )}
        </aside>

        {/* ── Results column ────────────────────────────────────────────── */}
        <div className="min-w-0 flex-1 space-y-4">
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <Search className="h-4 w-4" />
            <span>
              {hasQuery ? (
                <>
                  {isLoading ? "Searching…" : `${total} result${total === 1 ? "" : "s"} for `}
                  <span className="font-medium text-text-primary">“{q}”</span>
                </>
              ) : (
                "Type at least 2 characters to search."
              )}
            </span>
          </div>

          {isLoading && (
            <div className="flex items-center gap-2 py-12 text-sm text-text-secondary">
              <Loader2 className="h-4 w-4 animate-spin" />
              Searching…
            </div>
          )}

          {!isLoading && isError && (
            <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/[0.04] px-4 py-6 text-sm text-red-400">
              <AlertCircle className="h-4 w-4 shrink-0" />
              Search failed. Please try again.
            </div>
          )}

          {!isLoading && !isError && hasQuery && results.length === 0 && (
            <div className="py-16 text-center text-sm text-text-secondary">
              No results found for “{q}”. Try a different query or clear filters.
            </div>
          )}

          {!isLoading && !isError && results.length > 0 && (
            <>
              <ul className="space-y-2">
                {results.map((result) => (
                  <ResultRow
                    key={`${result.entityType}-${result.entityId}`}
                    result={result}
                    query={q}
                    onClick={() => navigateTo(result)}
                  />
                ))}
              </ul>

              {/* Pagination (VAL-SEARCH-060/061) */}
              {total > PAGE_SIZE && (
                <nav
                  aria-label="Search results pagination"
                  className="flex items-center justify-between pt-2"
                >
                  <span className="text-xs text-text-secondary">
                    Page {currentPage} of {totalPages} · {total} total
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={offset === 0}
                      onClick={() => handlePage(Math.max(0, offset - PAGE_SIZE))}
                      className="flex h-8 items-center gap-1 rounded-lg border border-white/[0.06] px-3 text-sm text-text-secondary transition-colors hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Prev
                    </button>
                    <button
                      type="button"
                      disabled={offset + PAGE_SIZE >= total}
                      onClick={() => handlePage(offset + PAGE_SIZE)}
                      className="flex h-8 items-center gap-1 rounded-lg border border-white/[0.06] px-3 text-sm text-text-secondary transition-colors hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Next
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                </nav>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result row
// ---------------------------------------------------------------------------

interface ResultRowProps {
  result: SearchResult;
  query: string;
  onClick: () => void;
}

function ResultRow({ result, query, onClick }: ResultRowProps) {
  const isArtifact = result.entityType === "artifact";
  const isThread = result.entityType === "thread_item";
  const Icon = isArtifact ? FileText : isThread ? MessageSquare : ListTodo;
  const typeLabel = isArtifact
    ? (ARTIFACT_TYPE_LABELS[result.artifactType ?? ""] ?? "Artifact")
    : isThread
      ? "Thread"
      : "Task";

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="block w-full rounded-lg border border-white/[0.04] bg-white/[0.02] px-4 py-3 text-left transition-colors hover:border-accent/20 hover:bg-white/[0.04]"
      >
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 shrink-0 text-text-secondary" />
          <span className="truncate text-sm font-medium text-text-primary">
            {result.title}
          </span>
          <span className="ml-auto shrink-0 rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium uppercase text-text-secondary">
            {typeLabel}
          </span>
          {result.status && (
            <span className="shrink-0 text-[10px] text-text-muted">{result.status}</span>
          )}
        </div>
        {result.snippet && (
          <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-text-secondary">
            {renderSnippet(result.snippet, query)}
          </p>
        )}
      </button>
    </li>
  );
}
