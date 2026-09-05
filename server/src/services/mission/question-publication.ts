import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../middleware/error-handler.js';
import type { DbInstance } from '../../types.js';
import { QuestionSet } from './question-schema.js';

/**
 * Atomic question publication, replacement, limits, and deadlines.
 *
 * (VAL-MODEQ-044, 059, 128, 130, 135, 142, 147, 150)
 *
 * This module owns:
 * - **Atomic publication (044, 147):** Entering `awaiting_input` atomically
 *   creates one schema-valid set and questions, initializes set version 1,
 *   updates `currentQuestionSetId` and `waitingFromStatus`, appends
 *   `questions.requested` plus the status transition, and makes the set
 *   readable. A fault after any internal write exposes neither an awaiting
 *   run without an actionable set nor an orphan/open set/event.
 * - **Replacement (130):** A run exposes at most one open question set.
 *   Replacement atomically invalidates the old set with a safe reason,
 *   emits invalidation before the new request, and never exposes two
 *   actionable sets.
 * - **Set count limit (059):** The maximum of three counts all created
 *   answered and invalidated sets for one run across restart. A fourth need
 *   terminally fails with category `limit` and code
 *   `QUESTION_SET_LIMIT_EXCEEDED`.
 * - **Generated failures bounded (135):** Unknown types, malformed
 *   validation/defaults/options, unsafe patterns, oversized sets, and a
 *   fourth set are rejected before presentation and retried only within
 *   normal internal bounds; exhaustion terminates safely with
 *   `QUESTION_SCHEMA_INVALID` or `QUESTION_SET_LIMIT_EXCEEDED`.
 * - **Deadline expiry (150):** When the absolute Mission deadline expires
 *   in `awaiting_input`, one terminalization transaction invalidates the
 *   open set with `deadline_expired`, fails the run with category `limit`
 *   and code `TIME_LIMIT`, settles known charges, and releases residual
 *   budget.
 */

type Tx = Parameters<Parameters<DbInstance['drizzle']['transaction']>[0]>[0];
type MissionRunRow = DbInstance['schema']['missionRuns']['$inferSelect'];

/** Maximum number of question sets per run (VAL-MODEQ-059). */
export const MAX_QUESTION_SETS_PER_RUN = 3;

/** Safe invalidation reasons. */
export type InvalidationReason = 'replaced' | 'deadline_expired' | 'cancelled';

export interface QuestionPublicationDeps {
  clock?: () => Date;
}

/** Result of a successful question set publication. */
export interface PublishResult {
  questionSetId: string;
  ordinal: number;
  version: number;
  /** New run state version (ETag). */
  stateVersion: number;
  /** Latest event sequence after publication. */
  lastEventSequence: number;
}

/** Result of an atomic replacement (invalidate + publish). */
export interface ReplaceResult extends PublishResult {
  /** ID of the invalidated set, or null if no prior open set existed. */
  invalidatedSetId: string | null;
}

