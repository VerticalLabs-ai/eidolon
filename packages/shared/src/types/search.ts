import { z } from 'zod';
import { ArtifactTypeSchema } from './artifact.js';

// ---------------------------------------------------------------------------
// Cross-artifact search types (M1 — Artifact Intelligence & Discovery)
// ---------------------------------------------------------------------------
//
// Unified search results across three entity sources:
//   • artifacts  — Postgres FTS over a generated tsvector (title weight A +
//                  content text weight B) with ts_rank + ts_headline snippets
//   • thread items — ILIKE over task_thread_items.content
//   • tasks      — ILIKE over tasks.title + tasks.description
//
// All search endpoints are company-scoped (requireAuth + requireOrgMember).
// Results carry enough metadata (projectId, folderId, artifactType, status)
// for the UI to link directly to the matching entity.
// ---------------------------------------------------------------------------

/** The kind of entity a search result points at. */
export const SearchResultEntityTypeSchema = z.enum([
  'artifact',
  'thread_item',
  'task',
]);
export type SearchResultEntityType = z.infer<typeof SearchResultEntityTypeSchema>;

/**
 * A single ranked search hit. `rank` is a non-negative relevance score
 * (artifacts use ts_rank; thread items + tasks use a synthetic recency-
 * based score). `snippet` is a short excerpt of the matched text generated
 * via ts_headline (artifacts) or a truncated ILIKE window (thread items +
 * tasks).
 */
export const SearchResultSchema = z.object({
  entityType: SearchResultEntityTypeSchema,
  entityId: z.string().min(1),
  title: z.string(),
  snippet: z.string(),
  rank: z.number(),
  // Artifact-only metadata. Present (possibly null) for entityType='artifact';
  // omitted for thread_item/task results.
  artifactType: ArtifactTypeSchema.optional(),
  projectId: z.string().nullable().optional(),
  folderId: z.string().nullable().optional(),
  // Task-only: the task's current status (e.g. 'todo', 'in_progress', 'done').
  status: z.string().optional(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

/** Top-level response envelope for GET /api/companies/:companyId/search. */
export const SearchResponseSchema = z.object({
  results: z.array(SearchResultSchema),
  total: z.number().int().nonnegative(),
  query: z.string(),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
