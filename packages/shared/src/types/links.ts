import { z } from 'zod';
import { ArtifactTypeSchema } from './artifact.js';

// ---------------------------------------------------------------------------
// Smart artifact linking types (M3 — Artifact Intelligence & Discovery)
// ---------------------------------------------------------------------------
//
// The links endpoint returns three arrays:
//
//   • linkedFrom — thread items that @-mention this artifact (reverse-lookup
//                  via GIN index on task_thread_items.mentions). Each entry
//                  carries the parent thread title, a content snippet, the
//                  author, and the creation date.
//
//   • linkedTo   — artifacts mentioned alongside this artifact in the same
//                  thread items (deduplicated). These are the artifacts this
//                  artifact "links to" via shared thread context.
//
//   • related   — artifacts scored by shared signals: same project (+3),
//                  same folder (+2), shared agent edits (+2), co-mentioned
//                  (+1). Sorted by score descending, top 10, excluding self
//                  and archived/deleted.
//
// All link endpoints are company-scoped (requireAuth + requireOrgMember).
// ---------------------------------------------------------------------------

/**
 * A thread item that @-mentions the target artifact. `threadTitle` is the
 * parent thread's title (project thread or task thread), not the thread
 * item's own content. `contentSnippet` is a truncated excerpt of the
 * thread item's `content` text. `author` reports the user or agent that
 * created the thread item. `artifactType` is carried from the mention
 * metadata when available.
 */
export const LinkRefSchema = z.object({
  threadItemId: z.string().min(1),
  threadTitle: z.string(),
  contentSnippet: z.string(),
  author: z
    .object({
      userId: z.string().optional(),
      agentId: z.string().optional(),
    })
    .optional(),
  createdAt: z.string(),
  artifactType: z.string().optional(),
});
export type LinkRef = z.infer<typeof LinkRefSchema>;

/**
 * An artifact mentioned alongside the target artifact in the same thread
 * items. Deduplicated by artifact id. Carries enough metadata for the UI to
 * render and navigate to the artifact.
 */
export const LinkedToRefSchema = z.object({
  artifactId: z.string().min(1),
  title: z.string(),
  type: ArtifactTypeSchema,
  projectId: z.string().nullable().optional(),
  folderId: z.string().nullable().optional(),
});
export type LinkedToRef = z.infer<typeof LinkedToRefSchema>;

/**
 * A related artifact scored by shared signals. `score` is the sum of
 * applicable signal weights (project +3, folder +2, agent +2, co-mention
 * +1). `reasons` lists human-readable badges for each contributing signal
 * (e.g. "Same project", "Shared folder", "Agent edited", "Co-mentioned").
 */
export const RelatedArtifactSchema = z.object({
  artifactId: z.string().min(1),
  title: z.string(),
  type: ArtifactTypeSchema,
  score: z.number().int().nonnegative(),
  reasons: z.array(z.string()),
  projectId: z.string().nullable().optional(),
  folderId: z.string().nullable().optional(),
});
export type RelatedArtifact = z.infer<typeof RelatedArtifactSchema>;

/** Top-level response envelope for GET /api/companies/:companyId/artifacts/:id/links. */
export const LinksResponseSchema = z.object({
  linkedFrom: z.array(LinkRefSchema),
  linkedTo: z.array(LinkedToRefSchema),
  related: z.array(RelatedArtifactSchema),
});
export type LinksResponse = z.infer<typeof LinksResponseSchema>;