export class MissionQuestionPublicationService {
  constructor(
    private db: DbInstance,
    private deps: QuestionPublicationDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  /**
   * Atomically publish a question set for a run.
   *
   * Validates the question definitions against the closed schema, enforces
   * the set count limit (max 3), creates the set + questions rows, updates
   * the run's `currentQuestionSetId` / `waitingFromStatus` / status, and
   * appends `questions.requested` + `run.status_changed` journal events —
   * all within the caller's locked transaction (VAL-MODEQ-044, 147).
   *
   * The run row must already be locked via `FOR UPDATE` by the caller.
   *
   * Throws `QUESTION_SET_LIMIT_EXCEEDED` if the run already has 3 sets
   * (VAL-MODEQ-059). Throws `QUESTION_SCHEMA_INVALID` if the question
   * definitions fail closed-schema validation (VAL-MODEQ-135).
   */
  async publishQuestionSet(
    tx: Tx,
    run: MissionRunRow,
    questions: unknown[],
    waitingFromStatus: 'planning' | 'running',
    opts: {
      promptContextHash?: string | null;
      actorType?: 'user' | 'agent' | 'system';
      actorId?: string | null;
      traceId?: string | null;
    } = {},
  ): Promise<PublishResult> {
    const schema = this.db.schema;
    const now = this.now();
    const actorType = opts.actorType ?? 'system';
    const actorId = opts.actorId ?? null;
    const traceId = opts.traceId ?? null;

    // 1. Validate the question set against the closed schema (VAL-MODEQ-135).
    const parseResult = QuestionSet.safeParse(questions);
    if (!parseResult.success) {
      throw new AppError(
        422,
        'QUESTION_SCHEMA_INVALID',
        `Question set failed schema validation: ${parseResult.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    const validatedQuestions = parseResult.data;

    // 2. Enforce the set count limit (max 3, counting all statuses) (VAL-MODEQ-059).
    const setCount = await this.countSets(tx, run.companyId, run.id);
    if (setCount >= MAX_QUESTION_SETS_PER_RUN) {
      throw new AppError(
        409,
        'QUESTION_SET_LIMIT_EXCEEDED',
        'Maximum of 3 question sets per run has been reached',
      );
    }

    // 3. Compute the next ordinal (per-run, starting at 1).
    const ordinal = setCount + 1;
    const questionSetId = randomUUID();

    // 4. Insert the question set row.
    await tx.insert(schema.runQuestionSets).values({
      id: questionSetId,
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      ordinal,
      version: 1,
      status: 'open',
      invalidationReason: null,
      promptContextHash: opts.promptContextHash ?? null,
      createdAt: now,
      answeredAt: null,
      invalidatedAt: null,
    });

    // 5. Insert question definition rows.
    for (const q of validatedQuestions) {
      await tx.insert(schema.runQuestions).values({
        id: randomUUID(),
        companyId: run.companyId,
        projectId: run.projectId,
        runId: run.id,
        questionSetId,
        questionKey: q.questionKey,
        order: q.order,
        type: q.type,
        label: q.label,
        help: q.help ?? null,
        required: q.required ? 1 : 0,
        defaultValue: q.default ?? null,
        options: (q as unknown as { options?: unknown[] }).options ?? null,
        validation: (q as unknown as { validation?: Record<string, unknown> }).validation ?? null,
        createdAt: now,
      });
    }

    // 6. Update the run: status → awaiting_input, set pointers, bump version/sequence.
    const newVersion = run.stateVersion + 1;
    const seqRequested = Number(run.lastEventSequence) + 1;
    const seqStatusChanged = seqRequested + 1;

    await tx
      .update(schema.missionRuns)
      .set({
        status: 'awaiting_input',
        waitingFromStatus,
        currentQuestionSetId: questionSetId,
        stateVersion: newVersion,
        lastEventSequence: seqStatusChanged,
        // Release active work: clear lease fields so no worker holds this run.
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        availableAt: null,
        updatedAt: now,
      })
      .where(eq(schema.missionRuns.id, run.id));

    // 7. Emit questions.requested event (before status_changed).
    await tx.insert(schema.runEvents).values({
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      sequence: seqRequested,
      type: 'questions.requested',
      schemaVersion: 1,
      payload: {
        questionSetId,
        ordinal,
        version: 1,
        waitingFromStatus,
        questionCount: validatedQuestions.length,
        questionKeys: validatedQuestions.map((q) => q.questionKey),
      },
      actorType,
      actorId,
      traceId,
      occurredAt: now,
    });

    // 8. Emit run.status_changed event.
    await tx.insert(schema.runEvents).values({
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      sequence: seqStatusChanged,
      type: 'run.status_changed',
      schemaVersion: 1,
      payload: {
        from: run.status,
        to: 'awaiting_input',
      },
      actorType,
      actorId,
      traceId,
      occurredAt: now,
    });

    return {
      questionSetId,
      ordinal,
      version: 1,
      stateVersion: newVersion,
      lastEventSequence: seqStatusChanged,
    };
  }

  /**
   * Atomically replace the current open question set with a new one.
   *
   * Invalidates the old set with reason `replaced`, emits
   * `questions.invalidated` before the new `questions.requested`, then
   * publishes the new set — all in one locked transaction. Never exposes
   * two actionable sets (VAL-MODEQ-130).
   *
   * The run row must already be locked via `FOR UPDATE` by the caller.
   */
  async replaceQuestionSet(
    tx: Tx,
    run: MissionRunRow,
    questions: unknown[],
    waitingFromStatus: 'planning' | 'running',
    opts: {
      promptContextHash?: string | null;
      actorType?: 'user' | 'agent' | 'system';
      actorId?: string | null;
      traceId?: string | null;
    } = {},
  ): Promise<ReplaceResult> {
    const schema = this.db.schema;
    const now = this.now();
    const actorType = opts.actorType ?? 'system';
    const actorId = opts.actorId ?? null;
    const traceId = opts.traceId ?? null;

    // Find the current open set (if any).
    const currentSetId = run.currentQuestionSetId;
    let invalidatedSetId: string | null = null;
    let baseVersion = run.stateVersion;
    let baseSeq = Number(run.lastEventSequence);

    if (currentSetId) {
      // Lock and verify the current set is open.
      const [currentSet] = await tx
        .select()
        .from(schema.runQuestionSets)
        .where(
          and(
            eq(schema.runQuestionSets.companyId, run.companyId),
            eq(schema.runQuestionSets.id, currentSetId),
          ),
        )
        .for('update')
        .limit(1);

      if (currentSet && currentSet.status === 'open') {
        invalidatedSetId = currentSetId;

        // Invalidate the old set.
        const invalidateSeq = baseSeq + 1;
        await tx
          .update(schema.runQuestionSets)
          .set({
            status: 'invalidated',
            invalidationReason: 'replaced',
            invalidatedAt: now,
          })
          .where(eq(schema.runQuestionSets.id, currentSetId));

        // Emit questions.invalidated event (before the new request).
        await tx.insert(schema.runEvents).values({
          companyId: run.companyId,
          projectId: run.projectId,
          runId: run.id,
          sequence: invalidateSeq,
          type: 'questions.invalidated',
          schemaVersion: 1,
          payload: {
            questionSetId: currentSetId,
            ordinal: currentSet.ordinal,
            reason: 'replaced',
          },
          actorType,
          actorId,
          traceId,
          occurredAt: now,
        });

        // Bump run version for the invalidation (snapshot-visible change).
        baseVersion += 1;
        baseSeq = invalidateSeq;
      }
    }

    // Update the run row for the invalidation (if any), then publish the
    // new set. We construct a "virtual" run row with updated version/seq
    // so publishQuestionSet sees the correct base.
    if (invalidatedSetId) {
      await tx
        .update(schema.missionRuns)
        .set({
          stateVersion: baseVersion,
          lastEventSequence: baseSeq,
          updatedAt: now,
        })
        .where(eq(schema.missionRuns.id, run.id));
    }

    // Re-read the locked run to get the current state for publishQuestionSet.
    const [updatedRun] = await tx
      .select()
      .from(schema.missionRuns)
      .where(eq(schema.missionRuns.id, run.id))
      .for('update')
      .limit(1);

    if (!updatedRun) {
      throw new AppError(404, 'RUN_NOT_FOUND', 'Mission run not found');
    }

    // Publish the new set. This will validate, count, create, and emit events.
    const publishResult = await this.publishQuestionSet(
      tx,
      updatedRun,
      questions,
      waitingFromStatus,
      opts,
    );

    return {
      ...publishResult,
      invalidatedSetId,
    };
  }

  /**
   * Invalidate the current open question set for a run with a safe reason.
   *
   * Called during cancellation terminalization (reason `cancelled`) or
   * deadline expiry (reason `deadline_expired`). Emits a
   * `questions.invalidated` journal event. The run row must already be
   * locked by the caller.
   */
  async invalidateOpenSet(
    tx: Tx,
    run: MissionRunRow,
    reason: InvalidationReason,
    opts: {
      actorType?: 'user' | 'agent' | 'system';
      actorId?: string | null;
      traceId?: string | null;
      /** Base sequence to use for the event; defaults to run.lastEventSequence. */
      baseSequence?: number;
    } = {},
  ): Promise<{ invalidated: boolean; questionSetId: string | null; eventSequence: number | null }> {
    const schema = this.db.schema;
    const now = this.now();
    const actorType = opts.actorType ?? 'system';
    const actorId = opts.actorId ?? null;
    const traceId = opts.traceId ?? null;

    const currentSetId = run.currentQuestionSetId;
    if (!currentSetId) {
      return { invalidated: false, questionSetId: null, eventSequence: null };
    }

    // Lock and verify the current set is open.
    const [currentSet] = await tx
      .select()
      .from(schema.runQuestionSets)
      .where(
        and(
          eq(schema.runQuestionSets.companyId, run.companyId),
          eq(schema.runQuestionSets.id, currentSetId),
        ),
      )
      .for('update')
      .limit(1);

    if (!currentSet || currentSet.status !== 'open') {
      return { invalidated: false, questionSetId: null, eventSequence: null };
    }

    const seq = opts.baseSequence ?? Number(run.lastEventSequence) + 1;

    // Invalidate the set.
    await tx
      .update(schema.runQuestionSets)
      .set({
        status: 'invalidated',
        invalidationReason: reason,
        invalidatedAt: now,
      })
      .where(eq(schema.runQuestionSets.id, currentSetId));

    // Clear the run's pointer.
    await tx
      .update(schema.missionRuns)
      .set({
        currentQuestionSetId: null,
        lastEventSequence: seq,
        updatedAt: now,
      })
      .where(eq(schema.missionRuns.id, run.id));

    // Emit questions.invalidated event.
    await tx.insert(schema.runEvents).values({
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      sequence: seq,
      type: 'questions.invalidated',
      schemaVersion: 1,
      payload: {
        questionSetId: currentSetId,
        ordinal: currentSet.ordinal,
        reason,
      },
      actorType,
      actorId,
      traceId,
      occurredAt: now,
    });

    return { invalidated: true, questionSetId: currentSetId, eventSequence: seq };
  }

  /**
   * Count all question sets for a run (open, answered, and invalidated).
   * Used to enforce the max-3 limit (VAL-MODEQ-059).
   */
  async countSets(tx: Tx, companyId: string, runId: string): Promise<number> {
    const schema = this.db.schema;
    const result = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.runQuestionSets)
      .where(
        and(
          eq(schema.runQuestionSets.companyId, companyId),
          eq(schema.runQuestionSets.runId, runId),
        ),
      );
    return result[0]?.count ?? 0;
  }

  /**
   * Read the current open question set for a run, including its question
   * definitions. Returns null if the run has no open set.
   */
  async readOpenSet(
    companyId: string,
    projectId: string,
    runId: string,
  ): Promise<{
    set: DbInstance['schema']['runQuestionSets']['$inferSelect'];
    questions: DbInstance['schema']['runQuestions']['$inferSelect'][];
  } | null> {
    const schema = this.db.schema;

    const [run] = await this.db.drizzle
      .select({ currentQuestionSetId: schema.missionRuns.currentQuestionSetId })
      .from(schema.missionRuns)
      .where(
        and(
          eq(schema.missionRuns.companyId, companyId),
          eq(schema.missionRuns.projectId, projectId),
          eq(schema.missionRuns.id, runId),
        ),
      )
      .limit(1);

    if (!run || !run.currentQuestionSetId) {
      return null;
    }

    const [questionSet] = await this.db.drizzle
      .select()
      .from(schema.runQuestionSets)
      .where(
        and(
          eq(schema.runQuestionSets.companyId, companyId),
          eq(schema.runQuestionSets.id, run.currentQuestionSetId),
        ),
      )
      .limit(1);

    if (!questionSet || questionSet.status !== 'open') {
      return null;
    }

    const questions = await this.db.drizzle
      .select()
      .from(schema.runQuestions)
      .where(eq(schema.runQuestions.questionSetId, questionSet.id))
      .orderBy(schema.runQuestions.order);

    return { set: questionSet, questions };
  }

  /**
   * Terminalize a run whose absolute Mission deadline has expired while
   * in `awaiting_input`. Invalidates the open set with `deadline_expired`,
   * fails the run with category `limit` and code `TIME_LIMIT`, settles
   * known charges, and releases residual budget (VAL-MODEQ-150).
   *
   * This is a terminalization transaction — one atomic outcome. The caller
   * should lock the run before calling.
   */
  async terminalizeForDeadlineExpiry(
    tx: Tx,
    run: MissionRunRow,
    opts: {
      actorType?: 'user' | 'agent' | 'system';
      actorId?: string | null;
      traceId?: string | null;
    } = {},
  ): Promise<{
    terminalized: boolean;
    stateVersion: number;
    lastEventSequence: number;
  }> {
    const schema = this.db.schema;
    const now = this.now();
    const actorType = opts.actorType ?? 'system';
    const actorId = opts.actorId ?? null;
    const traceId = opts.traceId ?? null;

    // Invalidate the open question set first (if any).
    let baseSeq = Number(run.lastEventSequence);
    const invalidateResult = await this.invalidateOpenSet(tx, run, 'deadline_expired', {
      actorType,
      actorId,
      traceId,
      baseSequence: baseSeq + 1,
    });
    if (invalidateResult.invalidated) {
      baseSeq = invalidateResult.eventSequence!;
    }

    // Fail the run with category `limit` and code `TIME_LIMIT`.
    const newVersion = run.stateVersion + 1;
    const seqFailed = baseSeq + 1;
    const seqBudgetReleased = seqFailed + 1;

    await tx
      .update(schema.missionRuns)
      .set({
        status: 'failed',
        failureCategory: 'limit',
        failureCode: 'TIME_LIMIT',
        safeErrorMessage: 'The Mission wall-time deadline expired while awaiting input.',
        terminalAt: now,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        availableAt: null,
        stateVersion: newVersion,
        lastEventSequence: seqBudgetReleased,
        updatedAt: now,
      })
      .where(eq(schema.missionRuns.id, run.id));

    // Emit run.failed event.
    await tx.insert(schema.runEvents).values({
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      sequence: seqFailed,
      type: 'run.failed',
      schemaVersion: 1,
      payload: {
        category: 'limit',
        code: 'TIME_LIMIT',
        safeMessage: 'The Mission wall-time deadline expired while awaiting input.',
      },
      actorType,
      actorId,
      traceId,
      occurredAt: now,
    });

    // Release residual budget.
    const { BudgetService } = await import('./budget.js');
    const budgetService = new BudgetService(this.db, { clock: () => now });
    await budgetService.release(tx, { companyId: run.companyId, runId: run.id });

    // Emit budget.released event.
    await tx.insert(schema.runEvents).values({
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      sequence: seqBudgetReleased,
      type: 'budget.released',
      schemaVersion: 1,
      payload: {},
      actorType,
      actorId,
      traceId,
      occurredAt: now,
    });

    return {
      terminalized: true,
      stateVersion: newVersion,
      lastEventSequence: seqBudgetReleased,
    };
  }
}
