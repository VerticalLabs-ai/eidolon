// ---------------------------------------------------------------------------
// Smart artifact linking service (M3 — Artifact Intelligence & Discovery)
// ---------------------------------------------------------------------------
//
// `getLinks(companyId, artifactId)` returns three arrays:
//
//   linkedFrom — thread items that @-mention this artifact, reverse-looked-up
//                via the GIN index on `task_thread_items.mentions` using the
//                JSONB containment operator `@>`. Each entry carries the
//                parent thread title, a content snippet, the author, and the
//                creation date. Limited to 20, ordered by createdAt DESC.
//
//   linkedTo   — artifacts mentioned alongside this artifact in the same
//                thread items (deduplicated, excluding self). These are the
//                artifacts this artifact "links to" via shared thread context.
//
//   related   — artifacts scored by shared signals:
//                  same project (+3), same folder (+2),
//                  shared agent edits (+2), co-mentioned (+1).
//                Sorted by score descending, top 10, excluding self and
//                archived/deleted.
//
// All queries are company-scoped. The route layer verifies the artifact
// exists (404) and the caller has view access before calling this service.
// ---------------------------------------------------------------------------

import { sql, eq, and, inArray } from 'drizzle-orm';
import type {
  LinkRef,
  LinkedToRef,
  RelatedArtifact,
  LinksResponse,
} from '@eidolon/shared';
import type { DbInstance } from '../types.js';
import { getCompanyMembers } from '../auth.js';

/** Maximum linkedFrom entries returned (most recent first). */
const LINKED_FROM_LIMIT = 20;

/** Maximum related artifacts returned (highest score first). */
const RELATED_LIMIT = 10;

/** Maximum snippet length for linkedFrom content excerpts. */
const SNIPPET_MAX = 200;

