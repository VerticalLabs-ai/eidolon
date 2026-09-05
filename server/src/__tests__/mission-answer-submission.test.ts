import { describe, expect, it, afterEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer, closeTestServers } from '../test-utils.js';
import { MissionQuestionPublicationService } from '../services/mission/question-publication.js';
import { MissionAnswerSubmissionService } from '../services/mission/answer-submission.js';
import { canonicalHash } from '../services/mission/policy.js';

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

function enableMissionFlag() {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify({ missionAgentIntelligence: { enabled: true } }),
  );
}

async function seedScope(db: AnyDb, label: string) {
  const companyId = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "companies" ("id", "name", "status", "budget_monthly_cents", "spent_monthly_cents", "settings", "created_at", "updated_at")
    VALUES (${companyId}, ${label}, 'active', 100000, 0, '{}'::jsonb, ${now}, ${now})
  `);
  const projectId = randomUUID();
  await db.drizzle.execute(sql`
    INSERT INTO "projects" ("id", "company_id", "name", "status", "created_at", "updated_at")
    VALUES (${projectId}, ${companyId}, 'P', 'active', ${now}, ${now})
  `);
  const threadId = randomUUID();
  await db.drizzle.execute(sql`
    INSERT INTO "project_threads" ("id", "company_id", "project_id", "title", "type", "status", "created_at", "updated_at")
    VALUES (${threadId}, ${companyId}, ${projectId}, 'T', 'conversation', 'active', ${now}, ${now})
  `);
  return { companyId, projectId, threadId };
}

async function freshRun(label: string, text = 'Do work') {
  enableMissionFlag();
  const db = await createTestDb();
  const app = await createTestServer(db);
  const { companyId, projectId, threadId } = await seedScope(db, label);
  const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
  const start = await request(app)
    .post(base)
    .set('Idempotency-Key', `ans-${randomUUID()}`)
    .send({ projectThreadId: threadId, mode: 'fast', request: { text } })
    .expect(202);
  return {
    db,
    app,
    companyId,
    projectId,
    threadId,
    runId: start.body.data.run.id as string,
    base,
  };
}

async function setRunStatus(
  db: AnyDb,
  runId: string,
  status: string,
  opts: {
    waitingFromStatus?: string | null;
    currentQuestionSetId?: string | null;
  } = {},
) {
  const now = new Date();
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(status);
  await db.drizzle.execute(sql`
    UPDATE "mission_runs"
    SET "status" = ${status},
        "terminal_at" = ${isTerminal ? now : null},
        "updated_at" = ${now},
        "waiting_from_status" = ${opts.waitingFromStatus ?? null},
        "current_question_set_id" = ${opts.currentQuestionSetId ?? null}
    WHERE "id" = ${runId}
  `);
}

async function getRunRow(db: AnyDb, runId: string): Promise<Record<string, unknown> | null> {
  const rows = (await db.drizzle.execute(sql`
    SELECT * FROM "mission_runs" WHERE "id" = ${runId}
  `)) as unknown as Record<string, unknown>[];
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    ...row,
    state_version: Number(row.state_version),
    last_event_sequence: Number(row.last_event_sequence),
  } as Record<string, unknown>;
}

async function getEvents(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "sequence", "type", "payload" FROM "run_events"
    WHERE "run_id" = ${runId} ORDER BY "sequence" ASC
  `)) as unknown as Array<{ sequence: string | number; type: string; payload: unknown }>;
  return rows.map((r) => ({
    sequence: Number(r.sequence),
    type: r.type,
    payload: r.payload as Record<string, unknown>,
  }));
}

