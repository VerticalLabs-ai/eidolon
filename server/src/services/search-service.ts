// ---------------------------------------------------------------------------
// Cross-artifact search service (M1 — Artifact Intelligence & Discovery)
// ---------------------------------------------------------------------------
//
// Executes three parallel queries against a company's data and merges the
// results into a single ranked list:
//
//   1. Artifacts — Postgres full-text search over the app-maintained
//      `search_tsv` tsvector (title weight A + content text weight B) using
//      `plainto_tsquery` + `ts_rank` for relevance + `ts_headline` for
//      context snippets. A GIN index on `search_tsv` makes `@@` fast.
//
//   2. Thread items — `ILIKE` over `task_thread_items.content`. Thread
//      items are lower volume than artifacts and carry structured mentions,
//      so a plain substring scan is sufficient.
//
//   3. Tasks — `ILIKE` over `tasks.title` + `tasks.description`.
//
// All three queries are company-scoped. Artifacts support type/folder/
// author/date filters (AND logic). Thread items and tasks support the date
// range filter (they have no type/folder/author concept that maps to the
// artifact filters). Results are merged, sorted by rank (artifacts by
// ts_rank; thread items + tasks by a synthetic recency score), and
// paginated via limit/offset on the merged list.
//
// `search_text` (the plaintext extracted at write time) feeds `ts_headline`
// so snippets preserve original casing of the matched text.
// ---------------------------------------------------------------------------

import { sql } from 'drizzle-orm';
import { ArtifactTypeSchema } from '@eidolon/shared';
import type { z } from 'zod';
import type { SearchResult, SearchResultEntityType } from '@eidolon/shared';
import type { DbInstance } from '../types.js';

type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

/** Input filters for the search service. All optional except companyId + query. */
export interface SearchInput {
  companyId: string;
  query: string;
  type?: ArtifactType;
  folderId?: string;
  authorId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  includeArchived?: boolean;
  limit: number;
  offset: number;
}

/** Maximum results fetched per source before merging + pagination. */
const SOURCE_CAP_MULTIPLIER = 1;

/**
 * Escape a string for use as an ILIKE pattern (% and _ are wildcards in
 * LIKE/ILIKE; backslash is the escape char). Wraps the escaped string in
 * `%...%` for substring matching. Special characters that are not LIKE
 * metacharacters (e.g. `+`, `.`, `@`) pass through untouched, so queries
 * like `C++` or `error.code` work without error (VAL-SEARCH-068).
 */
function ilikePattern(query: string): string {
  const escaped = query.replace(/[%_\\]/g, '\\$&');
  return `%${escaped}%`;
}

/**
 * Build a context snippet around the first case-insensitive match of the
 * query term within `text`. Returns a ~160-char window with ellipsis when
 * truncated. Used for thread item + task results (artifacts use ts_headline).
 */
function buildSnippet(text: string, query: string): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return '';
  const lower = clean.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx < 0) {
    // No direct substring (e.g. multi-word query). Return a head excerpt.
    return clean.length > 160 ? `${clean.slice(0, 157)}...` : clean;
  }
  const window = 80;
  const start = Math.max(0, idx - window);
  const end = Math.min(clean.length, idx + query.length + window);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < clean.length ? '...' : '';
  return `${prefix}${clean.slice(start, end)}${suffix}`;
}

/**
 * Synthetic recency-based rank for thread items and tasks (artifacts use
 * ts_rank from Postgres). Returns a value in (0, 1) where more recent
 * items score higher. Scaled below typical artifact title-match ranks so
 * FTS hits surface first, while still ordering non-artifacts by recency.
 */
function recencyRank(createdAt: Date, scale: number): number {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageDays = Math.max(0, ageMs / 86_400_000);
  return scale * (1 / (1 + ageDays));
}

// ---------------------------------------------------------------------------
// Artifact FTS query
// ---------------------------------------------------------------------------

interface ArtifactHit {
  id: string;
  title: string;
  type: ArtifactType;
  project_id: string | null;
  folder_id: string | null;
  status: string;
  rank: number;
  snippet: string;
}

