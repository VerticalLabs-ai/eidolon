import { describe, expect, it, afterEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer, closeTestServers } from '../test-utils.js';
import { MissionQuestionPublicationService } from '../services/mission/question-publication.js';

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
    .set('Idempotency-Key', `ans-guard-${randomUUID()}`)
    .send({ projectThreadId: threadId, mode: 'fast', request: { text } })
    .expect(202);
  return {
    db,
    app,
    companyId,
    projectId,
    threadId,
    runId: start.body.data.run.id as string,
    stateVersion: start.body.data.run.stateVersion as number,
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

async function getRunRow(db: AnyDb, runId: string) {
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

async function getEvents(db: AnyDb, runId: string, type?: string) {
  const q = type
    ? sql`SELECT "sequence", "type", "payload", "actor_type", "actor_id" FROM "run_events" WHERE "run_id" = ${runId} AND "type" = ${type} ORDER BY "sequence" ASC`
    : sql`SELECT "sequence", "type", "payload", "actor_type", "actor_id" FROM "run_events" WHERE "run_id" = ${runId} ORDER BY "sequence" ASC`;
  const rows = (await db.drizzle.execute(q)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    sequence: Number(r.sequence),
    type: r.type as string,
    payload: r.payload as Record<string, unknown>,
    actorType: r.actor_type as string,
    actorId: r.actor_id as string | null,
  }));
}

async function getAnswersForSet(db: AnyDb, setId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT * FROM "run_question_answers"
    WHERE "question_set_id" = ${setId}
    ORDER BY "question_key" ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows;
}

async function countCommands(db: AnyDb, runId: string): Promise<number> {
  const [row] = (await db.drizzle.execute(
    sql`SELECT count(*)::int AS c FROM "run_commands" WHERE "run_id" = ${runId}`,
  )) as unknown as { c: number }[];
  return row.c;
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
 * Set up a run in awaiting_input with a published question set and return
 * the current authoritative state version for If-Match preconditions.
 * publishQuestionSet transitions the run to awaiting_input and bumps
 * state_version, so the caller must use the post-publish version.
 */
async function setupAwaitingInput(
  db: AnyDb,
  runId: string,
  questions: unknown[] = mixedQuestions(),
  waitingFromStatus: 'planning' | 'running' = 'planning',
): Promise<{ setId: string; stateVersion: number }> {
  // Ensure the run is in a state that allows publishing (planning or running).
  await setRunStatus(db, runId, waitingFromStatus);
  const setId = await publishSet(db, runId, questions, waitingFromStatus);
  // publishQuestionSet already transitions to awaiting_input and bumps
  // state_version. Read the authoritative version for If-Match.
  const run = await getRunRow(db, runId);
  return { setId, stateVersion: run!.state_version as number };
}

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
      questionKey: 'text_req',
      order: 2,
      type: 'text',
      label: 'Required text?',
      required: true,
      validation: { minLength: 3, maxLength: 100 },
    },
  ];
}

function validAnswersRecord(): Record<string, unknown> {
  return {
    bool_req: true,
    choice_req: 'a',
    text_req: 'done',
  };
}

const etag = (v: number): string => `"${v}"`;

