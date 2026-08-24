import { and, eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { AppError } from '../../middleware/error-handler.js';
import type { DbInstance } from '../../types.js';
import { BudgetService } from './budget.js';

/**
 * Mission Synthesis module — require-all/best-effort outcomes and
 * exactly-once synthesis.
 *
 * (VAL-SUB-051, 052, 053, 054, 064, 065, 066, 111)
 *
 * When a composite (parent) run's direct children have all reached terminal
 * states, the synthesis service:
 *
 *  1. **Waits for children (VAL-SUB-064):** The parent must not emit
 *     `synthesis.started` until every required child is terminal and every
 *     best-effort sibling allowed to continue has settled.
 *
 *  2. **Applies the snapshotted partial-result policy (VAL-SUB-054):**
 *     The parent's `partial_result_policy` is read from the immutable run
 *     row, not from live mode/agent/company configuration.
 *
 *  3. **Require-all fails on required-child failure (VAL-SUB-051):** Under
 *     `require_all`, one unrecoverable required-child failure must fail the
 *     parent rather than synthesize a success.
 *
 *  4. **Best-effort preserves siblings (VAL-SUB-052):** Under `best_effort`,
 *     an unrecoverable child failure does not cancel healthy independent
 *     siblings; they are allowed to finish (enforced by the subtree
 *     cancellation service, which only cascades under `require_all`).
 *
 *  5. **Best-effort synthesis discloses gaps (VAL-SUB-053):** A best-effort
 *     synthesis must explicitly identify each failed, cancelled, or missing
 *     step and must not claim full success unless the approved completion
 *     criteria permit partial completion.
 *
 *  6. **Commits exactly once (VAL-SUB-065, 111):** Every composite uses a
 *     deterministic key `(runId, approvedPlanRevisionId, approvedContentHash,
 *     synthesisOrdinal)`. Concurrent settlement/recovery may commit exactly
 *     one ordered input manifest, synthesis result, cost settlement,
 *     completion event, and terminal outcome. The unique constraint on
 *     `run_synthesis_manifests` enforces this at the database level.
 *
 *  7. **Stable ordering (VAL-SUB-066, 111):** The synthesis manifest is
 *     ordered by direct-child ordinal/step key, not by nondeterministic
 *     child completion order. Each entry contains accepted result
 *     revision/hash or a typed unavailable reason.
 *
 *  8. **Direct-child consumption only (VAL-SUB-111):** A parent consumes
 *     only direct-child committed results, never bypassing a composite to
 *     read grandchildren.
 */

type Tx = Parameters<Parameters<DbInstance['drizzle']['transaction']>[0]>[0];

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export interface SynthesisDeps {
  clock?: () => Date;
}

/** A single entry in the ordered synthesis manifest. */
export interface ManifestEntry {
  stepKey: string;
  childOrdinal: number | null;
  childRunId: string;
  resultStatus: 'completed' | 'failed' | 'cancelled' | 'dependency_unavailable' | 'missing';
  /** Accepted result revision (for completed children). */
  resultRevision?: string | null;
  /** Accepted result hash (for completed children). */
  resultHash?: string | null;
  /** Typed unavailable reason (for non-completed children). */
  unavailableReason?: 'failed' | 'cancelled' | 'dependency_unavailable' | 'missing';
}

/** A gap disclosed in best-effort synthesis (VAL-SUB-053). */
export interface DisclosedGap {
  stepKey: string;
  childRunId: string;
  reason: 'failed' | 'cancelled' | 'dependency_unavailable' | 'missing';
}

export interface SynthesisResult {
  /** Whether synthesis was performed in this call. */
  synthesized: boolean;
  /** Why synthesis was not performed, if applicable. */
  skipReason: string | null;
  /** The run status after the operation. */
  status: string;
  /** New state version (ETag). */
  stateVersion: number;
  /** Latest event sequence after the operation. */
  lastEventSequence: number;
  /** The synthesis manifest, if created. */
  manifest: ManifestEntry[] | null;
  /** Disclosed gaps (best-effort with failures). */
  disclosedGaps: DisclosedGap[] | null;
  /** Whether the run was terminalized. */
  terminalized: boolean;
}

export class MissionSynthesisService {
  constructor(
    private db: DbInstance,
    private deps: SynthesisDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  /**
   * Attempt synthesis for a composite (parent) run. This is the main entry
   * point called by the run processor when a parent run is claimed and may
   * be ready for synthesis.
   *
   * Must be called inside a transaction that will be committed by the caller.
   * The method locks the run row with `FOR UPDATE` internally.
   *
   * Returns `{ synthesized: false, skipReason }` when synthesis cannot
   * proceed (children not all terminal, cancellation pending, already
   * synthesized, etc.).
   */
  async attemptSynthesis(
    tx: Tx,
    input: {
      companyId: string;
      projectId: string;
      runId: string;
      actorType?: 'user' | 'agent' | 'system';
      actorId?: string | null;
      traceId?: string | null;
      leaseToken?: string;
    },
  ): Promise<SynthesisResult> {
    const schema = this.db.schema;
    const now = this.now();
    const actorType = input.actorType ?? 'system';
    const actorId = input.actorId ?? null;
    const traceId = input.traceId ?? null;

    // Lock the parent run row.
    const [run] = await tx
      .select()
      .from(schema.missionRuns)
      .where(
        and(
          eq(schema.missionRuns.companyId, input.companyId),
          eq(schema.missionRuns.projectId, input.projectId),
          eq(schema.missionRuns.id, input.runId),
        ),
      )
      .for('update')
      .limit(1);

    if (!run) {
      throw new AppError(404, 'RUN_NOT_FOUND', 'Mission run not found');
    }

    // Already terminal — no-op (VAL-SUB-065, 111).
    if (TERMINAL_STATUSES.has(run.status)) {
      return {
        synthesized: false,
        skipReason: 'already_terminal',
        status: run.status,
        stateVersion: run.stateVersion,
        lastEventSequence: Number(run.lastEventSequence),
        manifest: null,
        disclosedGaps: null,
        terminalized: false,
      };
    }

    // Cancellation pending — cancellation owns terminalization (VAL-SUB-067).
    if (run.cancelRequestedAt !== null) {
      return {
        synthesized: false,
        skipReason: 'cancellation_pending',
        status: run.status,
        stateVersion: run.stateVersion,
        lastEventSequence: Number(run.lastEventSequence),
        manifest: null,
        disclosedGaps: null,
        terminalized: false,
      };
    }

    // Fence: verify the lease token matches (VAL-SUB-065, 111).
    if (input.leaseToken !== undefined && run.leaseToken !== input.leaseToken) {
      throw new AppError(409, 'LEASE_NOT_HELD', 'Lease is no longer held by this worker');
    }

    // Only composite runs (runs with children) synthesize. Root runs with
    // an approved plan that has child steps are composites.
    if (!run.approvedPlanRevisionId) {
      return {
        synthesized: false,
        skipReason: 'no_approved_plan',
        status: run.status,
        stateVersion: run.stateVersion,
        lastEventSequence: Number(run.lastEventSequence),
        manifest: null,
        disclosedGaps: null,
        terminalized: false,
      };
    }

    // Check if a synthesis manifest already exists (exactly-once).
    const [existingManifest] = await tx
      .select()
      .from(schema.runSynthesisManifests)
      .where(eq(schema.runSynthesisManifests.runId, run.id))
      .limit(1);

    if (existingManifest) {
      // Already synthesized — no-op (exactly-once, VAL-SUB-065, 111).
      return {
        synthesized: false,
        skipReason: 'already_synthesized',
        status: run.status,
        stateVersion: run.stateVersion,
        lastEventSequence: Number(run.lastEventSequence),
        manifest: existingManifest.manifest as unknown as ManifestEntry[],
        disclosedGaps: existingManifest.disclosedGaps as unknown as DisclosedGap[] | null,
        terminalized: false,
      };
    }

    // Read all direct children (parent_run_id = runId).
    const children = await tx.execute(sql`
      SELECT "id", "status", "child_ordinal", "terminal_at", "failure_category", "failure_code", "safe_error_message"
      FROM "mission_runs"
      WHERE "company_id" = ${input.companyId}
        AND "project_id" = ${input.projectId}
        AND "parent_run_id" = ${run.id}
      ORDER BY "child_ordinal" ASC NULLS LAST
    `);

    const childRows = children as unknown as Array<{
      id: string;
      status: string;
      child_ordinal: number | null;
      terminal_at: Date | null;
      failure_category: string | null;
      failure_code: string | null;
      safe_error_message: string | null;
    }>;

    if (childRows.length === 0) {
      // No children — not a composite run. No synthesis needed.
      return {
        synthesized: false,
        skipReason: 'no_children',
        status: run.status,
        stateVersion: run.stateVersion,
        lastEventSequence: Number(run.lastEventSequence),
        manifest: null,
        disclosedGaps: null,
        terminalized: false,
      };
    }

    // VAL-SUB-064: Wait for all direct children to be terminal.
    const nonTerminalChildren = childRows.filter((c) => !TERMINAL_STATUSES.has(c.status));
    if (nonTerminalChildren.length > 0) {
      return {
        synthesized: false,
        skipReason: 'children_not_terminal',
        status: run.status,
        stateVersion: run.stateVersion,
        lastEventSequence: Number(run.lastEventSequence),
        manifest: null,
        disclosedGaps: null,
        terminalized: false,
      };
    }

    // Read step assignments for direct children to get step keys and results.
    const assignments = await tx
      .select({
        id: schema.runStepAssignments.id,
        runId: schema.runStepAssignments.runId,
        stepKey: schema.runStepAssignments.stepKey,
        childOrdinal: schema.runStepAssignments.childOrdinal,
        assignmentStatus: schema.runStepAssignments.assignmentStatus,
        resultStatus: schema.runStepAssignments.resultStatus,
        resultRevision: schema.runStepAssignments.resultRevision,
        resultHash: schema.runStepAssignments.resultHash,
        failureCategory: schema.runStepAssignments.failureCategory,
        failureCode: schema.runStepAssignments.failureCode,
        safeErrorMessage: schema.runStepAssignments.safeErrorMessage,
      })
      .from(schema.runStepAssignments)
      .where(
        and(
          eq(schema.runStepAssignments.companyId, input.companyId),
          eq(schema.runStepAssignments.parentRunId, run.id),
        ),
      );

    // Build a map of childRunId → assignment for manifest construction.
    const assignmentMap = new Map<string, (typeof assignments)[number]>();
    for (const a of assignments) {
      assignmentMap.set(a.runId, a);
    }

    // Read the approved plan revision for step ordering and completion criteria.
    const [revision] = await tx
      .select()
      .from(schema.runPlanRevisions)
      .where(eq(schema.runPlanRevisions.id, run.approvedPlanRevisionId))
      .limit(1);

    if (!revision) {
      return {
        synthesized: false,
        skipReason: 'revision_not_found',
        status: run.status,
        stateVersion: run.stateVersion,
        lastEventSequence: Number(run.lastEventSequence),
        manifest: null,
        disclosedGaps: null,
        terminalized: false,
      };
    }

    // Build the ordered manifest (VAL-SUB-066, 111).
    // Ordered by direct-child ordinal/step key, not completion order.
    const manifest = this.buildOrderedManifest(childRows, assignmentMap);

    // Compute manifest hash for exactly-once enforcement.
    const manifestHash = this.computeManifestHash(manifest);

    // Read the parent's snapshotted partial-result policy (VAL-SUB-054).
    const parentPolicy = (run.partialResultPolicy ?? 'require_all') as
      'require_all' | 'best_effort';

    // Identify gaps (failed/cancelled/missing steps).
    const gaps = this.identifyGaps(manifest);

    // VAL-SUB-051: Under require_all, any required-child failure fails the parent.
    // VAL-SUB-053: Under best_effort, synthesis discloses gaps.
    const hasFailures = gaps.length > 0;
    const shouldFail = parentPolicy === 'require_all' && hasFailures;

    // Insert the synthesis manifest (exactly-once via unique constraint).
    // If a concurrent transaction already inserted, the unique constraint
    // violation causes this transaction to fail, which is the correct
    // exactly-once behavior (VAL-SUB-065, 111).
    const manifestId = crypto.randomUUID();
    const startedSeq = Number(run.lastEventSequence) + 1;

    // Transition to synthesizing and emit synthesis.started.
    await tx
      .update(schema.missionRuns)
      .set({
        status: 'synthesizing',
        stateVersion: run.stateVersion + 1,
        lastEventSequence: startedSeq,
        updatedAt: now,
      })
      .where(eq(schema.missionRuns.id, run.id));

    await tx.insert(schema.runEvents).values({
      companyId: input.companyId,
      projectId: input.projectId,
      runId: run.id,
      sequence: startedSeq,
      type: 'synthesis.started',
      schemaVersion: 1,
      payload: {
        manifestHash,
        parentPolicy,
        childCount: manifest.length,
      },
      actorType,
      actorId,
      traceId,
      occurredAt: now,
    });

    // Insert the synthesis manifest row.
    await tx.insert(schema.runSynthesisManifests).values({
      id: manifestId,
      companyId: input.companyId,
      projectId: input.projectId,
      runId: run.id,
      rootRunId: run.rootRunId,
      approvedPlanRevisionId: run.approvedPlanRevisionId,
      approvedContentHash: revision.contentHash,
      synthesisOrdinal: 1,
      manifest: manifest as unknown as Record<string, unknown>,
      manifestHash,
      disclosedGaps: (shouldFail ? [] : gaps) as unknown as Record<string, unknown>[],
      status: shouldFail ? 'failed' : 'completed',
      failureCategory: shouldFail ? 'child_failed' : null,
      failureCode: shouldFail ? 'REQUIRED_CHILD_FAILED' : null,
      safeErrorMessage: shouldFail
        ? `Synthesis failed: ${gaps.length} required child step(s) unavailable under require_all policy`
        : null,
      startedEventSequence: startedSeq,
      createdAt: now,
    });

    // Emit synthesis.completed or synthesis.failed event.
    const completedSeq = startedSeq + 1;

    if (shouldFail) {
      // VAL-SUB-051: Fail the parent under require_all.
      // VAL-CROSS-091: resultCompleteness stays null for a failed run
      // (missing mandatory criteria is failed, not partial).
      await tx
        .update(schema.missionRuns)
        .set({
          status: 'failed',
          terminalAt: now,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          availableAt: null,
          failureCategory: 'child_failed',
          failureCode: 'REQUIRED_CHILD_FAILED',
          safeErrorMessage: `Synthesis failed: ${gaps.length} required child step(s) unavailable`,
          stateVersion: run.stateVersion + 2,
          lastEventSequence: completedSeq,
          updatedAt: now,
        })
        .where(eq(schema.missionRuns.id, run.id));

      await tx.insert(schema.runEvents).values({
        companyId: input.companyId,
        projectId: input.projectId,
        runId: run.id,
        sequence: completedSeq,
        type: 'synthesis.completed',
        schemaVersion: 1,
        payload: {
          manifestHash,
          outcome: 'failed',
          parentPolicy,
          gaps: gaps,
          failureCode: 'REQUIRED_CHILD_FAILED',
        },
        actorType,
        actorId,
        traceId,
        occurredAt: now,
      });

      // Emit run.failed event.
      const failedSeq = completedSeq + 1;
      await tx
        .update(schema.missionRuns)
        .set({ lastEventSequence: failedSeq, updatedAt: now })
        .where(eq(schema.missionRuns.id, run.id));

      await tx.insert(schema.runEvents).values({
        companyId: input.companyId,
        projectId: input.projectId,
        runId: run.id,
        sequence: failedSeq,
        type: 'run.failed',
        schemaVersion: 1,
        payload: {
          failureCategory: 'child_failed',
          failureCode: 'REQUIRED_CHILD_FAILED',
        },
        actorType,
        actorId,
        traceId,
        occurredAt: now,
      });

      // Update manifest with completed event sequence.
      await tx
        .update(schema.runSynthesisManifests)
        .set({
          completedEventSequence: completedSeq,
          completedAt: now,
        })
        .where(eq(schema.runSynthesisManifests.id, manifestId));

      // Release residual budget.
      const budgetService = new BudgetService(this.db, { clock: () => now });
      await budgetService.release(tx, { companyId: input.companyId, runId: run.id });

      const budgetSeq = failedSeq + 1;
      await tx
        .update(schema.missionRuns)
        .set({ lastEventSequence: budgetSeq, updatedAt: now })
        .where(eq(schema.missionRuns.id, run.id));

      await tx.insert(schema.runEvents).values({
        companyId: input.companyId,
        projectId: input.projectId,
        runId: run.id,
        sequence: budgetSeq,
        type: 'budget.released',
        schemaVersion: 1,
        payload: {},
        actorType,
        actorId,
        traceId,
        occurredAt: now,
      });

      return {
        synthesized: true,
        skipReason: null,
        status: 'failed',
        stateVersion: run.stateVersion + 2,
        lastEventSequence: budgetSeq,
        manifest,
        disclosedGaps: gaps,
        terminalized: true,
      };
    }

    // Success path (all children completed, or best_effort with gaps disclosed).
    // VAL-CROSS-091: resultCompleteness is 'full' when all children completed,
    // 'partial' when best_effort synthesis completed with disclosed gaps.
    const completeness: 'full' | 'partial' = hasFailures ? 'partial' : 'full';

    await tx
      .update(schema.missionRuns)
      .set({
        status: 'completed',
        terminalAt: now,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        availableAt: null,
        resultCompleteness: completeness,
        stateVersion: run.stateVersion + 2,
        lastEventSequence: completedSeq,
        updatedAt: now,
      })
      .where(eq(schema.missionRuns.id, run.id));

    // VAL-SUB-053: Best-effort synthesis discloses gaps. The synthesis.completed
    // event payload includes the gaps array so consumers can identify failed/
    // cancelled/missing steps. Under best_effort with gaps, the outcome is
    // 'partial' rather than 'full_success'.
    const outcome = hasFailures ? 'partial' : 'full_success';

    await tx.insert(schema.runEvents).values({
      companyId: input.companyId,
      projectId: input.projectId,
      runId: run.id,
      sequence: completedSeq,
      type: 'synthesis.completed',
      schemaVersion: 1,
      payload: {
        manifestHash,
        outcome,
        parentPolicy,
        gaps: hasFailures ? gaps : [],
        childCount: manifest.length,
      },
      actorType,
      actorId,
      traceId,
      occurredAt: now,
    });

    // Emit run.completed event.
    const runCompletedSeq = completedSeq + 1;
    await tx
      .update(schema.missionRuns)
      .set({ lastEventSequence: runCompletedSeq, updatedAt: now })
      .where(eq(schema.missionRuns.id, run.id));

    await tx.insert(schema.runEvents).values({
      companyId: input.companyId,
      projectId: input.projectId,
      runId: run.id,
      sequence: runCompletedSeq,
      type: 'run.completed',
      schemaVersion: 1,
      payload: {
        outcome,
        parentPolicy,
        hasGaps: hasFailures,
        resultCompleteness: completeness,
      },
      actorType,
      actorId,
      traceId,
      occurredAt: now,
    });

    // Update manifest with completed event sequence and synthesis result.
    await tx
      .update(schema.runSynthesisManifests)
      .set({
        completedEventSequence: completedSeq,
        completedAt: now,
        synthesisResult: { outcome, parentPolicy } as unknown as Record<string, unknown>,
      })
      .where(eq(schema.runSynthesisManifests.id, manifestId));

    // Release residual budget.
    const budgetService = new BudgetService(this.db, { clock: () => now });
    await budgetService.release(tx, { companyId: input.companyId, runId: run.id });

    const budgetSeq = runCompletedSeq + 1;
    await tx
      .update(schema.missionRuns)
      .set({ lastEventSequence: budgetSeq, updatedAt: now })
      .where(eq(schema.missionRuns.id, run.id));

    await tx.insert(schema.runEvents).values({
      companyId: input.companyId,
      projectId: input.projectId,
      runId: run.id,
      sequence: budgetSeq,
      type: 'budget.released',
      schemaVersion: 1,
      payload: {},
      actorType,
      actorId,
      traceId,
      occurredAt: now,
    });

    return {
      synthesized: true,
      skipReason: null,
      status: 'completed',
      stateVersion: run.stateVersion + 2,
      lastEventSequence: budgetSeq,
      manifest,
      disclosedGaps: hasFailures ? gaps : [],
      terminalized: true,
    };
  }

  /**
   * Build an ordered synthesis manifest from direct children and their
   * step assignments. The manifest is ordered by direct-child ordinal/step
   * key (VAL-SUB-066, 111), not by completion order.
   *
   * Each entry contains accepted result revision/hash or a typed
   * unavailable reason. A parent consumes only direct-child committed
   * results, never bypassing a composite to read grandchildren.
   */
  private buildOrderedManifest(
    childRows: Array<{
      id: string;
      status: string;
      child_ordinal: number | null;
      failure_category: string | null;
      failure_code: string | null;
      safe_error_message: string | null;
    }>,
    assignmentMap: Map<
      string,
      {
        id: string;
        runId: string;
        stepKey: string;
        childOrdinal: number | null;
        assignmentStatus: string | null;
        resultStatus: string | null;
        resultRevision: string | null;
        resultHash: string | null;
        failureCategory: string | null;
        failureCode: string | null;
        safeErrorMessage: string | null;
      }
    >,
  ): ManifestEntry[] {
    const entries: ManifestEntry[] = [];

    for (const child of childRows) {
      const assignment = assignmentMap.get(child.id);
      const stepKey = assignment?.stepKey ?? `unknown-${child.id.slice(0, 8)}`;
      const childOrdinal = assignment?.childOrdinal ?? child.child_ordinal ?? 0;

      const resultStatus = this.deriveResultStatus(child.status, assignment?.resultStatus);

      const entry: ManifestEntry = {
        stepKey,
        childOrdinal,
        childRunId: child.id,
        resultStatus,
      };

      if (resultStatus === 'completed') {
        entry.resultRevision = assignment?.resultRevision ?? null;
        entry.resultHash = assignment?.resultHash ?? null;
      } else {
        entry.unavailableReason = resultStatus as
          'failed' | 'cancelled' | 'dependency_unavailable' | 'missing';
      }

      entries.push(entry);
    }

    // Sort by child ordinal, then step key for stable ordering (VAL-SUB-066).
    entries.sort((a, b) => {
      const ordA = a.childOrdinal ?? 0;
      const ordB = b.childOrdinal ?? 0;
      if (ordA !== ordB) {
        return ordA - ordB;
      }
      return a.stepKey.localeCompare(b.stepKey);
    });

    return entries;
  }

  /**
   * Derive the manifest result status from the child run status and
   * assignment result status. The assignment result status is authoritative
   * when available; the child run status is the fallback.
   */
  private deriveResultStatus(
    childStatus: string,
    assignmentResultStatus: string | null | undefined,
  ): ManifestEntry['resultStatus'] {
    // Prefer the assignment result status when it has a typed value.
    if (assignmentResultStatus) {
      if (
        assignmentResultStatus === 'completed' ||
        assignmentResultStatus === 'failed' ||
        assignmentResultStatus === 'cancelled' ||
        assignmentResultStatus === 'dependency_unavailable'
      ) {
        return assignmentResultStatus;
      }
    }
    // Fall back to the child run status.
    if (childStatus === 'completed') {
      return 'completed';
    }
    if (childStatus === 'failed') {
      return 'failed';
    }
    if (childStatus === 'cancelled') {
      return 'cancelled';
    }
    return 'missing';
  }

  /**
   * Identify gaps (failed, cancelled, or missing steps) in the manifest
   * for best-effort disclosure (VAL-SUB-053).
   */
  private identifyGaps(manifest: ManifestEntry[]): DisclosedGap[] {
    return manifest
      .filter((e) => e.resultStatus !== 'completed')
      .map((e) => ({
        stepKey: e.stepKey,
        childRunId: e.childRunId,
        reason: (e.unavailableReason ?? 'missing') as DisclosedGap['reason'],
      }));
  }

  /**
   * Compute a canonical SHA-256 hash of the synthesis manifest for
   * exactly-once enforcement and audit (VAL-SUB-065, 111).
   *
   * The hash covers the ordered manifest entries: step key, child ordinal,
   * child run ID, result status, result revision/hash or unavailable reason.
   * Keys are lexicographically sorted; array order (already sorted by
   * ordinal/step key) is preserved.
   */
  private computeManifestHash(manifest: ManifestEntry[]): string {
    const canonical = manifest.map((e) => {
      const obj: Record<string, unknown> = {
        childOrdinal: e.childOrdinal ?? 0,
        childRunId: e.childRunId,
        resultHash: e.resultHash ?? null,
        resultRevision: e.resultRevision ?? null,
        resultStatus: e.resultStatus,
        stepKey: e.stepKey,
        unavailableReason: e.unavailableReason ?? null,
      };
      return obj;
    });
    const json = JSON.stringify(canonical);
    return createHash('sha256').update(json, 'utf8').digest('hex');
  }
}