async function searchArtifacts(
  db: DbInstance,
  input: SearchInput,
  cap: number,
): Promise<{ hits: ArtifactHit[]; total: number }> {
  const conditions: ReturnType<typeof sql>[] = [sql`a.company_id = ${input.companyId}`];
  // Status: 'deleted' is always excluded. 'archived' excluded unless includeArchived.
  if (input.includeArchived) {
    conditions.push(sql`a.status IN ('active', 'archived')`);
  } else {
    conditions.push(sql`a.status = 'active'`);
  }
  if (input.type) conditions.push(sql`a.type = ${input.type}`);
  if (input.folderId) conditions.push(sql`a.folder_id = ${input.folderId}`);
  if (input.authorId) conditions.push(sql`a.created_by_user_id = ${input.authorId}`);
  if (input.dateFrom) conditions.push(sql`a.updated_at >= ${input.dateFrom}`);
  if (input.dateTo) conditions.push(sql`a.updated_at <= ${input.dateTo}`);

  const whereClause = sql.join(conditions, sql` AND `);
  const tsquery = sql`plainto_tsquery('english', ${input.query})`;

  // Fetch a page of ranked artifact hits.
  const hitsRows = await db.drizzle.execute(sql`
    SELECT
      a.id,
      a.title,
      a.type,
      a.project_id,
      a.folder_id,
      a.status,
      ts_rank(a.search_tsv, ${tsquery}) AS rank,
      ts_headline('english', a.search_text, ${tsquery},
                   'MaxWords=35, MinWords=15, ShortWord=0, StartSel=<<, StopSel=>>, MaxFragments=1') AS snippet
    FROM artifacts a
    WHERE a.search_tsv @@ ${tsquery} AND ${whereClause}
    ORDER BY rank DESC, a.updated_at DESC
    LIMIT ${cap}
  `);

  // Total count of matching artifacts (no limit/offset).
  const countRows = await db.drizzle.execute(sql`
    SELECT count(*)::int AS total
    FROM artifacts a
    WHERE a.search_tsv @@ ${tsquery} AND ${whereClause}
  `);

  const hits = (hitsRows as unknown as ArtifactHit[]).map((r) => ({
    ...r,
    rank: Number(r.rank),
  }));
  const total = Number((countRows as unknown as Array<{ total: number }>)[0]?.total ?? 0);
  return { hits, total };
}

// ---------------------------------------------------------------------------
// Thread item ILIKE query
// ---------------------------------------------------------------------------

interface ThreadItemHit {
  id: string;
  content: string | null;
  title: string | null;
  created_at: Date;
}

async function searchThreadItems(
  db: DbInstance,
  input: SearchInput,
  cap: number,
): Promise<{ hits: ThreadItemHit[]; total: number }> {
  const pattern = ilikePattern(input.query);
  const conditions: ReturnType<typeof sql>[] = [
    sql`ti.company_id = ${input.companyId}`,
    sql`ti.content ILIKE ${pattern}`,
  ];
  if (input.dateFrom) conditions.push(sql`ti.created_at >= ${input.dateFrom}`);
  if (input.dateTo) conditions.push(sql`ti.created_at <= ${input.dateTo}`);
  const whereClause = sql.join(conditions, sql` AND `);

  const hitsRows = await db.drizzle.execute(sql`
    SELECT
      ti.id,
      ti.content,
      COALESCE(pt.title, t.title, 'Thread item') AS title,
      ti.created_at
    FROM task_thread_items ti
    LEFT JOIN project_threads pt ON ti.project_thread_id = pt.id
    LEFT JOIN tasks t ON ti.task_id = t.id
    WHERE ${whereClause}
    ORDER BY ti.created_at DESC
    LIMIT ${cap}
  `);

  const countRows = await db.drizzle.execute(sql`
    SELECT count(*)::int AS total
    FROM task_thread_items ti
    WHERE ${whereClause}
  `);

  const hits = hitsRows as unknown as ThreadItemHit[];
  const total = Number((countRows as unknown as Array<{ total: number }>)[0]?.total ?? 0);
  return { hits, total };
}