afterEach(async () => {
  await closeTestServers();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-070: Duplicate answer replay
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-070: Duplicate answer replay (convenience route)', () => {
  it('repeating the identical answer request with the same key returns the original result and creates no extra event/revision', async () => {
    const ctx = await freshRun('guard-replay');
    const { db, app, runId, base } = ctx;

    const { setId, stateVersion } = await setupAwaitingInput(db, runId);

    const key = `replay-${randomUUID()}`;
    const answerBody = {
      questionSetId: setId,
      questionSetVersion: 1,
      answers: validAnswersRecord(),
    };

    // First submission.
    const r1 = await request(app)
      .post(`${base}/${runId}/answers`)
      .set('Idempotency-Key', key)
      .set('If-Match', etag(stateVersion))
      .send(answerBody)
      .expect(200);

    const answeredEventsBefore = await getEvents(db, runId, 'questions.answered');
    const answersBefore = await getAnswersForSet(db, setId);
    const runBefore = await getRunRow(db, runId);

    // Second submission with the same key and same body.
    const r2 = await request(app)
      .post(`${base}/${runId}/answers`)
      .set('Idempotency-Key', key)
      .set('If-Match', etag(r1.body.data.run.stateVersion))
      .send(answerBody)
      .expect(200);

    // The replay returns the original result — same run state version.
    expect(r2.body.data.run.stateVersion).toBe(r1.body.data.run.stateVersion);

    // No extra answered event.
    const answeredEventsAfter = await getEvents(db, runId, 'questions.answered');
    expect(answeredEventsAfter).toHaveLength(answeredEventsBefore.length);

    // No extra answer revisions.
    const answersAfter = await getAnswersForSet(db, setId);
    expect(answersAfter).toHaveLength(answersBefore.length);

    // Run state unchanged after replay.
    const runAfter = await getRunRow(db, runId);
    expect(runAfter!.state_version).toBe(runBefore!.state_version);
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-071: Reused key with changed answers
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-071: Reused key with changed answers (convenience route)', () => {
  it('reusing an answer idempotency key with different content returns 409 IDEMPOTENCY_KEY_REUSED and does not alter the original answers', async () => {
    const ctx = await freshRun('guard-reuse');
    const { db, app, runId, base } = ctx;

    const { setId, stateVersion } = await setupAwaitingInput(db, runId);

    const key = `reuse-${randomUUID()}`;
    const answerBody = {
      questionSetId: setId,
      questionSetVersion: 1,
      answers: validAnswersRecord(),
    };

    // First submission succeeds.
    const r1 = await request(app)
      .post(`${base}/${runId}/answers`)
      .set('Idempotency-Key', key)
      .set('If-Match', etag(stateVersion))
      .send(answerBody)
      .expect(200);

    const answersAfterFirst = await getAnswersForSet(db, setId);
    const runAfterFirst = await getRunRow(db, runId);

    // Reuse the same key with changed answer content.
    const changedBody = {
      questionSetId: setId,
      questionSetVersion: 1,
      answers: { ...validAnswersRecord(), bool_req: false },
    };

    const r2 = await request(app)
      .post(`${base}/${runId}/answers`)
      .set('Idempotency-Key', key)
      .set('If-Match', etag(r1.body.data.run.stateVersion))
      .send(changedBody)
      .expect(409);

    expect(r2.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // Original answers and run state unchanged.
    const answersAfterConflict = await getAnswersForSet(db, setId);
    expect(answersAfterConflict).toHaveLength(answersAfterFirst.length);
    const boolAnswer = answersAfterConflict.find((a) => a.question_key === 'bool_req');
    expect(boolAnswer!.value).toBe(true); // original, not changed to false

    const runAfterConflict = await getRunRow(db, runId);
    expect(runAfterConflict!.state_version).toBe(runAfterFirst!.state_version);
    expect(runAfterConflict!.status).toBe(runAfterFirst!.status);
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-074: Missing answer precondition is rejected
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-074: Missing answer precondition is rejected', () => {
  it('an answer without If-Match returns 428 PRECONDITION_REQUIRED and makes no state or answer change', async () => {
    const ctx = await freshRun('guard-missing-precondition');
    const { db, app, runId, base } = ctx;

    const { setId } = await setupAwaitingInput(db, runId);

    const runBefore = await getRunRow(db, runId);

    const r = await request(app)
      .post(`${base}/${runId}/answers`)
      .set('Idempotency-Key', `noprecond-${randomUUID()}`)
      // No If-Match header
      .send({
        questionSetId: setId,
        questionSetVersion: 1,
        answers: validAnswersRecord(),
      })
      .expect(428);

    expect(r.body.code).toBe('PRECONDITION_REQUIRED');

    // No state or answer change.
    const runAfter = await getRunRow(db, runId);
    expect(runAfter!.state_version).toBe(runBefore!.state_version);
    expect(runAfter!.status).toBe('awaiting_input');

    const answers = await getAnswersForSet(db, setId);
    expect(answers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-075: Stale question-set version is rejected
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-075: Stale question-set version is rejected', () => {
  it('an answer naming the current set with a stale version returns 409 QUESTION_SET_VERSION_MISMATCH', async () => {
    const ctx = await freshRun('guard-stale-version');
    const { db, app, runId, base } = ctx;

    const { setId, stateVersion } = await setupAwaitingInput(db, runId);

    // Bump the set version to simulate a definition change.
    await db.drizzle.execute(sql`
      UPDATE "run_question_sets" SET "version" = 2 WHERE "id" = ${setId}
    `);

    const runBefore = await getRunRow(db, runId);

    const r = await request(app)
      .post(`${base}/${runId}/answers`)
      .set('Idempotency-Key', `stalever-${randomUUID()}`)
      .set('If-Match', etag(stateVersion))
      .send({
        questionSetId: setId,
        questionSetVersion: 1, // stale!
        answers: validAnswersRecord(),
      })
      .expect(409);

    expect(r.body.code).toBe('QUESTION_SET_VERSION_MISMATCH');

    // No state or answer change.
    const runAfter = await getRunRow(db, runId);
    expect(runAfter!.state_version).toBe(runBefore!.state_version);
    expect(runAfter!.status).toBe('awaiting_input');

    const answers = await getAnswersForSet(db, setId);
    expect(answers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-077: Wrong-run question set is rejected
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-077: Wrong-run question set is rejected', () => {
  it('a question set belonging to another run cannot be answered through the target run and returns 404', async () => {
    const ctx = await freshRun('guard-wrong-run');
    const { db, app, runId, base } = ctx;

    // Create a second run in the same scope to own the "other" question set.
    const otherKey = `other-run-${randomUUID()}`;
    const otherStart = await request(app)
      .post(base)
      .set('Idempotency-Key', otherKey)
      .send({ projectThreadId: ctx.threadId, mode: 'fast', request: { text: 'Other' } })
      .expect(202);
    const otherRunId = otherStart.body.data.run.id as string;

    const { setId: otherSetId } = await setupAwaitingInput(db, otherRunId);

    // Target run is also awaiting_input with its own set.
    const { stateVersion } = await setupAwaitingInput(db, runId);

    const runBefore = await getRunRow(db, runId);

    // Try to answer the OTHER run's set through the TARGET run.
    const r = await request(app)
      .post(`${base}/${runId}/answers`)
      .set('Idempotency-Key', `wrongset-${randomUUID()}`)
      .set('If-Match', etag(stateVersion))
      .send({
        questionSetId: otherSetId,
        questionSetVersion: 1,
        answers: validAnswersRecord(),
      })
      .expect(404);

    expect(r.body.code).toBe('RUN_NOT_FOUND');

    // Target run unchanged.
    const runAfter = await getRunRow(db, runId);
    expect(runAfter!.state_version).toBe(runBefore!.state_version);
    expect(runAfter!.status).toBe('awaiting_input');

    // Other run also unchanged.
    const otherRun = await getRunRow(db, otherRunId);
    expect(otherRun!.status).toBe('awaiting_input');
    const otherAnswers = await getAnswersForSet(db, otherSetId);
    expect(otherAnswers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-078: New-key repeat after answer is rejected
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-078: New-key repeat after answer is rejected', () => {
  it('resubmitting an answered set under a new key returns 409 INVALID_RUN_STATE; same-key replay still wins earlier', async () => {
    const ctx = await freshRun('guard-repeat');
    const { db, app, runId, base } = ctx;

    const { setId, stateVersion } = await setupAwaitingInput(db, runId);

    const key1 = `repeat-1-${randomUUID()}`;
    const answerBody = {
      questionSetId: setId,
      questionSetVersion: 1,
      answers: validAnswersRecord(),
    };

    // First submission succeeds.
    await request(app)
      .post(`${base}/${runId}/answers`)
      .set('Idempotency-Key', key1)
      .set('If-Match', etag(stateVersion))
      .send(answerBody)
      .expect(200);

    const answeredEventsAfterFirst = await getEvents(db, runId, 'questions.answered');
    const answersAfterFirst = await getAnswersForSet(db, setId);
    const runAfterFirst = await getRunRow(db, runId);

    // Same-key replay still wins (returns original 200).
    const replayRes = await request(app)
      .post(`${base}/${runId}/answers`)
      .set('Idempotency-Key', key1)
      .set('If-Match', etag(runAfterFirst!.state_version as number))
      .send(answerBody)
      .expect(200);

    expect(replayRes.body.data.run.stateVersion).toBe(runAfterFirst!.state_version);

    // No extra event or answer from replay.
    expect(await getEvents(db, runId, 'questions.answered')).toHaveLength(
      answeredEventsAfterFirst.length,
    );
    expect(await getAnswersForSet(db, setId)).toHaveLength(answersAfterFirst.length);

    // New key: rejected with INVALID_RUN_STATE.
    const key2 = `repeat-2-${randomUUID()}`;
    const r2 = await request(app)
      .post(`${base}/${runId}/answers`)
      .set('Idempotency-Key', key2)
      .set('If-Match', etag(runAfterFirst!.state_version as number))
      .send(answerBody)
      .expect(409);

    expect(r2.body.code).toBe('INVALID_RUN_STATE');

    // No extra event, answer, or state change from the new-key attempt.
    expect(await getEvents(db, runId, 'questions.answered')).toHaveLength(
      answeredEventsAfterFirst.length,
    );
    expect(await getAnswersForSet(db, setId)).toHaveLength(answersAfterFirst.length);
    const runAfterReject = await getRunRow(db, runId);
    expect(runAfterReject!.state_version).toBe(runAfterFirst!.state_version);
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-079: Viewer cannot answer
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-079: Viewer cannot answer', () => {
  it('a viewer can read the run but cannot answer questions (403 INSUFFICIENT_PERMISSION)', async () => {
    const ctx = await freshRun('guard-viewer');
    const { db, app, runId, base } = ctx;

    const { setId, stateVersion } = await setupAwaitingInput(db, runId);

    // Viewer can read the snapshot.
    const readRes = await request(app)
      .get(`${base}/${runId}`)
      .set('X-Eidolon-Test-Org-Role', 'viewer')
      .expect(200);
    expect(readRes.body.data.run.status).toBe('awaiting_input');

    // Viewer cannot answer.
    const r = await request(app)
      .post(`${base}/${runId}/answers`)
      .set('Idempotency-Key', `viewer-${randomUUID()}`)
      .set('If-Match', etag(stateVersion))
      .set('X-Eidolon-Test-Org-Role', 'viewer')
      .send({
        questionSetId: setId,
        questionSetVersion: 1,
        answers: validAnswersRecord(),
      })
      .expect(403);

    expect(r.body.code).toBe('INSUFFICIENT_PERMISSION');

    // Set remains open, no answers recorded.
    const answers = await getAnswersForSet(db, setId);
    expect(answers).toHaveLength(0);
    const run = await getRunRow(db, runId);
    expect(run!.status).toBe('awaiting_input');
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-080: Authorized collaborator can answer
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-080: Authorized collaborator can answer', () => {
  it('an authenticated same-company member can answer an open set even if they did not initiate the run, attributed to that member', async () => {
    const ctx = await freshRun('guard-collaborator');
    const { db, app, runId, base } = ctx;

    const { setId, stateVersion } = await setupAwaitingInput(db, runId);

    const collaboratorId = `collab-${randomUUID()}`;
    const r = await request(app)
      .post(`${base}/${runId}/answers`)
      .set('Idempotency-Key', `collab-${randomUUID()}`)
      .set('If-Match', etag(stateVersion))
      .set('X-Eidolon-Test-Org-Role', 'member')
      .set('X-Eidolon-Test-User-Id', collaboratorId)
      .send({
        questionSetId: setId,
        questionSetVersion: 1,
        answers: validAnswersRecord(),
      })
      .expect(200);

    // The run resumed.
    expect(r.body.data.run.status).not.toBe('awaiting_input');

    // The answered event is attributed to the collaborator.
    const answeredEvents = await getEvents(db, runId, 'questions.answered');
    expect(answeredEvents.length).toBeGreaterThanOrEqual(1);
    const answeredEvent = answeredEvents[answeredEvents.length - 1];
    expect(answeredEvent.actorType).toBe('user');
    expect(answeredEvent.actorId).toBe(collaboratorId);

    // Answer rows are attributed to the collaborator.
    const answers = await getAnswersForSet(db, setId);
    expect(answers.length).toBeGreaterThan(0);
    for (const a of answers) {
      expect(a.actor_type).toBe('user');
      expect(a.actor_id).toBe(collaboratorId);
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-081: Actor cannot be forged
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-081: Actor cannot be forged', () => {
  it('supplying another user ID in the answer payload cannot change the recorded actor', async () => {
    const ctx = await freshRun('guard-forge');
    const { db, app, runId, base } = ctx;

    const { setId, stateVersion } = await setupAwaitingInput(db, runId);

    const realUser = `real-${randomUUID()}`;
    const forgedUser = `forged-${randomUUID()}`;

    // Submit with a forged actorId embedded in the answers payload.
    const r = await request(app)
      .post(`${base}/${runId}/answers`)
      .set('Idempotency-Key', `forge-${randomUUID()}`)
      .set('If-Match', etag(stateVersion))
      .set('X-Eidolon-Test-Org-Role', 'member')
      .set('X-Eidolon-Test-User-Id', realUser)
      .send({
        questionSetId: setId,
        questionSetVersion: 1,
        // Embed a forged actorId/actorType/userId in the answers record.
        // These are ignored — the actor comes from authenticated context.
        answers: {
          ...validAnswersRecord(),
          actorId: forgedUser,
          actorType: 'agent',
          userId: forgedUser,
        },
      })
      .expect(200);

    expect(r.body.data.run.status).not.toBe('awaiting_input');

    // The answered event is attributed to the REAL authenticated user.
    const answeredEvents = await getEvents(db, runId, 'questions.answered');
    const answeredEvent = answeredEvents[answeredEvents.length - 1];
    expect(answeredEvent.actorType).toBe('user');
    expect(answeredEvent.actorId).toBe(realUser);

    // Answer rows are attributed to the real user, not the forged one.
    const answers = await getAnswersForSet(db, setId);
    expect(answers.length).toBeGreaterThan(0);
    for (const a of answers) {
      expect(a.actor_id).toBe(realUser);
      expect(a.actor_type).toBe('user');
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-012: Duplicate question answer (canonical command route)
// ---------------------------------------------------------------------------

describe('VAL-CROSS-012: Duplicate question answer (canonical route)', () => {
  it('repeating the same answer command via the canonical /commands route with the same key returns the original result; changed payload returns 409', async () => {
    const ctx = await freshRun('guard-cross012');
    const { db, app, runId, base } = ctx;

    const { setId, stateVersion } = await setupAwaitingInput(db, runId);

    const key = `cross012-${randomUUID()}`;
    const cmdBody = {
      type: 'questions.answer' as const,
      body: {
        questionSetId: setId,
        questionSetVersion: 1,
        answers: validAnswersRecord(),
      },
    };

    // First submission via canonical route.
    const r1 = await request(app)
      .post(`${base}/${runId}/commands`)
      .set('Idempotency-Key', key)
      .set('If-Match', etag(stateVersion))
      .send(cmdBody)
      .expect(200);

    const answeredEventsAfterFirst = await getEvents(db, runId, 'questions.answered');
    expect(answeredEventsAfterFirst).toHaveLength(1);
    const answersAfterFirst = await getAnswersForSet(db, setId);
    expect(answersAfterFirst.length).toBe(3);

    // Replay via canonical route with the same key.
    const r2 = await request(app)
      .post(`${base}/${runId}/commands`)
      .set('Idempotency-Key', key)
      .set('If-Match', etag(r1.body.data.run.stateVersion))
      .send(cmdBody)
      .expect(200);

    expect(r2.body.data.run.stateVersion).toBe(r1.body.data.run.stateVersion);
    expect(await getEvents(db, runId, 'questions.answered')).toHaveLength(1);
    expect((await getAnswersForSet(db, setId)).length).toBe(3);

    // Changed payload under the same key → 409.
    const changedCmd = {
      type: 'questions.answer' as const,
      body: {
        questionSetId: setId,
        questionSetVersion: 1,
        answers: { ...validAnswersRecord(), bool_req: false },
      },
    };
    const r3 = await request(app)
      .post(`${base}/${runId}/commands`)
      .set('Idempotency-Key', key)
      .set('If-Match', etag(r1.body.data.run.stateVersion))
      .send(changedCmd)
      .expect(409);

    expect(r3.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // No extra event or answer from the conflict.
    expect(await getEvents(db, runId, 'questions.answered')).toHaveLength(1);
    expect((await getAnswersForSet(db, setId)).length).toBe(3);
  });

  it('canonical and convenience routes share one idempotency namespace', async () => {
    const ctx = await freshRun('guard-cross-route-equiv');
    const { db, app, runId, base } = ctx;

    const { setId, stateVersion } = await setupAwaitingInput(db, runId);

    const key = `routeequiv-${randomUUID()}`;
    const answerBody = {
      questionSetId: setId,
      questionSetVersion: 1,
      answers: validAnswersRecord(),
    };

    // Submit via convenience route.
    const r1 = await request(app)
      .post(`${base}/${runId}/answers`)
      .set('Idempotency-Key', key)
      .set('If-Match', etag(stateVersion))
      .send(answerBody)
      .expect(200);

    // Replay via canonical route with the same key and same logical body.
    const r2 = await request(app)
      .post(`${base}/${runId}/commands`)
      .set('Idempotency-Key', key)
      .set('If-Match', etag(r1.body.data.run.stateVersion))
      .send({ type: 'questions.answer', body: answerBody })
      .expect(200);

    // Same outcome — one application, not two.
    expect(r2.body.data.run.stateVersion).toBe(r1.body.data.run.stateVersion);
    expect(await getEvents(db, runId, 'questions.answered')).toHaveLength(1);
    expect((await getAnswersForSet(db, setId)).length).toBe(3);
    expect(await countCommands(db, runId)).toBeGreaterThanOrEqual(1);
  });
});
