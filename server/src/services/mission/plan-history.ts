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

/**
 * The complete governance gate outcome enum (VAL-PLAN-121).
 *
 * A plan revision's content/identity is immutable; its one governance gate
 * has exactly one of these outcomes. The outcome is *derived* from the
 * immutable revision status, the approval binding's decision, and the run's
 * terminal state — it is not a stored enum. This keeps plan content, gate
 * outcome, and execution authorization orthogonal.
 *
 *  - `open`: the gate is still open (revision is `proposed`, run is
 *    nonterminal and in `awaiting_approval`).
 *  - `approved`: a human owner/admin approved the exact revision
 *    (binding.decision = 'approved').
 *  - `rejected`: a human owner/admin rejected the exact revision
 *    (binding.decision = 'rejected').
 *  - `superseded_without_decision`: a member revision request superseded
 *    the proposal without a rejection decision (revision.status =
 *    'superseded').
 *  - `cancelled_without_decision`: the run was cancelled while the
 *    proposal was still open (revision.status = 'proposed', run.status =
 *    'cancelled', no decision recorded).
 *  - `expired_without_decision`: the root deadline expired while the
 *    proposal was still open (revision.status = 'proposed', run.status =
 *    'failed', failureCode = 'TIME_LIMIT', no decision recorded).
 */
export type GateOutcome =
  | 'open'
  | 'approved'
  | 'rejected'
  | 'superseded_without_decision'
  | 'cancelled_without_decision'
  | 'expired_without_decision';

/**
 * Derive the governance gate outcome for a revision from immutable records
 * (VAL-PLAN-121). The outcome is computed from the revision status, the
 * binding's decision, and the run's terminal state.
 */
function deriveGateOutcome(
  revisionStatus: string,
  bindingDecision: string | null,
  runStatus: string | null,
  runFailureCode: string | null,
): GateOutcome | null {
  // If there's a binding with an explicit decision, that wins.
  if (bindingDecision === 'approved') {
    return 'approved';
  }
  if (bindingDecision === 'rejected') {
    return 'rejected';
  }

  // No binding or no decision — derive from revision status and run state.
  if (revisionStatus === 'superseded') {
    return 'superseded_without_decision';
  }

  if (revisionStatus === 'proposed') {
    // The gate was open when the run terminalized or is still open.
    if (runStatus === 'cancelled') {
      return 'cancelled_without_decision';
    }
    if (runStatus === 'failed' && runFailureCode === 'TIME_LIMIT') {
      return 'expired_without_decision';
    }
    // Still open (nonterminal) or terminalized by other means.
    return 'open';
  }

  // Revision was approved/rejected but no binding decision was recorded
  // (shouldn't normally happen, but handle gracefully).
  if (revisionStatus === 'approved') {
    return 'approved';
  }
  if (revisionStatus === 'rejected') {
    return 'rejected';
  }

  return null;
}

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
  gateOutcome: GateOutcome | null;
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

    // 1. Verify the run exists in scope (non-enumerating 404). Also load
    //    the run's status and failure code so the gate outcome can be
    //    derived for cancelled/expired proposals (VAL-PLAN-121).
    const [run] = await this.db.drizzle
      .select({
        id: schema.missionRuns.id,
        status: schema.missionRuns.status,
        failureCode: schema.missionRuns.failureCode,
      })
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

    // 4. Build history entries with role-gated feedback and derived gate
    //    outcome (VAL-PLAN-121).
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
      const gateOutcome = deriveGateOutcome(
        r.status,
        binding?.decision ?? null,
        run.status,
        run.failureCode,
      );
      return {
        id: r.id,
        revision: r.revision,
        status: r.status,
        contentHash: r.contentHash,
        parentRevisionId: r.parentRevisionId,
        gateOutcome,
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