// ---------------------------------------------------------------------------
// Task ILIKE query
// ---------------------------------------------------------------------------

interface TaskHit {
  id: string;
  title: string;
  description: string | null;
  status: string;
  updated_at: Date;
}

async function searchTasks(
  db: DbInstance,
  input: SearchInput,
  cap: number,
): Promise<{ hits: TaskHit[]; total: number }> {
  const pattern = ilikePattern(input.query);
  const conditions: ReturnType<typeof sql>[] = [
    sql`company_id = ${input.companyId}`,
    sql`(title ILIKE ${pattern} OR description ILIKE ${pattern})`,
  ];
  if (input.dateFrom) conditions.push(sql`updated_at >= ${input.dateFrom}`);
  if (input.dateTo) conditions.push(sql`updated_at <= ${input.dateTo}`);
  const whereClause = sql.join(conditions, sql` AND `);

  const hitsRows = await db.drizzle.execute(sql`
    SELECT id, title, description, status, updated_at
    FROM tasks
    WHERE ${whereClause}
    ORDER BY updated_at DESC
    LIMIT ${cap}
  `);

  const countRows = await db.drizzle.execute(sql`
    SELECT count(*)::int AS total FROM tasks WHERE ${whereClause}
  `);

  const hits = hitsRows as unknown as TaskHit[];
  const total = Number((countRows as unknown as Array<{ total: number }>)[0]?.total ?? 0);
  return { hits, total };
}

// ---------------------------------------------------------------------------
// Public search entry point
// ---------------------------------------------------------------------------

/**
 * Execute a company-scoped cross-artifact search. Runs the three source
 * queries in parallel, converts each hit to a `SearchResult`, merges them
 * sorted by rank DESC, and applies limit/offset pagination on the merged
 * list. Returns `{ results, total, query }`.
 *
 * `total` is the sum of match counts across all three sources (before
 * pagination), so it reflects the full result set size.
 */
export async function search(
  db: DbInstance,
  input: SearchInput,
): Promise<{ results: SearchResult[]; total: number; query: string }> {
  // Cap each source at limit + offset so the merged list has enough rows
  // to fill the requested page after sorting + slicing.
  const cap = (input.limit + input.offset) * SOURCE_CAP_MULTIPLIER + 5;

  const [artifactResult, threadResult, taskResult] = await Promise.all([
    searchArtifacts(db, input, cap),
    searchThreadItems(db, input, cap),
    searchTasks(db, input, cap),
  ]);

  // Convert artifact hits → SearchResult.
  const artifactResults: SearchResult[] = artifactResult.hits.map((h) => ({
    entityType: 'artifact' as SearchResultEntityType,
    entityId: h.id,
    title: h.title,
    snippet: h.snippet ?? buildSnippet(h.title, input.query),
    rank: h.rank,
    artifactType: h.type,
    projectId: h.project_id,
    folderId: h.folder_id,
  }));

  // Convert thread item hits → SearchResult.
  const threadResults: SearchResult[] = threadResult.hits.map((h) => ({
    entityType: 'thread_item' as SearchResultEntityType,
    entityId: h.id,
    title: h.title ?? 'Thread item',
    snippet: buildSnippet(h.content ?? '', input.query),
    rank: recencyRank(h.created_at, 0.1),
  }));

  // Convert task hits → SearchResult.
  const taskResults: SearchResult[] = taskResult.hits.map((h) => ({
    entityType: 'task' as SearchResultEntityType,
    entityId: h.id,
    title: h.title,
    snippet: buildSnippet(h.description ?? h.title, input.query),
    rank: recencyRank(h.updated_at, 0.08),
    status: h.status,
  }));

  // Merge + sort by rank DESC (tie-break: entityId for determinism).
  const merged = [...artifactResults, ...threadResults, ...taskResults]
    .sort((a, b) => b.rank - a.rank || (a.entityId < b.entityId ? -1 : 1));

  const total = artifactResult.total + threadResult.total + taskResult.total;

  // Apply pagination on the merged list.
  const paged = merged.slice(input.offset, input.offset + input.limit);

  return { results: paged, total, query: input.query };
}