async function getQuestionSetRow(db: AnyDb, setId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT * FROM "run_question_sets" WHERE "id" = ${setId}
  `)) as unknown as Record<string, unknown>[];
  return rows[0] ?? null;
}

async function getAnswersForSet(db: AnyDb, setId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT * FROM "run_question_answers"
    WHERE "question_set_id" = ${setId}
    ORDER BY "question_key" ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows;
}

async function getTypedQuestions(db: AnyDb, setId: string) {
  return db.drizzle
    .select()
    .from(db.schema.runQuestions)
    .where(eq(db.schema.runQuestions.questionSetId, setId))
    .orderBy(db.schema.runQuestions.order);
}

async function publishSet(
  db: AnyDb,
  runId: string,
  questions: unknown[],
  waitingFromStatus: 'planning' | 'running',
): Promise<string> {
  const pubService = new MissionQuestionPublicationService(db);
  let questionSetId: string;
  await db.drizzle.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(db.schema.missionRuns)
      .where(eq(db.schema.missionRuns.id, runId))
      .for('update')
      .limit(1);
    const result = await pubService.publishQuestionSet(tx, locked!, questions, waitingFromStatus);
    questionSetId = result.questionSetId;
  });
  return questionSetId!;
}

/**
 * Run an answer submission that is expected to fail, capturing the error
 * and rolling back the transaction. Uses the re-throw + outer-catch
 * pattern so the transaction is cleanly rolled back by the driver.
 */
async function expectSubmitError(
  db: AnyDb,
  runId: string,
  input: Parameters<MissionAnswerSubmissionService['submitAnswers']>[2],
): Promise<unknown> {
  const answerService = new MissionAnswerSubmissionService(db);
  let caught: unknown;
  await db.drizzle
    .transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);
      try {
        await answerService.submitAnswers(tx, locked!, input, {
          actorType: 'user',
          actorId: 'user-1',
        });
      } catch (e) {
        caught = e;
        throw e; // re-throw to roll back the transaction
      }
    })
    .catch(() => {
      // Expected: error already captured above.
    });
  return caught;
}

/**
 * Run an answer submission with a specific run row state (for testing
 * answered/invalidated set states where the run row needs to be modified
 * before the call).
 */
async function expectSubmitErrorWithRun(
  db: AnyDb,
  runId: string,
  runOverride: Record<string, unknown>,
  input: Parameters<MissionAnswerSubmissionService['submitAnswers']>[2],
): Promise<unknown> {
  const answerService = new MissionAnswerSubmissionService(db);
  let caught: unknown;
  await db.drizzle
    .transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);
      // Apply overrides to the locked run row for testing edge cases.
      const runWithOverrides = { ...locked!, ...runOverride };
      try {
        await answerService.submitAnswers(tx, runWithOverrides, input, {
          actorType: 'user',
          actorId: 'user-1',
        });
      } catch (e) {
        caught = e;
        throw e;
      }
    })
    .catch(() => {
      // Expected.
    });
  return caught;
}

/** Questions with defaults, required, and optional fields for comprehensive testing. */
function mixedQuestions(): unknown[] {
  return [
    {
      questionKey: 'bool_req',
      order: 0,
      type: 'boolean',
      label: 'Required boolean?',
      required: true,
    },
    {
      questionKey: 'bool_opt',
      order: 1,
      type: 'boolean',
      label: 'Optional boolean?',
      required: false,
      default: false,
    },
    {
      questionKey: 'choice_req',
      order: 2,
      type: 'single_choice',
      label: 'Required choice?',
      required: true,
      options: [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
      ],
    },
    {
      questionKey: 'choice_opt',
      order: 3,
      type: 'single_choice',
      label: 'Optional choice with default?',
      required: false,
      default: 'a',
      options: [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
      ],
    },
    {
      questionKey: 'text_req',
      order: 4,
      type: 'text',
      label: 'Required text?',
      required: true,
      validation: { minLength: 3, maxLength: 100 },
    },
    {
      questionKey: 'text_opt',
      order: 5,
      type: 'text',
      label: 'Optional text with default?',
      required: false,
      default: 'hello',
      validation: { maxLength: 100 },
    },
  ];
}

/** Valid answers for all required questions in mixedQuestions(). */
function validRequiredAnswers() {
  return [
    { questionKey: 'bool_req', value: true },
    { questionKey: 'choice_req', value: 'a' },
    { questionKey: 'text_req', value: 'done' },
  ];
}

afterEach(async () => {
  await closeTestServers();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-055: Defaults require explicit submission
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-055: Defaults require explicit submission', () => {
  it('a displayed default is not recorded as an answer before explicit submission', async () => {
    const ctx = await freshRun('ans-defaults');
    const { db, runId } = ctx;

    await setRunStatus(db, runId, 'planning');
    const setId = await publishSet(db, runId, mixedQuestions(), 'planning');

    // Before submission: set is open, no answers recorded, run is awaiting_input.
    const setBefore = await getQuestionSetRow(db, setId);
    expect(setBefore!.status).toBe('open');

    const answersBefore = await getAnswersForSet(db, setId);
    expect(answersBefore).toHaveLength(0);

    const runBefore = await getRunRow(db, runId);
    expect(runBefore!.status).toBe('awaiting_input');

    // The defaults (bool_opt=false, choice_opt='a', text_opt='hello') are
    // visible in the question definitions but NOT recorded as answers.
  });

  it('omitting an answer with a default does not fabricate an answer from the default', async () => {
    const ctx = await freshRun('ans-defaults-omit');
    const { db, runId } = ctx;

    await setRunStatus(db, runId, 'planning');
    const setId = await publishSet(db, runId, mixedQuestions(), 'planning');

    const answerService = new MissionAnswerSubmissionService(db);

    // Submit only the required questions, omitting optional ones that have defaults.
    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);
      await answerService.submitAnswers(
        tx,
        locked!,
        {
          questionSetId: setId,
          questionSetVersion: 1,
          answers: validRequiredAnswers(),
        },
        { actorType: 'user', actorId: 'user-1' },
      );
    });

    // Answers should only be for the 3 required questions — no fabricated
    // defaults for the omitted optional questions.
    const answers = await getAnswersForSet(db, setId);
    expect(answers).toHaveLength(3);
    const keys = answers.map((a) => a.question_key);
    expect(keys).toContain('bool_req');
    expect(keys).toContain('choice_req');
    expect(keys).toContain('text_req');
    expect(keys).not.toContain('bool_opt');
    expect(keys).not.toContain('choice_opt');
    expect(keys).not.toContain('text_opt');
  });

  it('explicitly submitting a default value records it as an answer', async () => {
    const ctx = await freshRun('ans-defaults-explicit');
    const { db, runId } = ctx;

    await setRunStatus(db, runId, 'planning');
    const setId = await publishSet(db, runId, mixedQuestions(), 'planning');

    const answerService = new MissionAnswerSubmissionService(db);

    // Explicitly submit the default value for choice_opt.
    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);
      await answerService.submitAnswers(
        tx,
        locked!,
        {
          questionSetId: setId,
          questionSetVersion: 1,
          answers: [
            ...validRequiredAnswers(),
            { questionKey: 'choice_opt', value: 'a' }, // explicitly submit default
          ],
        },
        { actorType: 'user', actorId: 'user-1' },
      );
    });

    const answers = await getAnswersForSet(db, setId);
    expect(answers).toHaveLength(4);
    const choiceOpt = answers.find((a) => a.question_key === 'choice_opt');
    expect(choiceOpt).toBeDefined();
    expect(choiceOpt!.value).toBe('a');
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-056: Optional questions may be omitted
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-056: Optional questions may be omitted', () => {
  it('omitting an optional answer does not prevent submission when all required are valid', async () => {
    const ctx = await freshRun('ans-opt-omit');
    const { db, runId } = ctx;

    await setRunStatus(db, runId, 'planning');
    const setId = await publishSet(db, runId, mixedQuestions(), 'planning');

    const answerService = new MissionAnswerSubmissionService(db);

    let result;
    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);
      result = await answerService.submitAnswers(
        tx,
        locked!,
        {
          questionSetId: setId,
          questionSetVersion: 1,
          answers: validRequiredAnswers(),
        },
        { actorType: 'user', actorId: 'user-1' },
      );
    });

    expect(result!.resumedStatus).toBe('planning');

    // Set is answered, run resumed.
    const set = await getQuestionSetRow(db, setId);
    expect(set!.status).toBe('answered');

    const run = await getRunRow(db, runId);
    expect(run!.status).toBe('planning');
  });

  it('omission is distinguishable from an explicitly submitted empty value', async () => {
    const ctx = await freshRun('ans-opt-empty');
    const { db, runId } = ctx;

    // Use questions where empty string is valid for optional text.
    const questions: unknown[] = [
      {
        questionKey: 'req_bool',
        order: 0,
        type: 'boolean',
        label: 'Required?',
        required: true,
      },
      {
        questionKey: 'opt_text',
        order: 1,
        type: 'text',
        label: 'Optional text?',
        required: false,
        validation: { minLength: 0, maxLength: 100 },
      },
    ];

    await setRunStatus(db, runId, 'planning');
    const setId = await publishSet(db, runId, questions, 'planning');

    const answerService = new MissionAnswerSubmissionService(db);

    // Submit with explicit empty string for opt_text.
    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);
      await answerService.submitAnswers(
        tx,
        locked!,
        {
          questionSetId: setId,
          questionSetVersion: 1,
          answers: [
            { questionKey: 'req_bool', value: true },
            { questionKey: 'opt_text', value: '' }, // explicit empty string
          ],
        },
        { actorType: 'user', actorId: 'user-1' },
      );
    });

    // The explicit empty string should be recorded as an answer.
    const answers = await getAnswersForSet(db, setId);
    expect(answers).toHaveLength(2);
    const optText = answers.find((a) => a.question_key === 'opt_text');
    expect(optText).toBeDefined();
    expect(optText!.value).toBe('');
  });

  it('omitting an optional question creates no answer row for it', async () => {
    const ctx = await freshRun('ans-opt-no-row');
    const { db, runId } = ctx;

    await setRunStatus(db, runId, 'planning');
    const setId = await publishSet(db, runId, mixedQuestions(), 'planning');

    const answerService = new MissionAnswerSubmissionService(db);

    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);
      await answerService.submitAnswers(
        tx,
        locked!,
        {
          questionSetId: setId,
          questionSetVersion: 1,
          answers: validRequiredAnswers(),
        },
        { actorType: 'user', actorId: 'user-1' },
      );
    });

    const answers = await getAnswersForSet(db, setId);
    // No answer row for omitted optional questions.
    expect(answers.find((a) => a.question_key === 'bool_opt')).toBeUndefined();
    expect(answers.find((a) => a.question_key === 'choice_opt')).toBeUndefined();
    expect(answers.find((a) => a.question_key === 'text_opt')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-057: Required questions block submission
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-057: Required questions block submission', () => {
  it('submitting with a required question unanswered fails without marking set answered', async () => {
    const ctx = await freshRun('ans-req-block');
    const { db, runId } = ctx;

    await setRunStatus(db, runId, 'planning');
    const setId = await publishSet(db, runId, mixedQuestions(), 'planning');

    // Omit bool_req (required) — should fail.
    const caught = (await expectSubmitError(db, runId, {
      questionSetId: setId,
      questionSetVersion: 1,
      answers: [
        { questionKey: 'choice_req', value: 'a' },
        { questionKey: 'text_req', value: 'done' },
        // bool_req omitted — required!
      ],
    })) as { status: number; code: string };

    expect(caught).toBeDefined();
    expect(caught.status).toBe(422);
    expect(caught.code).toBe('ANSWER_VALIDATION_FAILED');

    // Set remains open, run remains awaiting_input.
    const set = await getQuestionSetRow(db, setId);
    expect(set!.status).toBe('open');

    const run = await getRunRow(db, runId);
    expect(run!.status).toBe('awaiting_input');

    // No answers recorded.
    const answers = await getAnswersForSet(db, setId);
    expect(answers).toHaveLength(0);
  });

  it('the missing required question is identified in the error', async () => {
    const ctx = await freshRun('ans-req-identified');
    const { db, runId } = ctx;

    await setRunStatus(db, runId, 'planning');
    const setId = await publishSet(db, runId, mixedQuestions(), 'planning');

    const caught = (await expectSubmitError(db, runId, {
      questionSetId: setId,
      questionSetVersion: 1,
      answers: [
        { questionKey: 'choice_req', value: 'a' },
        { questionKey: 'text_req', value: 'done' },
      ],
    })) as { details?: { errors: Array<{ questionKey: string; rule: string }> } };

    expect(caught.details).toBeDefined();
    const missingError = caught.details!.errors.find((e) => e.questionKey === 'bool_req');
    expect(missingError).toBeDefined();
    expect(missingError!.rule).toContain('required');
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-062: Validation is field specific
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-062: Validation is field specific', () => {
  it('invalid answers produce 422 with safe details identifying every invalid question and rule', async () => {
    const ctx = await freshRun('ans-field-specific');
    const { db, runId } = ctx;

    const questions: unknown[] = [
      {
        questionKey: 'bool_req',
        order: 0,
        type: 'boolean',
        label: 'Required boolean?',
        required: true,
      },
      {
        questionKey: 'choice_req',
        order: 1,
        type: 'single_choice',
        label: 'Required choice?',
        required: true,
        options: [
          { key: 'a', label: 'A' },
          { key: 'b', label: 'B' },
        ],
      },
      {
        questionKey: 'num_req',
        order: 2,
        type: 'number',
        label: 'Required number?',
        required: true,
        validation: { min: 1, max: 10, step: 1 },
      },
    ];

    await setRunStatus(db, runId, 'planning');
    const setId = await publishSet(db, runId, questions, 'planning');

    const caught = (await expectSubmitError(db, runId, {
      questionSetId: setId,
      questionSetVersion: 1,
      answers: [
        { questionKey: 'bool_req', value: 'not-a-boolean' }, // invalid type
        { questionKey: 'choice_req', value: 'unknown_key' }, // unknown key
        { questionKey: 'num_req', value: 15 }, // out of range
      ],
    })) as {
      status: number;
      code: string;
      details?: { errors: Array<{ questionKey: string; rule: string }> };
    };

    expect(caught.status).toBe(422);
    expect(caught.code).toBe('ANSWER_VALIDATION_FAILED');
    expect(caught.details).toBeDefined();
    expect(caught.details!.errors).toHaveLength(3);

    // Each invalid question is identified with its specific rule.
    const boolError = caught.details!.errors.find((e) => e.questionKey === 'bool_req');
    expect(boolError).toBeDefined();
    expect(boolError!.rule).toContain('boolean');

    const choiceError = caught.details!.errors.find((e) => e.questionKey === 'choice_req');
    expect(choiceError).toBeDefined();
    expect(choiceError!.rule).toContain('listed option key');

    const numError = caught.details!.errors.find((e) => e.questionKey === 'num_req');
    expect(numError).toBeDefined();
    expect(numError!.rule).toContain('at most');
  });

  it('error details do not expose prompts, secrets, or unrelated answers', async () => {
    const ctx = await freshRun('ans-no-leak');
    const { db, runId } = ctx;

    const questions: unknown[] = [
      {
        questionKey: 'req_bool',
        order: 0,
        type: 'boolean',
        label: 'Required boolean?',
        required: true,
      },
      {
        questionKey: 'req_text',
        order: 1,
        type: 'text',
        label: 'Required text?',
        required: true,
        validation: { minLength: 3, maxLength: 10 },
      },
    ];

    await setRunStatus(db, runId, 'planning');
    const setId = await publishSet(db, runId, questions, 'planning');

    const caught = (await expectSubmitError(db, runId, {
      questionSetId: setId,
      questionSetVersion: 1,
      answers: [
        { questionKey: 'req_bool', value: true }, // valid
        { questionKey: 'req_text', value: 'ab' }, // too short
      ],
    })) as { details?: { errors: Array<{ questionKey: string; rule: string }> } };

    // Only the invalid question is in the errors — the valid one is not exposed.
    expect(caught.details!.errors).toHaveLength(1);
    expect(caught.details!.errors[0].questionKey).toBe('req_text');
    // The rule should not contain the valid answer value.
    expect(caught.details!.errors[0].rule).not.toContain('true');
    // No secret-like strings in the error.
    const errorJson = JSON.stringify(caught);
    expect(errorJson).not.toContain('password');
    expect(errorJson).not.toContain('secret');
    expect(errorJson).not.toContain('api_key');
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-063: Validation failure is atomic
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-063: Validation failure is atomic', () => {
  it('mixed valid/invalid submission commits none of the answers', async () => {
    const ctx = await freshRun('ans-atomic-fail');
    const { db, runId } = ctx;

    const questions: unknown[] = [
      {
        questionKey: 'req_bool',
        order: 0,
        type: 'boolean',
        label: 'Required boolean?',
        required: true,
      },
      {
        questionKey: 'req_choice',
        order: 1,
        type: 'single_choice',
        label: 'Required choice?',
        required: true,
        options: [
          { key: 'a', label: 'A' },
          { key: 'b', label: 'B' },
        ],
      },
    ];

    await setRunStatus(db, runId, 'planning');
    const setId = await publishSet(db, runId, questions, 'planning');

    await expectSubmitError(db, runId, {
      questionSetId: setId,
      questionSetVersion: 1,
      answers: [
        { questionKey: 'req_bool', value: true }, // valid
        { questionKey: 'req_choice', value: 'invalid_key' }, // invalid
      ],
    });

    // No partial commit: no answers, set open, run awaiting_input.
    const answers = await getAnswersForSet(db, setId);
    expect(answers).toHaveLength(0);

    const set = await getQuestionSetRow(db, setId);
    expect(set!.status).toBe('open');

    const run = await getRunRow(db, runId);
    expect(run!.status).toBe('awaiting_input');
  });

  it('no questions.answered or run.status_changed event is appended on failure', async () => {
    const ctx = await freshRun('ans-atomic-fail-events');
    const { db, runId } = ctx;

    await setRunStatus(db, runId, 'planning');
    const setId = await publishSet(db, runId, mixedQuestions(), 'planning');

    // Capture events before the failed submission.
    const eventsBefore = await getEvents(db, runId);
    const seqBefore = eventsBefore[eventsBefore.length - 1]?.sequence ?? 0;

    await expectSubmitError(db, runId, {
      questionSetId: setId,
      questionSetVersion: 1,
      answers: [
        { questionKey: 'bool_req', value: 'invalid' },
        { questionKey: 'choice_req', value: 'a' },
        { questionKey: 'text_req', value: 'done' },
      ],
    });

    const eventsAfter = await getEvents(db, runId);
    // No new events should have been appended.
    expect(eventsAfter.length).toBe(eventsBefore.length);
    const answeredEvents = eventsAfter.filter((e) => e.type === 'questions.answered');
    expect(answeredEvents).toHaveLength(0);
    // Last event sequence should be unchanged.
    const seqAfter = eventsAfter[eventsAfter.length - 1]?.sequence ?? 0;
    expect(seqAfter).toBe(seqBefore);
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-064: Successful answer is atomic
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-064: Successful answer is atomic', () => {
  it('a valid submission records all answers, closes the set, and appends exactly one questions.answered and one run.status_changed', async () => {
    const ctx = await freshRun('ans-atomic-success');
    const { db, runId } = ctx;

    await setRunStatus(db, runId, 'planning');
    const setId = await publishSet(db, runId, mixedQuestions(), 'planning');

    const answerService = new MissionAnswerSubmissionService(db);

    let result;
    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);
      result = await answerService.submitAnswers(
        tx,
        locked!,
        {
          questionSetId: setId,
          questionSetVersion: 1,
          answers: validRequiredAnswers(),
        },
        { actorType: 'user', actorId: 'user-1' },
      );
    });

    // All 3 supplied answers recorded.
    const answers = await getAnswersForSet(db, setId);
    expect(answers).toHaveLength(3);

    // Set is answered.
    const set = await getQuestionSetRow(db, setId);
    expect(set!.status).toBe('answered');
    expect(set!.answered_at).not.toBeNull();

    // State version incremented for the resume transition.
    expect(result!.stateVersion).toBeGreaterThan(1);

    // Events: exactly one questions.answered and one run.status_changed,
    // contiguous, in order.
    const events = await getEvents(db, runId);
    const answeredEvents = events.filter((e) => e.type === 'questions.answered');
    expect(answeredEvents).toHaveLength(1);

    const resumeStatusChanged = events.find(
      (e) =>
        e.type === 'run.status_changed' &&
        (e.payload as { from?: string }).from === 'awaiting_input' &&
        (e.payload as { to?: string }).to === 'planning',
    );
    expect(resumeStatusChanged).toBeDefined();

    // questions.answered sequence is immediately before run.status_changed.
    expect(answeredEvents[0]!.sequence).toBeLessThan(resumeStatusChanged!.sequence);
    expect(resumeStatusChanged!.sequence - answeredEvents[0]!.sequence).toBe(1);
  });

  it('no partial state is exposed: run is in resumed status with set answered', async () => {
    const ctx = await freshRun('ans-no-partial');
    const { db, runId } = ctx;

    await setRunStatus(db, runId, 'planning');
    const setId = await publishSet(db, runId, mixedQuestions(), 'planning');

    const answerService = new MissionAnswerSubmissionService(db);

    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);
      await answerService.submitAnswers(
        tx,
        locked!,
        {
          questionSetId: setId,
          questionSetVersion: 1,
          answers: validRequiredAnswers(),
        },
        { actorType: 'user', actorId: 'user-1' },
      );
    });

    const run = await getRunRow(db, runId);
    expect(run!.status).toBe('planning');
    expect(run!.current_question_set_id).toBeNull(); // pointer cleared after answer
    expect(run!.waiting_from_status).toBeNull(); // cleared on resume
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-065: Planning question resumes planning
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-065: Planning question resumes planning', () => {
  it('answering a set whose waiting origin is planning resumes the same run in planning', async () => {
    const ctx = await freshRun('ans-resume-planning');
    const { db, runId } = ctx;

    await setRunStatus(db, runId, 'planning');
    const setId = await publishSet(db, runId, mixedQuestions(), 'planning');

    const answerService = new MissionAnswerSubmissionService(db);

    let result;
    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);
      result = await answerService.submitAnswers(
        tx,
        locked!,
        {
          questionSetId: setId,
          questionSetVersion: 1,
          answers: validRequiredAnswers(),
        },
        { actorType: 'user', actorId: 'user-1' },
      );
    });

    // Same run ID, resumed to planning (not running, not a new run).
    expect(result!.resumedStatus).toBe('planning');

    const run = await getRunRow(db, runId);
    expect(run!.status).toBe('planning');
    expect(run!.id).toBe(runId);
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-066: Runtime question resumes running
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-066: Runtime question resumes running', () => {
  it('answering a set whose waiting origin is running resumes the same run in running', async () => {
    const ctx = await freshRun('ans-resume-running');
    const { db, runId } = ctx;

    // Set up as running with prior progress.
    await db.drizzle.execute(sql`
      UPDATE "mission_runs"
      SET "status" = 'running',
          "provider_call_count" = 5,
          "input_tokens" = 1000,
          "output_tokens" = 500,
          "updated_at" = ${new Date()}
      WHERE "id" = ${runId}
    `);

    const setId = await publishSet(db, runId, mixedQuestions(), 'running');

    const answerService = new MissionAnswerSubmissionService(db);

    let result;
    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);
      result = await answerService.submitAnswers(
        tx,
        locked!,
        {
          questionSetId: setId,
          questionSetVersion: 1,
          answers: validRequiredAnswers(),
        },
        { actorType: 'user', actorId: 'user-1' },
      );
    });

    // Same run ID, resumed to running.
    expect(result!.resumedStatus).toBe('running');

    const run = await getRunRow(db, runId);
    expect(run!.status).toBe('running');
    expect(run!.id).toBe(runId);

    // Prior progress is retained (not restarted).
    expect(Number(run!.provider_call_count)).toBe(5);
    expect(Number(run!.input_tokens)).toBe(1000);
    expect(Number(run!.output_tokens)).toBe(500);
  });

  it('runtime resume makes the run available for worker claiming', async () => {
    const ctx = await freshRun('ans-resume-running-claim');
    const { db, runId } = ctx;

    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "status" = 'running' WHERE "id" = ${runId}
    `);

    const setId = await publishSet(db, runId, mixedQuestions(), 'running');

    const answerService = new MissionAnswerSubmissionService(db);

    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);
      await answerService.submitAnswers(
        tx,
        locked!,
        {
          questionSetId: setId,
          questionSetVersion: 1,
          answers: validRequiredAnswers(),
        },
        { actorType: 'user', actorId: 'user-1' },
      );
    });

    const run = await getRunRow(db, runId);
    // availableAt should be set so a worker can claim it.
    expect(run!.available_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-067: Exact answers enter resume context
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-067: Exact answers enter resume context', () => {
  it('the questions.answered event includes exact answer references by question key and content hash', async () => {
    const ctx = await freshRun('ans-exact-context');
    const { db, runId } = ctx;

    await setRunStatus(db, runId, 'planning');
    const setId = await publishSet(db, runId, mixedQuestions(), 'planning');

    const answerService = new MissionAnswerSubmissionService(db);

    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);
      await answerService.submitAnswers(
        tx,
        locked!,
        {
          questionSetId: setId,
          questionSetVersion: 1,
          answers: validRequiredAnswers(),
        },
        { actorType: 'user', actorId: 'user-1' },
      );
    });

    // The questions.answered event should contain the exact accepted answer
    // references (questionKey, answerRevision, contentHash).
    const events = await getEvents(db, runId);
    const answeredEvent = events.find((e) => e.type === 'questions.answered');
    expect(answeredEvent).toBeDefined();

    const payload = answeredEvent!.payload as {
      questionSetId: string;
      version: number;
      acceptedAnswers: Array<{
        questionKey: string;
        answerRevision: number;
        contentHash: string;
      }>;
    };

    expect(payload.questionSetId).toBe(setId);
    expect(payload.version).toBe(1);
    expect(payload.acceptedAnswers).toHaveLength(3);

    // Verify the content hashes match the canonical hash of the values.
    const boolRef = payload.acceptedAnswers.find((a) => a.questionKey === 'bool_req');
    expect(boolRef).toBeDefined();
    expect(boolRef!.answerRevision).toBe(1);
    expect(boolRef!.contentHash).toBe(canonicalHash(true));

    const choiceRef = payload.acceptedAnswers.find((a) => a.questionKey === 'choice_req');
    expect(choiceRef).toBeDefined();
    expect(choiceRef!.contentHash).toBe(canonicalHash('a'));

    const textRef = payload.acceptedAnswers.find((a) => a.questionKey === 'text_req');
    expect(textRef).toBeDefined();
    expect(textRef!.contentHash).toBe(canonicalHash('done'));
  });

  it('answer rows store the exact content hash for later context reconstruction', async () => {
    const ctx = await freshRun('ans-exact-hash');
    const { db, runId, companyId } = ctx;

    await setRunStatus(db, runId, 'planning');
    const setId = await publishSet(db, runId, mixedQuestions(), 'planning');

    const answerService = new MissionAnswerSubmissionService(db);

    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);
      await answerService.submitAnswers(
        tx,
        locked!,
        {
          questionSetId: setId,
          questionSetVersion: 1,
          answers: validRequiredAnswers(),
        },
        { actorType: 'user', actorId: 'user-1' },
      );
    });

    const answers = await getAnswersForSet(db, setId);
    const boolAnswer = answers.find((a) => a.question_key === 'bool_req');
    expect(boolAnswer!.content_hash).toBe(canonicalHash(true));
    expect(boolAnswer!.answer_revision).toBe(1);

    // readAnswersForSet returns the same data for context reconstruction.
    const readService = new MissionAnswerSubmissionService(db);
    const readAnswers = await readService.readAnswersForSet(companyId, setId);
    expect(readAnswers).toHaveLength(3);
    expect(readAnswers[0]!.contentHash).toBe(canonicalHash(true));
  });

  it('text answers are NFC-normalized and the hash reflects the normalized value', async () => {
    const ctx = await freshRun('ans-nfc-hash');
    const { db, runId } = ctx;

    const questions: unknown[] = [
      {
        questionKey: 'req_text',
        order: 0,
        type: 'text',
        label: 'Required text?',
        required: true,
        validation: { maxLength: 100 },
      },
    ];

    await setRunStatus(db, runId, 'planning');
    const setId = await publishSet(db, runId, questions, 'planning');

    const answerService = new MissionAnswerSubmissionService(db);

    // Submit text with a combining character sequence that has an NFC form.
    const nfcInput = 'caf\u00e9'; // NFC: é as single codepoint
    const nfdInput = 'cafe\u0301'; // NFD: e + combining acute

    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);
      await answerService.submitAnswers(
        tx,
        locked!,
        {
          questionSetId: setId,
          questionSetVersion: 1,
          answers: [{ questionKey: 'req_text', value: nfdInput }],
        },
        { actorType: 'user', actorId: 'user-1' },
      );
    });

    const answers = await getAnswersForSet(db, setId);
    const textAnswer = answers.find((a) => a.question_key === 'req_text');
    // The stored value should be NFC-normalized.
    expect(textAnswer!.value).toBe(nfcInput);
    // The hash should be of the NFC-normalized value.
    expect(textAnswer!.content_hash).toBe(canonicalHash(nfcInput));
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-069: Answered questions cannot be edited silently
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-069: Answered questions cannot be edited silently', () => {
  it('submitting answers to an already-answered set returns INVALID_RUN_STATE', async () => {
    const ctx = await freshRun('ans-no-edit');
    const { db, runId } = ctx;

    await setRunStatus(db, runId, 'planning');
    const setId = await publishSet(db, runId, mixedQuestions(), 'planning');

    const answerService = new MissionAnswerSubmissionService(db);

    // First submission: valid, closes the set.
    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);
      await answerService.submitAnswers(
        tx,
        locked!,
        {
          questionSetId: setId,
          questionSetVersion: 1,
          answers: validRequiredAnswers(),
        },
        { actorType: 'user', actorId: 'user-1' },
      );
    });

    // The set is answered, so a second submission should reject with
    // INVALID_RUN_STATE. We override the run row to simulate an edit attempt
    // from awaiting_input with the answered set.
    const caught = (await expectSubmitErrorWithRun(
      db,
      runId,
      { status: 'awaiting_input', currentQuestionSetId: setId },
      {
        questionSetId: setId,
        questionSetVersion: 1,
        answers: [
          { questionKey: 'bool_req', value: false }, // changed!
          { questionKey: 'choice_req', value: 'b' },
          { questionKey: 'text_req', value: 'changed' },
        ],
      },
    )) as { status: number; code: string };

    expect(caught).toBeDefined();
    expect(caught.status).toBe(409);
    expect(caught.code).toBe('INVALID_RUN_STATE');
  });

  it('the answer history remains unchanged after a rejected edit attempt', async () => {
    const ctx = await freshRun('ans-no-edit-history');
    const { db, runId } = ctx;

    await setRunStatus(db, runId, 'planning');
    const setId = await publishSet(db, runId, mixedQuestions(), 'planning');

    const answerService = new MissionAnswerSubmissionService(db);

    // First submission with 'original' as the text answer.
    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);
      await answerService.submitAnswers(
        tx,
        locked!,
        {
          questionSetId: setId,
          questionSetVersion: 1,
          answers: [
            { questionKey: 'bool_req', value: true },
            { questionKey: 'choice_req', value: 'a' },
            { questionKey: 'text_req', value: 'original' },
          ],
        },
        { actorType: 'user', actorId: 'user-1' },
      );
    });

    const answersBefore = await getAnswersForSet(db, setId);
    const originalText = answersBefore.find((a) => a.question_key === 'text_req');
    expect(originalText!.value).toBe('original');

    // Attempt edit (rejected).
    await expectSubmitErrorWithRun(
      db,
      runId,
      { status: 'awaiting_input', currentQuestionSetId: setId },
      {
        questionSetId: setId,
        questionSetVersion: 1,
        answers: [
          { questionKey: 'bool_req', value: false },
          { questionKey: 'choice_req', value: 'b' },
          { questionKey: 'text_req', value: 'changed' },
        ],
      },
    );

    // History unchanged.
    const answersAfter = await getAnswersForSet(db, setId);
    expect(answersAfter).toHaveLength(answersBefore.length);
    const textAfter = answersAfter.find((a) => a.question_key === 'text_req');
    expect(textAfter!.value).toBe('original');
    expect(textAfter!.answer_revision).toBe(1);
  });

  it('attempting answers from a non-awaiting_input state returns INVALID_RUN_STATE', async () => {
    const ctx = await freshRun('ans-no-edit-running');
    const { db, runId } = ctx;

    await setRunStatus(db, runId, 'planning');
    const setId = await publishSet(db, runId, mixedQuestions(), 'planning');

    const answerService = new MissionAnswerSubmissionService(db);

    // First submission.
    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);
      await answerService.submitAnswers(
        tx,
        locked!,
        {
          questionSetId: setId,
          questionSetVersion: 1,
          answers: validRequiredAnswers(),
        },
        { actorType: 'user', actorId: 'user-1' },
      );
    });

    // The run is now in planning (resumed). Attempting to submit answers
    // while the run is in planning (not awaiting_input) should fail.
    const caught = (await expectSubmitErrorWithRun(
      db,
      runId,
      { status: 'planning' }, // not awaiting_input
      {
        questionSetId: setId,
        questionSetVersion: 1,
        answers: [
          { questionKey: 'bool_req', value: false },
          { questionKey: 'choice_req', value: 'b' },
          { questionKey: 'text_req', value: 'changed' },
        ],
      },
    )) as { code: string };

    expect(caught).toBeDefined();
    expect(caught.code).toBe('INVALID_RUN_STATE');
  });
});

