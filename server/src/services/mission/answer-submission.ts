import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../middleware/error-handler.js';
import type { DbInstance } from '../../types.js';
import { canonicalHash } from './policy.js';
import {
  validateAnswer,
  type QuestionDefinition,
  type AnswerValidationResult,
} from './question-schema.js';

/**
 * All-or-nothing answer validation and exact-context resume.
 *
 * (VAL-MODEQ-055, 056, 057, 062, 063, 064, 065, 066, 067, 069)
 *
 * This module owns:
 * - **Defaults require explicit submission (055):** A displayed default is
 *   not recorded as an answer and cannot resume the run until the user
 *   explicitly submits the question set. Only answers present in the
 *   submission payload are recorded.
 * - **Optional questions may be omitted (056):** An optional question may
 *   be left unanswered without preventing submission when all required
 *   questions are valid. Omission is distinguishable from an explicitly
 *   submitted default or empty value — no answer row is created for an
 *   omitted optional question.
 * - **Required questions block submission (057):** Submitting with any
 *   required question unanswered fails without marking the set answered or
 *   resuming the run.
 * - **Validation is field specific (062):** Invalid answers produce 422
 *   ANSWER_VALIDATION_FAILED with safe details that identify every invalid
 *   question and its violated rule without exposing prompts, secrets, or
 *   unrelated answers.
 * - **Validation failure is atomic (063):** If any answer in a submission
 *   is invalid, none of that submission's answers is committed, the set
 *   remains open, and the run remains awaiting_input.
 * - **Successful answer is atomic (064):** A valid submission transaction
 *   records all answers, closes the set, appends exactly one
 *   `questions.answered` and one contiguous `run.status_changed` event,
 *   increments state version for the resume transition, and exposes no
 *   partial state.
 * - **Planning question resumes planning (065):** Answering a question set
 *   whose waiting origin is planning resumes that same run in planning,
 *   not running or a newly created run.
 * - **Runtime question resumes running (066):** Answering a question set
 *   whose waiting origin is running resumes that same run in running,
 *   subject to durable queuing/claiming, and does not restart completed
 *   prior work.
 * - **Exact answers enter resume context (067):** Post-answer planning or
 *   execution uses the exact accepted question and answer revisions by
 *   stable reference and hash, not browser text, a later default, or
 *   mutable card content.
 * - **Answered questions cannot be edited silently (069):** After resume,
 *   an answered set is immutable and edits return INVALID_RUN_STATE;
 *   changed assumptions require an explicit plan revision while awaiting
 *   approval or cancellation and retry as a new run, never answer-history
 *   mutation.
 */

type Tx = Parameters<Parameters<DbInstance['drizzle']['transaction']>[0]>[0];
type MissionRunRow = DbInstance['schema']['missionRuns']['$inferSelect'];
type QuestionRow = DbInstance['schema']['runQuestions']['$inferSelect'];

export interface AnswerSubmissionDeps {
  clock?: () => Date;
}

/** A single answer in a submission payload, keyed by question key. */
export interface AnswerInput {
  /** The stable question key this answer targets. */
  questionKey: string;
  /** The raw answer value. `undefined`/absent means omitted (optional only). */
  value?: unknown;
}

/** The submission payload for answering a question set. */
export interface AnswerSubmissionInput {
  questionSetId: string;
  /** The question-set version from the authoritative definition. */
  questionSetVersion: number;
  answers: AnswerInput[];
}

/** A field-level validation error for a single question. */
export interface AnswerFieldError {
  questionKey: string;
  rule: string;
}

/** Result of a successful answer submission. */
export interface AnswerSubmissionResult {
  questionSetId: string;
  /** New run state version (ETag) after the resume transition. */
  stateVersion: number;
  /** Latest event sequence after submission. */
  lastEventSequence: number;
  /** The status the run resumed to (planning or running). */
  resumedStatus: 'planning' | 'running';
  /** Accepted answer references for context reconstruction. */
  acceptedAnswers: AcceptedAnswerRef[];
}

