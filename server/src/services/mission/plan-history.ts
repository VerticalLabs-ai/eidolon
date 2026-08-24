import { and, asc, eq, gt, or } from 'drizzle-orm';
import { AppError } from '../../middleware/error-handler.js';
import { decryptReason } from './reason-security.js';
import type { DbInstance } from '../../types.js';

/**
 * Scoped plan revision history: bounded, restart-stable reads of the
 * immutable plan revision and approval-binding ledgers (VAL-PLAN-111).
 *
 * The declared `GET .../plan/revisions?limit=&cursor=` route returns at
 * most 50 revisions in `(revision ASC, id ASC)` order with opaque keyset
 * cursors. Each entry includes immutable content/hash, parent relation,
 * gate outcome, current-authorization flag, actor/time, and feedback
 * access by role.
 *
 * Role-based read contract (VAL-PLAN-111, VAL-PLAN-129):
 * - Owner/admin/member with project content access (`content.create`)
 *   receive redacted-safe exact feedback (decrypted from the encrypted
 *   `feedback` column).
 * - Viewers (`company.view` only) receive decision metadata only —
 *   feedback is omitted (null).
 * - Restricted/rejected command payloads remain encrypted; this endpoint
 *   never exposes raw command payloads, only the revision-level feedback.
 *
 * Cross-scope IDs return 404 and never reveal existence. Ordering survives
 * restart because it is derived from persisted `revision` and `id` columns.
 * Opaque cursors are base64url-encoded JSON anchors that carry no
 * tenant-sensitive material.
 */

/** Maximum plan revisions returned per page (VAL-PLAN-111). */
export const MAX_PLAN_REVISIONS_PER_PAGE = 50;

/** A plan revision history entry. */
export interface PlanRevisionHistoryEntry {
  id: string;
  revision: number;
  status: string;
  contentHash: string;
  parentRevisionId: string | null;
  /** Gate outcome for the linked approval binding, or null if no binding. */
  gateOutcome: string | null;
  /** Whether this revision's binding is the current execution authorization. */
  isCurrentAuthorization: boolean;
  decidedByUserId: string | null;
  decidedAt: string | null;
  createdAt: string;
  /**
   * Redacted-safe exact feedback (decrypted), or null when the caller
   * lacks content access (viewers) or when no feedback was recorded.
   * (VAL-PLAN-111, VAL-PLAN-129).
   */
  feedback: string | null;
}

export interface PlanRevisionHistoryResult {
  revisions: PlanRevisionHistoryEntry[];
  nextCursor: string | null;
}

export interface PlanRevisionHistoryInput {
  companyId: string;
  projectId: string;
  runId: string;
  limit: number;
  cursor?: string;
  /**
   * When true, exact feedback is included (decrypted). When false
   * (viewers), feedback is omitted (null).
   */
  includeFeedback: boolean;
}

/**
 * Decode an opaque keyset cursor for plan revision history. The cursor is
 * base64url-encoded JSON `{ r: revision, i: id }` anchoring the last row
 * of the previous page. Returns null for an absent cursor. Throws
 * AppError(400) for malformed input.
 */
export function decodePlanRevisionCursor(
  cursor: string | undefined,
): { revision: number; id: string } | null {
  if (cursor === undefined || cursor === null || cursor === '') {
    return null;
  }
  let json: string;
  try {
    const normalized = cursor.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    json = Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid pagination cursor');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid pagination cursor');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { r?: unknown }).r !== 'number' ||
    typeof (parsed as { i?: unknown }).i !== 'string'
  ) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid pagination cursor');
  }
  const obj = parsed as { r: number; i: string };
  return { revision: obj.r, id: obj.i };
}

/** Encode a keyset cursor from the last row of a page. */
export function encodePlanRevisionCursor(revision: number, id: string): string {
  const json = JSON.stringify({ r: revision, i: id });
  return Buffer.from(json, 'utf8').toString('base64url');
}

export class MissionPlanHistoryService {
  constructor(private db: DbInstance) {}