// ---------------------------------------------------------------------------
// Additional: Invalidated set cannot accept answers
// ---------------------------------------------------------------------------

describe('Invalidated set cannot accept answers', () => {
  it('submitting answers to an invalidated set returns QUESTION_SET_INVALIDATED', async () => {
    const ctx = await freshRun('ans-invalidated');
    const { db, runId } = ctx;

    await setRunStatus(db, runId, 'planning');
    const setId = await publishSet(db, runId, mixedQuestions(), 'planning');

    // Invalidate the set manually.
    await db.drizzle.execute(sql`
      UPDATE "run_question_sets" SET "status" = 'invalidated', "invalidation_reason" = 'replaced'
      WHERE "id" = ${setId}
    `);

    const caught = (await expectSubmitError(db, runId, {
      questionSetId: setId,
      questionSetVersion: 1,
      answers: validRequiredAnswers(),
    })) as { code: string };

    expect(caught).toBeDefined();
    expect(caught.code).toBe('QUESTION_SET_INVALIDATED');
  });
});

// ---------------------------------------------------------------------------
// Additional: Wrong question set (belongs to another run)
// ---------------------------------------------------------------------------

describe('Wrong-run question set is rejected', () => {
  it('a question set belonging to another run returns 404', async () => {
    // Use a single db/app instance with two scopes and two runs, since
    // createTestDb() truncates on the second call.
    enableMissionFlag();
    const db = await createTestDb();
    const app = await createTestServer(db);

    const scopeA = await seedScope(db, 'ans-wrong-a');
    const scopeB = await seedScope(db, 'ans-wrong-b');

    const baseA = `/api/companies/${scopeA.companyId}/projects/${scopeA.projectId}/mission-runs`;
    const baseB = `/api/companies/${scopeB.companyId}/projects/${scopeB.projectId}/mission-runs`;

    const startA = await request(app)
      .post(baseA)
      .set('Idempotency-Key', `ans-wrong-a-${randomUUID()}`)
      .send({ projectThreadId: scopeA.threadId, mode: 'fast', request: { text: 'A' } })
      .expect(202);
    const runAId = startA.body.data.run.id as string;

    const startB = await request(app)
      .post(baseB)
      .set('Idempotency-Key', `ans-wrong-b-${randomUUID()}`)
      .send({ projectThreadId: scopeB.threadId, mode: 'fast', request: { text: 'B' } })
      .expect(202);
    const runBId = startB.body.data.run.id as string;

    // Publish a set for run A.
    await setRunStatus(db, runAId, 'planning');
    const setIdA = await publishSet(db, runAId, mixedQuestions(), 'planning');

    // Publish a set for run B (so run B has its own open set).
    await setRunStatus(db, runBId, 'planning');
    await publishSet(db, runBId, mixedQuestions(), 'planning');

    // Try to answer run A's set through run B.
    const answerService = new MissionAnswerSubmissionService(db);
    let caught: unknown;
    await db.drizzle
      .transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(db.schema.missionRuns)
          .where(eq(db.schema.missionRuns.id, runBId))
          .for('update')
          .limit(1);
        try {
          await answerService.submitAnswers(
            tx,
            locked!,
            {
              questionSetId: setIdA, // belongs to run A!
              questionSetVersion: 1,
              answers: validRequiredAnswers(),
            },
            { actorType: 'user', actorId: 'user-1' },
          );
        } catch (e) {
          caught = e;
          throw e;
        }
      })
      .catch(() => {
        // Expected.
      });

    expect(caught).toBeDefined();
    expect((caught as { code: string }).code).toBe('RUN_NOT_FOUND');

    await closeTestServers();
  });
});