interface Mention {
  entityType: string;
  entityId: string;
  label: string;
  artifactType?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a truncated content snippet from a thread item's `content` text.
 * Collapses whitespace and truncates to SNIPPET_MAX chars with an ellipsis.
 */
function buildSnippet(content: string | null): string {
  if (!content) return '';
  const clean = content.replace(/\s+/g, ' ').trim();
  if (clean.length <= SNIPPET_MAX) return clean;
  return `${clean.slice(0, SNIPPET_MAX - 3)}...`;
}

/**
 * Extract artifact mention entityIds (excluding the target artifact itself)
 * from a thread item's mentions array. Returns a Set of artifact IDs.
 */
function extractOtherArtifactMentions(
  mentions: unknown,
  targetArtifactId: string,
): Set<string> {
  const result = new Set<string>();
  if (!Array.isArray(mentions)) return result;
  for (const m of mentions as Mention[]) {
    if (
      m.entityType === 'artifact' &&
      m.entityId &&
      m.entityId !== targetArtifactId
    ) {
      result.add(m.entityId);
    }
  }
  return result;
}

/**
 * Extract the artifactType for the target artifact from a thread item's
 * mentions array (the mention's `artifactType` field, if present).
 */
function extractArtifactType(
  mentions: unknown,
  targetArtifactId: string,
): string | undefined {
  if (!Array.isArray(mentions)) return undefined;
  for (const m of mentions as Mention[]) {
    if (m.entityType === 'artifact' && m.entityId === targetArtifactId) {
      return m.artifactType;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// linkedFrom: reverse-lookup thread items mentioning this artifact
// ---------------------------------------------------------------------------

interface LinkedFromRow {
  id: string;
  content: string | null;
  author_user_id: string | null;
  author_agent_id: string | null;
  agent_name: string | null;
  created_at: Date;
  mentions: unknown;
  thread_title: string | null;
  task_id: string | null;
  project_id: string | null;
}

/**
 * Resolve human-readable display names for user author IDs. Uses the same
 * pattern as team-service: Clerk company members first, then test_users
 * (local_trusted), then fallback to the raw userId.
 */
async function resolveUserDisplayNames(
  db: DbInstance,
  companyId: string,
  userIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (userIds.length === 0) return names;

  // 1. Clerk company members (production + the dev user in local_trusted).
  try {
    const members = await getCompanyMembers(companyId);
    for (const m of members) {
      names.set(m.id, m.name || m.id);
    }
  } catch {
    // getCompanyMembers can throw in local_trusted without Clerk; fall through.
  }

  // 2. test_users table (local_trusted additional test users).
  const unresolved = userIds.filter((id) => !names.has(id));
  if (unresolved.length > 0) {
    const { testUsers } = db.schema;
    const rows = await db.drizzle
      .select({ id: testUsers.id, name: testUsers.name })
      .from(testUsers)
      .where(and(eq(testUsers.companyId, companyId), inArray(testUsers.id, unresolved)));
    for (const r of rows) {
      names.set(r.id, r.name);
    }
  }

  // 3. Fallback to the raw userId for anything still unresolved.
  for (const id of userIds) {
    if (!names.has(id)) names.set(id, id);
  }

  return names;
}

async function getLinkedFrom(
  db: DbInstance,
  companyId: string,
  artifactId: string,
): Promise<{ linkedFrom: LinkRef[]; coMentionedIds: Set<string> }> {
  // JSONB containment filter: mentions @> '[{"entityType":"artifact","entityId":"..."}]'
  // The GIN index on `mentions` accelerates this reverse-lookup.
  const mentionFilter = JSON.stringify([
    { entityType: 'artifact', entityId: artifactId },
  ]);

  const rows = (await db.drizzle.execute(sql`
    SELECT
      ti.id,
      ti.content,
      ti.author_user_id,
      ti.author_agent_id,
      ag.name AS agent_name,
      ti.created_at,
      ti.mentions,
      ti.task_id,
      pt.project_id,
      COALESCE(pt.title, t.title, 'Thread item') AS thread_title
    FROM task_thread_items ti
    LEFT JOIN project_threads pt
      ON ti.project_thread_id = pt.id AND pt.company_id = ti.company_id
    LEFT JOIN tasks t
      ON ti.task_id = t.id AND t.company_id = ti.company_id
    LEFT JOIN agents ag ON ti.author_agent_id = ag.id
    WHERE ti.company_id = ${companyId}
      AND ti.mentions @> ${mentionFilter}::jsonb
    ORDER BY ti.created_at DESC
    LIMIT ${LINKED_FROM_LIMIT}
  `)) as unknown as LinkedFromRow[];

  // Resolve user display names for all user-authored thread items in a
  // single batch (avoids N+1 queries).
  const userIds = rows
    .map((r) => r.author_user_id)
    .filter((id): id is string => id !== null);
  const userNames = await resolveUserDisplayNames(db, companyId, userIds);

  const coMentionedIds = new Set<string>();

  const linkedFrom: LinkRef[] = rows.map((r) => {
    // Extract co-mentioned artifact IDs from this thread item's mentions.
    const others = extractOtherArtifactMentions(r.mentions, artifactId);
    for (const id of others) coMentionedIds.add(id);

    // Extract the artifactType for the target artifact from the mention.
    const artifactType = extractArtifactType(r.mentions, artifactId);

    // Build author object: only set userId or agentId, not both.
    // In local_trusted AUTH_MODE the thread-items route always sets
    // authorUserId (the dev user is always present) AND authorAgentId when
    // an agent authored the item. The contract (VAL-LINK-005) requires only
    // one of userId/agentId: agentId wins when present (agent-authored),
    // otherwise userId (user-authored).
    const author: LinkRef['author'] = {};
    if (r.author_agent_id) {
      author.agentId = r.author_agent_id;
    } else if (r.author_user_id) {
      author.userId = r.author_user_id;
    }

    // Resolve human-readable author name.
    let authorName: string | undefined;
    if (r.author_agent_id && r.agent_name) {
      authorName = r.agent_name;
    } else if (r.author_user_id) {
      authorName = userNames.get(r.author_user_id);
    }

    return {
      threadItemId: r.id,
      threadTitle: r.thread_title ?? 'Thread item',
      contentSnippet: buildSnippet(r.content),
      author: Object.keys(author).length > 0 ? author : undefined,
      authorName,
      createdAt: new Date(r.created_at).toISOString(),
      artifactType,
      taskId: r.task_id,
      projectId: r.project_id,
    };
  });

  return { linkedFrom, coMentionedIds };
}

// ---------------------------------------------------------------------------
// linkedTo: artifacts mentioned alongside this artifact in the same threads
// ---------------------------------------------------------------------------

async function getLinkedTo(
  db: DbInstance,
  companyId: string,
  coMentionedIds: Set<string>,
): Promise<LinkedToRef[]> {
  if (coMentionedIds.size === 0) return [];

  const ids = Array.from(coMentionedIds);
  const a = db.schema.artifacts;
  const rows = await db.drizzle
    .select({
      id: a.id,
      title: a.title,
      type: a.type,
      projectId: a.projectId,
      folderId: a.folderId,
    })
    .from(a)
    .where(
      and(
        eq(a.companyId, companyId),
        eq(a.status, 'active'),
        inArray(a.id, ids),
      ),
    );

  return rows.map((r) => ({
    artifactId: r.id,
    title: r.title,
    type: r.type as LinkedToRef['type'],
    projectId: r.projectId,
    folderId: r.folderId,
  }));
}

// ---------------------------------------------------------------------------
// related: artifacts scored by shared signals
// ---------------------------------------------------------------------------

async function getRelated(
  db: DbInstance,
  companyId: string,
  artifactId: string,
  target: {
    projectId: string | null;
    folderId: string | null;
    createdByAgentId: string | null;
    lastEditedByAgentId: string | null;
  },
  coMentionedIds: Set<string>,
): Promise<RelatedArtifact[]> {
  // Fetch all active artifacts in the company (excluding self) with the
  // columns needed for scoring. For typical company sizes this is a small
  // result set; the scoring is done in JS for clarity and maintainability.
  const a = db.schema.artifacts;
  const rows = await db.drizzle
    .select({
      id: a.id,
      title: a.title,
      type: a.type,
      projectId: a.projectId,
      folderId: a.folderId,
      createdByAgentId: a.createdByAgentId,
      lastEditedByAgentId: a.lastEditedByAgentId,
    })
    .from(a)
    .where(
      and(
        eq(a.companyId, companyId),
        eq(a.status, 'active'),
        sql`${a.id} != ${artifactId}`,
      ),
    );

  const related: RelatedArtifact[] = [];

  for (const r of rows) {
    const reasons: string[] = [];
    let score = 0;

    // Same project: +3
    if (
      target.projectId !== null &&
      r.projectId !== null &&
      r.projectId === target.projectId
    ) {
      score += 3;
      reasons.push('Same project');
    }

    // Same folder: +2
    if (
      target.folderId !== null &&
      r.folderId !== null &&
      r.folderId === target.folderId
    ) {
      score += 2;
      reasons.push('Shared folder');
    }

    // Shared agent edits: +2 (same createdByAgentId or lastEditedByAgentId)
    const sharedAgent =
      (target.createdByAgentId !== null &&
        r.createdByAgentId !== null &&
        r.createdByAgentId === target.createdByAgentId) ||
      (target.lastEditedByAgentId !== null &&
        r.lastEditedByAgentId !== null &&
        r.lastEditedByAgentId === target.lastEditedByAgentId);
    if (sharedAgent) {
      score += 2;
      reasons.push('Agent edited');
    }

    // Co-mentioned: +1
    if (coMentionedIds.has(r.id)) {
      score += 1;
      reasons.push('Co-mentioned');
    }

    if (score > 0) {
      related.push({
        artifactId: r.id,
        title: r.title,
        type: r.type as RelatedArtifact['type'],
        score,
        reasons,
        projectId: r.projectId,
        folderId: r.folderId,
      });
    }
  }

  // Sort by score descending, tie-break by title for determinism.
  related.sort((a, b) => b.score - a.score || (a.title < b.title ? -1 : 1));

  return related.slice(0, RELATED_LIMIT);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Compute the full links response for an artifact. The caller (route layer)
 * is responsible for verifying the artifact exists (404) and the caller has
 * view access before calling this function.
 *
 * @param db         Database instance
 * @param companyId  Company scope (enforced on every query)
 * @param artifactId Target artifact id
 * @param target     The target artifact's scoring attributes (projectId,
 *                   folderId, createdByAgentId, lastEditedByAgentId). Passed
 *                   by the route to avoid a redundant fetch.
 */
export async function getLinks(
  db: DbInstance,
  companyId: string,
  artifactId: string,
  target: {
    projectId: string | null;
    folderId: string | null;
    createdByAgentId: string | null;
    lastEditedByAgentId: string | null;
  },
): Promise<LinksResponse> {
  // linkedFrom + co-mentioned artifact IDs (single GIN-indexed query).
  const { linkedFrom, coMentionedIds } = await getLinkedFrom(
    db,
    companyId,
    artifactId,
  );

  // linkedTo + related can run in parallel (both depend on coMentionedIds
  // but not on each other).
  const [linkedTo, related] = await Promise.all([
    getLinkedTo(db, companyId, coMentionedIds),
    getRelated(db, companyId, artifactId, target, coMentionedIds),
  ]);

  return { linkedFrom, linkedTo, related };
}