  /**
   * List plan revision history for a run, scoped to the given
   * company/project. Returns at most `limit` entries ordered by
   * `(revision ASC, id ASC)` with an opaque keyset cursor for the next
   * page. Throws 404 RUN_NOT_FOUND for an absent or cross-scope run id.
   *
   * Feedback access is role-gated: when `includeFeedback` is true, the
   * encrypted `feedback` column is decrypted and returned as redacted-safe
   * exact text. When false (viewers), feedback is null.
   */
  async listRevisions(input: PlanRevisionHistoryInput): Promise<PlanRevisionHistoryResult> {
    const { companyId, projectId, runId, limit, cursor, includeFeedback } = input;
    const schema = this.db.schema;

    // 1. Verify the run exists in scope (non-enumerating 404).
    const [run] = await this.db.drizzle
      .select({ id: schema.missionRuns.id })
      .from(schema.missionRuns)
      .where(
        and(
          eq(schema.missionRuns.id, runId),
          eq(schema.missionRuns.companyId, companyId),
          eq(schema.missionRuns.projectId, projectId),
        ),
      )
      .limit(1);
    if (!run) {
      throw new AppError(404, 'RUN_NOT_FOUND', 'Mission run not found');
    }

    // 2. Build the keyset query for revisions.
    const anchor = decodePlanRevisionCursor(cursor);
    const fetchLimit = limit + 1;

    const conditions = [
      eq(schema.runPlanRevisions.companyId, companyId),
      eq(schema.runPlanRevisions.runId, runId),
    ];
    if (anchor) {
      // Keyset: rows strictly after the anchor in (revision ASC, id ASC).
      const cursorCondition = or(
        gt(schema.runPlanRevisions.revision, anchor.revision),
        and(
          eq(schema.runPlanRevisions.revision, anchor.revision),
          gt(schema.runPlanRevisions.id, anchor.id),
        ),
      );
      conditions.push(cursorCondition!);
    }

    const revisionRows = await this.db.drizzle
      .select()
      .from(schema.runPlanRevisions)
      .where(and(...conditions))
      .orderBy(asc(schema.runPlanRevisions.revision), asc(schema.runPlanRevisions.id))
      .limit(fetchLimit);

    const hasMore = revisionRows.length > limit;
    const page = hasMore ? revisionRows.slice(0, limit) : revisionRows;

    // 3. Fetch approval bindings for the revisions in this page to
    //    populate gate outcome and current-authorization flag.
    const revisionIds = page.map((r) => r.id);
    const bindingsByRevision = new Map<
      string,
      { decision: string | null; isCurrentAuthorization: boolean }
    >();
    if (revisionIds.length > 0) {
      const bindingRows = await this.db.drizzle
        .select({
          planRevisionId: schema.runPlanApprovalBindings.planRevisionId,
          decision: schema.runPlanApprovalBindings.decision,
          isCurrentAuthorization: schema.runPlanApprovalBindings.isCurrentAuthorization,
        })
        .from(schema.runPlanApprovalBindings)
        .where(
          and(
            eq(schema.runPlanApprovalBindings.companyId, companyId),
            eq(schema.runPlanApprovalBindings.runId, runId),
            gt(schema.runPlanApprovalBindings.planRevisionId, ''),
          ),
        );
      for (const b of bindingRows) {
        // Only include bindings for revisions in this page.
        if (revisionIds.includes(b.planRevisionId)) {
          bindingsByRevision.set(b.planRevisionId, {
            decision: b.decision,
            isCurrentAuthorization: b.isCurrentAuthorization,
          });
        }
      }
    }

    // 4. Build history entries with role-gated feedback.
    const revisions: PlanRevisionHistoryEntry[] = page.map((r) => {
      const binding = bindingsByRevision.get(r.id);
      let feedback: string | null = null;
      if (includeFeedback && r.feedback) {
        try {
          feedback = decryptReason(r.feedback);
        } catch {
          // Decryption failure: treat as inaccessible rather than leaking
          // raw ciphertext. This is fail-safe for the role gate.
          feedback = null;
        }
      }
      return {
        id: r.id,
        revision: r.revision,
        status: r.status,
        contentHash: r.contentHash,
        parentRevisionId: r.parentRevisionId,
        gateOutcome: binding?.decision ?? null,
        isCurrentAuthorization: binding?.isCurrentAuthorization ?? false,
        decidedByUserId: r.decidedByUserId,
        decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
        feedback,
      };
    });

    let nextCursor: string | null = null;
    if (hasMore && page.length > 0) {
      const last = page[page.length - 1];
      nextCursor = encodePlanRevisionCursor(last.revision, last.id);
    }

    return { revisions, nextCursor };
  }
}