// ---------------------------------------------------------------------------
// Additional: Stale question set version
// ---------------------------------------------------------------------------

describe('Stale question set version is rejected', () => {
  it('submitting with a stale version returns QUESTION_SET_VERSION_MISMATCH', async () => {
    const ctx = await freshRun('ans-stale-version');
    const { db, runId } = ctx;

    await setRunStatus(db, runId, 'planning');
    const setId = await publishSet(db, runId, mixedQuestions(), 'planning');

    // Bump the set version to simulate a definition change.
    await db.drizzle.execute(sql`
      UPDATE "run_question_sets" SET "version" = 2 WHERE "id" = ${setId}
    `);

    const caught = (await expectSubmitError(db, runId, {
      questionSetId: setId,
      questionSetVersion: 1, // stale!
      answers: validRequiredAnswers(),
    })) as { code: string };

    expect(caught).toBeDefined();
    expect(caught.code).toBe('QUESTION_SET_VERSION_MISMATCH');
  });
});

// ---------------------------------------------------------------------------
// Additional: Pure validation pass (no database writes)
// ---------------------------------------------------------------------------

describe('Pure validation pass', () => {
  it('validates all answers without touching the database', async () => {
    const ctx = await freshRun('ans-pure-validation');
    const { db, runId } = ctx;

    await setRunStatus(db, runId, 'planning');
    const setId = await publishSet(db, runId, mixedQuestions(), 'planning');

    // Load question definitions using the typed Drizzle query builder.
    const questionRows = await getTypedQuestions(db, setId);

    const answerService = new MissionAnswerSubmissionService(db);
    const result = answerService.validateAllAnswers(questionRows, validRequiredAnswers());

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.validated.size).toBe(3);
  });

  it('returns field-specific errors for invalid answers', async () => {
    const ctx = await freshRun('ans-pure-validation-errors');
    const { db, runId } = ctx;

    await setRunStatus(db, runId, 'planning');
    const setId = await publishSet(db, runId, mixedQuestions(), 'planning');

    const questionRows = await getTypedQuestions(db, setId);

    const answerService = new MissionAnswerSubmissionService(db);
    const result = answerService.validateAllAnswers(questionRows, [
      { questionKey: 'bool_req', value: 'not-bool' },
      { questionKey: 'choice_req', value: 'a' },
      { questionKey: 'text_req', value: 'ab' }, // too short
    ]);

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
    const boolErr = result.errors.find((e) => e.questionKey === 'bool_req');
    expect(boolErr).toBeDefined();
    const textErr = result.errors.find((e) => e.questionKey === 'text_req');
    expect(textErr).toBeDefined();
  });
});
