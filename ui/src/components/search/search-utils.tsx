// ---------------------------------------------------------------------------
// Cross-artifact search UI helpers (M1 — Artifact Intelligence & Discovery)
//
// Shared between the header SearchBar dropdown and the full SearchResults
// page: entity navigation targets + context-snippet highlighting.
// ---------------------------------------------------------------------------

import type { ReactNode } from "react";
import type { SearchResult } from "@/lib/api";

/**
 * Resolve the in-app route for a search result so the UI can navigate to the
 * matching entity (artifact editor, task thread, or project thread).
 *
 * - artifact      → /company/:cid/artifacts?artifactId=<id>
 * - thread_item   → task thread (/company/:cid/tasks/:taskId) when the item
 *                   belongs to a task, or the project home
 *                   (/company/:cid/projects/:projectId) when it belongs to a
 *                   project thread.
 * - task          → /company/:cid/tasks/:taskId
 *
 * Returns null when a thread_item lacks navigation context (should not happen
 * with the current backend, but guarded for safety).
 */
export function resultRoute(result: SearchResult, companyId: string): string | null {
  const base = `/company/${companyId}`;
  if (result.entityType === "artifact") {
    return `${base}/artifacts?artifactId=${encodeURIComponent(result.entityId)}`;
  }
  if (result.entityType === "task") {
    return `${base}/tasks/${encodeURIComponent(result.entityId)}`;
  }
  // thread_item
  if (result.taskId) {
    return `${base}/tasks/${encodeURIComponent(result.taskId)}`;
  }
  if (result.projectThreadId && result.projectId) {
    return `${base}/projects/${encodeURIComponent(result.projectId)}`;
  }
  return null;
}

/**
 * Render a context snippet with the matched query term highlighted.
 *
 * Artifact snippets arrive from Postgres `ts_headline` with `<<term>>`
 * delimiters (StartSel/StopSel configured in search-service.ts). Thread-item
 * and task snippets are plain text windows without delimiters; for those we
 * highlight the first case-insensitive occurrence of the query term.
 *
 * Returns an array of React nodes so callers can wrap them in any element.
 */
export function renderSnippet(snippet: string, query: string): ReactNode[] {
  if (!snippet) return [];
  const hasDelimiters = snippet.includes("<<");
  if (hasDelimiters) {
    // Split on <<...>> markers emitted by ts_headline.
    const parts = snippet.split(/(<<[^>]*>>)/g);
    return parts.map((part, i) => {
      const m = part.match(/^<<(.*)>>$/);
      if (m) {
        return (
          <mark
            key={i}
            className="rounded bg-accent/25 px-0.5 text-text-primary"
          >
            {m[1]}
          </mark>
        );
      }
      return <span key={i}>{part}</span>;
    });
  }
  // No ts_headline delimiters: highlight the query term (case-insensitive).
  const q = query.trim();
  if (!q) return [<span key="0">{snippet}</span>];
  const lower = snippet.toLowerCase();
  const idx = lower.indexOf(q.toLowerCase());
  if (idx < 0) return [<span key="0">{snippet}</span>];
  return [
    <span key="pre">{snippet.slice(0, idx)}</span>,
    <mark key="hit" className="rounded bg-accent/25 px-0.5 text-text-primary">
      {snippet.slice(idx, idx + q.length)}
    </mark>,
    <span key="post">{snippet.slice(idx + q.length)}</span>,
  ];
}