/** A stable reference to an accepted answer for context reconstruction. */
export interface AcceptedAnswerRef {
  questionKey: string;
  questionId: string;
  answerRevision: number;
  contentHash: string;
}

export class MissionAnswerSubmissionService {
  constructor(
    private db: DbInstance,
    private deps: AnswerSubmissionDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  /**
   * Validate all answers against the question definitions without
   * committing anything. Returns field-specific errors for every invalid
   * question (VAL-MODEQ-062).
   *
   * This is the pure validation pass used both by `submitAnswers` and
   * available for pre-check. It does not touch the database.
   */
  validateAllAnswers(
    questions: QuestionRow[],
    answers: AnswerInput[],
  ): { valid: boolean; errors: AnswerFieldError[]; validated: Map<string, unknown> } {
    const answerByKey = new Map<string, unknown>();
    for (const a of answers) {
      // An answer with value undefined means "omitted" — don't record it.
      // An answer with value null is an explicit null (only valid if the
      // validator accepts it, which for all types except optional it won't).
      if (a.value !== undefined) {
        answerByKey.set(a.questionKey, a.value);
      }
    }

    const errors: AnswerFieldError[] = [];
    const validated = new Map<string, unknown>();

    for (const qRow of questions) {
      const def = this.rowToDefinition(qRow);
      const hasAnswer = answerByKey.has(qRow.questionKey);
      const rawValue = hasAnswer ? answerByKey.get(qRow.questionKey) : undefined;

      const result: AnswerValidationResult = validateAnswer(def, rawValue);
      if (!result.success) {
        errors.push({
          questionKey: qRow.questionKey,
          rule: result.error ?? 'invalid answer',
        });
        continue;
      }

      // Only record validated values for questions that were answered.
      // An omitted optional question (result.value === undefined and no
      // answer was provided) creates no answer row (VAL-MODEQ-056).
      if (hasAnswer) {
        validated.set(qRow.questionKey, result.value);
      }
    }

    return { valid: errors.length === 0, errors, validated };
  }

  /**
   * Atomically submit answers for a question set and resume the run.
   *
   * This is the all-or-nothing submission path (VAL-MODEQ-063, 064):
   * - Validates ALL answers field-by-field before any write.
   * - If any answer is invalid: throws 422 ANSWER_VALIDATION_FAILED with
   *   field-specific errors, applies nothing, set remains open, run remains
   *   awaiting_input.
   * - If all answers are valid: records all answer rows, closes the set,
   *   appends `questions.answered` + `run.status_changed` events, bumps
   *   state_version, and resumes the run to `waiting_from_status`.
   *
   * The run row must already be locked via `FOR UPDATE` by the caller.
   *
   * Throws:
   * - 409 QUESTION_SET_INVALIDATED if the set is invalidated.
   * - 409 INVALID_RUN_STATE if the set is already answered (VAL-MODEQ-069).
   * - 409 QUESTION_SET_VERSION_MISMATCH if the set version doesn't match.
   * - 409 INVALID_RUN_STATE if the run is not awaiting_input.
   * - 422 ANSWER_VALIDATION_FAILED with field-specific errors (VAL-MODEQ-062, 063).
   */
  async submitAnswers(
    tx: Tx,
    run: MissionRunRow,
    input: AnswerSubmissionInput,
    opts: {
      actorType: 'user' | 'agent' | 'system';
      actorId: string | null;
      traceId?: string | null;
    },
  ): Promise<AnswerSubmissionResult> {
    const schema = this.db.schema;
    const now = this.now();
    const actorType = opts.actorType;
    const actorId = opts.actorId;
    const traceId = opts.traceId ?? null;

    // 1. The run must be awaiting_input.
    if (run.status !== 'awaiting_input') {
      throw new AppError(
        409,
        'INVALID_RUN_STATE',
        'Answers can only be submitted while the run is awaiting input',
      );
    }

    // 2. Lock and verify the question set.
    const [questionSet] = await tx
      .select()
      .from(schema.runQuestionSets)
      .where(
        and(
          eq(schema.runQuestionSets.companyId, run.companyId),
          eq(schema.runQuestionSets.id, input.questionSetId),
        ),
      )
      .for('update')
      .limit(1);

    if (!questionSet) {
      throw new AppError(404, 'RUN_NOT_FOUND', 'Question set not found');
    }

    // The set must belong to this run.
    if (questionSet.runId !== run.id) {
      throw new AppError(404, 'RUN_NOT_FOUND', 'Question set not found');
    }

    // Check set status (VAL-MODEQ-069, VAL-MODEQ-076).
    if (questionSet.status === 'invalidated') {
      throw new AppError(
        409,
        'QUESTION_SET_INVALIDATED',
        'This question set has been invalidated and cannot accept answers',
      );
    }
    if (questionSet.status === 'answered') {
      // VAL-MODEQ-069: answered sets are immutable.
      throw new AppError(
        409,
        'INVALID_RUN_STATE',
        'This question set has already been answered and cannot be edited',
      );
    }

    // Check set version (VAL-MODEQ-075). The version must match the
    // authoritative current version.
    if (questionSet.version !== input.questionSetVersion) {
      throw new AppError(
        409,
        'QUESTION_SET_VERSION_MISMATCH',
        'The question set version does not match the current version',
      );
    }

    // 3. Load the question definitions for this set.
    const questions = await tx
      .select()
      .from(schema.runQuestions)
      .where(eq(schema.runQuestions.questionSetId, input.questionSetId))
      .orderBy(schema.runQuestions.order);

    if (questions.length === 0) {
      throw new AppError(
        409,
        'QUESTION_SET_INVALIDATED',
        'The question set has no question definitions',
      );
    }

    // 4. Validate ALL answers field-by-field (VAL-MODEQ-062, 063).
    // This is the all-or-nothing validation pass. If any answer is invalid,
    // nothing is committed.
    const validation = this.validateAllAnswers(questions, input.answers);
    if (!validation.valid) {
      // VAL-MODEQ-063: validation failure is atomic — nothing is committed.
      // VAL-MODEQ-062: field-specific errors identifying every invalid
      // question and its violated rule.
      throw new AppError(422, 'ANSWER_VALIDATION_FAILED', 'One or more answers are invalid', {
        errors: validation.errors.map((e) => ({
          questionKey: e.questionKey,
          rule: e.rule,
        })),
      });
    }

    // 5. All answers are valid — record them atomically (VAL-MODEQ-064).
    const acceptedAnswers: AcceptedAnswerRef[] = [];
    for (const qRow of questions) {
      // Only create answer rows for questions that were answered.
      // Omitted optional questions create no answer row (VAL-MODEQ-056).
      if (!validation.validated.has(qRow.questionKey)) {
        continue;
      }

      const value = validation.validated.get(qRow.questionKey);
      const contentHash = canonicalHash(value);
      const answerId = randomUUID();

      await tx.insert(schema.runQuestionAnswers).values({
        id: answerId,
        companyId: run.companyId,
        projectId: run.projectId,
        runId: run.id,
        questionSetId: input.questionSetId,
        questionId: qRow.id,
        questionKey: qRow.questionKey,
        answerRevision: 1,
        value: value ?? null,
        contentHash,
        actorType,
        actorId,
        createdAt: now,
      });

      acceptedAnswers.push({
        questionKey: qRow.questionKey,
        questionId: qRow.id,
        answerRevision: 1,
        contentHash,
      });
    }

    // 6. Close the question set (status → answered).
    await tx
      .update(schema.runQuestionSets)
      .set({
        status: 'answered',
        answeredAt: now,
      })
      .where(eq(schema.runQuestionSets.id, input.questionSetId));

    // 7. Resume the run: transition from awaiting_input to waiting_from_status.
    const resumedStatus = run.waitingFromStatus ?? 'planning';
    const newVersion = run.stateVersion + 1;
    const seqAnswered = Number(run.lastEventSequence) + 1;
    const seqStatusChanged = seqAnswered + 1;

    await tx
      .update(schema.missionRuns)
      .set({
        status: resumedStatus,
        currentQuestionSetId: null,
        waitingFromStatus: null,
        stateVersion: newVersion,
        lastEventSequence: seqStatusChanged,
        // For planning: no lease, no available_at — the worker picks it up
        //   during its next claim cycle.
        // For running: make it available for a worker to claim.
        availableAt: resumedStatus === 'running' ? now : null,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        updatedAt: now,
      })
      .where(eq(schema.missionRuns.id, run.id));

    // 8. Emit questions.answered event with exact answer references (VAL-MODEQ-067).
    await tx.insert(schema.runEvents).values({
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      sequence: seqAnswered,
      type: 'questions.answered',
      schemaVersion: 1,
      payload: {
        questionSetId: input.questionSetId,
        version: input.questionSetVersion,
        waitingFromStatus: resumedStatus,
        acceptedAnswers: acceptedAnswers.map((a) => ({
          questionKey: a.questionKey,
          answerRevision: a.answerRevision,
          contentHash: a.contentHash,
        })),
      },
      actorType,
      actorId,
      traceId,
      occurredAt: now,
    });

    // 9. Emit run.status_changed event (contiguous with questions.answered).
    await tx.insert(schema.runEvents).values({
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      sequence: seqStatusChanged,
      type: 'run.status_changed',
      schemaVersion: 1,
      payload: {
        from: 'awaiting_input',
        to: resumedStatus,
      },
      actorType,
      actorId,
      traceId,
      occurredAt: now,
    });

    return {
      questionSetId: input.questionSetId,
      stateVersion: newVersion,
      lastEventSequence: seqStatusChanged,
      resumedStatus,
      acceptedAnswers,
    };
  }

  /**
   * Read the accepted answers for a question set, ordered by question order.
   * Used for context reconstruction (VAL-MODEQ-067).
   */
  async readAnswersForSet(
    companyId: string,
    questionSetId: string,
  ): Promise<DbInstance['schema']['runQuestionAnswers']['$inferSelect'][]> {
    const schema = this.db.schema;
    return this.db.drizzle
      .select()
      .from(schema.runQuestionAnswers)
      .where(
        and(
          eq(schema.runQuestionAnswers.companyId, companyId),
          eq(schema.runQuestionAnswers.questionSetId, questionSetId),
        ),
      )
      .orderBy(schema.runQuestionAnswers.questionKey);
  }

  /**
   * Convert a database question row to a QuestionDefinition for validation.
   * Reconstructs the discriminated union shape from the stored columns.
   */
  private rowToDefinition(row: QuestionRow): QuestionDefinition {
    const base = {
      questionKey: row.questionKey,
      order: row.order,
      label: row.label,
      help: row.help ?? undefined,
      required: row.required === 1,
      default: row.defaultValue ?? undefined,
    };

    switch (row.type) {
      case 'boolean':
        return {
          type: 'boolean',
          ...base,
        } as QuestionDefinition;
      case 'single_choice':
        return {
          type: 'single_choice',
          options: (row.options as { key: string; label: string }[]) ?? [],
          ...base,
        } as QuestionDefinition;
      case 'multiple_choice':
        return {
          type: 'multiple_choice',
          options: (row.options as { key: string; label: string }[]) ?? [],
          validation: (row.validation as Record<string, unknown>) ?? undefined,
          ...base,
        } as QuestionDefinition;
      case 'text':
        return {
          type: 'text',
          validation: (row.validation as Record<string, unknown>) ?? undefined,
          ...base,
        } as QuestionDefinition;
      case 'number':
        return {
          type: 'number',
          validation: (row.validation as Record<string, unknown>) ?? undefined,
          ...base,
        } as QuestionDefinition;
      case 'scale':
        return {
          type: 'scale',
          validation: (row.validation as Record<string, unknown>) ?? undefined,
          ...base,
        } as QuestionDefinition;
      case 'ordering':
        return {
          type: 'ordering',
          options: (row.options as { key: string; label: string }[]) ?? [],
          ...base,
        } as QuestionDefinition;
      default:
        // Exhaustive guard — should never happen with closed schema.
        throw new AppError(500, 'INTERNAL_ERROR', `Unknown question type: ${row.type}`);
    }
  }
}
