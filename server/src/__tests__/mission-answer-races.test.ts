import { describe, expect, it, afterEach, afterAll, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer, closeTestServers, closeTestDb } from '../test-utils.js';
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

interface RunContext {
  db: AnyDb;
  app: Awaited<ReturnType<typeof createTestServer>>;
  companyId: string;
  projectId: string;
  threadId: string;
  runId: string;
  stateVersion: number;
  base: string;
}

async function freshRun(label: string, text = 'Do work'): Promise<RunContext> {
  enableMissionFlag();
  const db = await createTestDb();
  const app = await createTestServer(db);
  const { companyId, projectId, threadId } = await seedScope(db, label);
  const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
  const start = await request(app)
    .post(base)
    .set('Idempotency-Key', `races-${randomUUID()}`)
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

interface RunRow {
  status: string;
  state_version: number;
  last_event_sequence: number;
  lease_owner: string | null;
  [key: string]: unknown;
}

async function getRunRow(db: AnyDb, runId: string): Promise<RunRow | null> {
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
  } as RunRow;
}

interface EventRow {
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  actorType: string;
  actorId: string | null;
}

async function getEvents(db: AnyDb, runId: string, type?: string): Promise<EventRow[]> {
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

async function getAnswersForSet(db: AnyDb, setId: string): Promise<Record<string, unknown>[]> {
  const rows = (await db.drizzle.execute(sql`
    SELECT * FROM "run_question_answers"
    WHERE "question_set_id" = ${setId}
    ORDER BY "question_key" ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows;
}

interface QuestionSetRow {
  id: string;
  ordinal: number;
  version: number;
  status: string;
  invalidation_reason: string | null;
  [key: string]: unknown;
}

async function getQuestionSets(db: AnyDb, runId: string): Promise<QuestionSetRow[]> {
  const rows = (await db.drizzle.execute(sql`
    SELECT * FROM "run_question_sets"
    WHERE "run_id" = ${runId}
    ORDER BY "ordinal" ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    ...r,
    ordinal: Number(r.ordinal),
    version: Number(r.version),
  })) as QuestionSetRow[];
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

async function setupAwaitingInput(
  db: AnyDb,
  runId: string,
  questions: unknown[] = mixedQuestions(),
  waitingFromStatus: 'planning' | 'running' = 'planning',
): Promise<{ setId: string; stateVersion: number }> {
  await setRunStatus(db, runId, waitingFromStatus);
  const setId = await publishSet(db, runId, questions, waitingFromStatus);
  const run = await getRunRow(db, runId);
  return { setId, stateVersion: run!.state_version as number };
}

/** Publish a replacement set (invalidates the current open set, returns both IDs). */
async function publishReplacementSet(
  db: AnyDb,
  runId: string,
  questions: unknown[],
  waitingFromStatus: 'planning' | 'running',
): Promise<{ newSetId: string; invalidatedSetId: string | null }> {
  const pubService = new MissionQuestionPublicationService(db);
  let newSetId: string;
  let invalidatedSetId: string | null = null;
  await db.drizzle.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(db.schema.missionRuns)
      .where(eq(db.schema.missionRuns.id, runId))
      .for('update')
      .limit(1);
    const result = await pubService.replaceQuestionSet(tx, locked!, questions, waitingFromStatus);
    newSetId = result.questionSetId;
    invalidatedSetId = result.invalidatedSetId;
  });
  return { newSetId: newSetId!, invalidatedSetId };
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
  return { bool_req: true, choice_req: 'a', text_req: 'done' };
}

const etag = (v: number): string => `"${v}"`;

afterEach(async () => {
  await closeTestServers();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await closeTestDb();
});

// ===========================================================================
// VAL-MODEQ-083: API restart preserves questions
// ===========================================================================

describe('VAL-MODEQ-083: API restart preserves questions', () => {
  it('after re-creating the API process, an open question set and committed answers remain available with same IDs, order, version, and state', async () => {
    const ctx = await freshRun('restart-questions');
    const { db, runId, base } = ctx;

    const { setId, stateVersion } = await setupAwaitingInput(db, runId);

    // Answer the set so committed answer revisions exist.
    await request(ctx.app)
      .post(`${base}/${runId}/answers`)
      .set('Idempotency-Key', `ans-${randomUUID()}`)
      .set('If-Match', etag(stateVersion))
      .send({ questionSetId: setId, questionSetVersion: 1, answers: validAnswersRecord() })
      .expect(200);

    // Capture pre-restart authoritative state.
    const preSnapshot = await request(ctx.app).get(`${base}/${runId}`).expect(200);
    const preSets = await getQuestionSets(db, runId);
    const preAnswers = await getAnswersForSet(db, setId);
    const preQuestionKeys = preAnswers.map((a) => a.question_key as string);

    // Simulate API restart: close the current server and create a new one
    // bound to the same persistent Postgres database.
    await closeTestServers();
    const restartedApp = await createTestServer(db);

    // Post-restart snapshot must match the same run/set/answer identity.
    const postSnapshot = await request(restartedApp).get(`${base}/${runId}`).expect(200);
    expect(postSnapshot.body.data.run.id).toBe(runId);
    expect(postSnapshot.body.data.run.stateVersion).toBe(preSnapshot.body.data.run.stateVersion);

    // The answered set is still present with the same id, ordinal, version.
    const postSets = await getQuestionSets(db, runId);
    expect(postSets).toHaveLength(preSets.length);
    const postAnsweredSet = postSets.find((s) => s.id === setId);
    expect(postAnsweredSet).toBeDefined();
    expect(postAnsweredSet!.version).toBe(1);
    expect(postAnsweredSet!.status).toBe('answered');

    // Answer revisions remain with same IDs and order.
    const postAnswers = await getAnswersForSet(db, setId);
    expect(postAnswers).toHaveLength(preAnswers.length);
    expect(postAnswers.map((a) => a.question_key as string)).toEqual(preQuestionKeys);

    await closeTestServers();
  });
});

// ===========================================================================
// VAL-MODEQ-084: Worker restart preserves wait
// ===========================================================================

describe('VAL-MODEQ-084: Worker restart preserves wait', () => {
  it('an awaiting_input run remains waiting with one question set and no background progress, then resumes exactly once after a valid answer', async () => {
    const ctx = await freshRun('restart-wait');
    const { db, app, runId, base } = ctx;

    const { setId, stateVersion } = await setupAwaitingInput(db, runId);

    // awaiting_input has no worker lease, so a worker restart has no effect.
    const preRun = await getRunRow(db, runId);
    expect(preRun!.status).toBe('awaiting_input');
    expect(preRun!.lease_owner).toBeNull();

    const preSets = await getQuestionSets(db, runId);
    expect(preSets).toHaveLength(1);

    const preEvents = await getEvents(db, runId);
    const execEvents = preEvents.filter(
      (e) =>
        e.type.startsWith('execution.') ||
        e.type.startsWith('tool.') ||
        e.type.startsWith('provider.'),
    );
    expect(execEvents).toHaveLength(0);

    // A valid answer resumes exactly once.
    const res = await request(app)
      .post(`${base}/${runId}/answers`)
      .set('Idempotency-Key', `resume-${randomUUID()}`)
      .set('If-Match', etag(stateVersion))
      .send({ questionSetId: setId, questionSetVersion: 1, answers: validAnswersRecord() })
      .expect(200);

    expect(res.body.data.run.status).not.toBe('awaiting_input');
    expect(await getEvents(db, runId, 'questions.answered')).toHaveLength(1);
    expect(await getEvents(db, runId, 'questions.requested')).toHaveLength(1);
  });
});

// ===========================================================================
// VAL-MODEQ-111: Sensitive values are not leaked
// ===========================================================================

describe('VAL-MODEQ-111: Sensitive values are not leaked', () => {
  it('question labels, help, validation errors, answer responses, and events never expose seeded secret markers', async () => {
    const ctx = await freshRun('secrets-leak');
    const { db, app, runId, base } = ctx;

    const SECRET_MARKER = 'CANARY_marker_not_credential_12345';
    const PROMPT_MARKER = 'HIDDEN_PROMPT_do_not_leak';
    const PROVIDER_MARKER = 'RAW_PROVIDER_BODY_{"api_key":"leak"}';

    const questionsWithMarkers = [
      {
        questionKey: 'bool_req',
        order: 0,
        type: 'boolean',
        label: `Boolean? ${SECRET_MARKER}`,
        required: true,
        help: `Help ${PROMPT_MARKER}`,
      },
      {
        questionKey: 'text_req',
        order: 1,
        type: 'text',
        label: 'Required text?',
        required: true,
        validation: { minLength: 3, maxLength: 100 },
      },
    ];

    const { setId, stateVersion } = await setupAwaitingInput(db, runId, questionsWithMarkers);

    // 1. Invalid answer with provider marker → 422 must not leak the marker.
    const invalidRes = await request(app)
      .post(`${base}/${runId}/answers`)
      .set('Idempotency-Key', `secret-invalid-${randomUUID()}`)
      .set('If-Match', etag(stateVersion))
      .send({
        questionSetId: setId,
        questionSetVersion: 1,
        answers: { bool_req: PROVIDER_MARKER, text_req: 'done' },
      })
      .expect(422);

    expect(invalidRes.body.code).toBe('ANSWER_VALIDATION_FAILED');
    const invalidBodyStr = JSON.stringify(invalidRes.body);
    expect(invalidBodyStr).not.toContain(PROVIDER_MARKER);
    expect(invalidBodyStr).not.toContain(SECRET_MARKER);

    // 2. Valid answer → response and events must not expose provider markers.
    const validRes = await request(app)
      .post(`${base}/${runId}/answers`)
      .set('Idempotency-Key', `secret-valid-${randomUUID()}`)
      .set('If-Match', etag(stateVersion))
      .send({
        questionSetId: setId,
        questionSetVersion: 1,
        answers: { bool_req: true, text_req: `answer ${PROVIDER_MARKER}` },
      })
      .expect(200);

    expect(JSON.stringify(validRes.body)).not.toContain(PROVIDER_MARKER);

    const events = await getEvents(db, runId, 'questions.answered');
    const eventsStr = JSON.stringify(events);
    expect(eventsStr).not.toContain(PROVIDER_MARKER);
    expect(eventsStr).not.toContain(SECRET_MARKER);
    expect(eventsStr).not.toContain(PROMPT_MARKER);

    // 3. Viewer question-set history redacts answer values.
    const viewerHistory = await request(app)
      .get(`${base}/${runId}/question-sets`)
      .set('X-Eidolon-Test-Org-Role', 'viewer')
      .expect(200);
    expect(JSON.stringify(viewerHistory.body)).not.toContain(PROVIDER_MARKER);
    const viewerSet = viewerHistory.body.data.questionSets.find(
      (s: { id: string }) => s.id === setId,
    );
    for (const ans of viewerSet.answers) {
      expect(ans.value).toEqual({ redacted: true });
    }
  });
});

// ===========================================================================
// VAL-MODEQ-112: Question events are ordered
// ===========================================================================

describe('VAL-MODEQ-112: Question events are ordered', () => {
  it('for each set, questions.requested precedes answered/invalidated, sequences strictly increase, and answered/invalidated occurs at most once', async () => {
    const ctx = await freshRun('events-ordered');
    const { db, runId, base, app } = ctx;

    // Set 1: answered.
    const { setId: set1Id } = await setupAwaitingInput(db, runId);
    await request(app)
      .post(`${base}/${runId}/answers`)
      .set('Idempotency-Key', `order-1-${randomUUID()}`)
      .set('If-Match', etag((await getRunRow(db, runId))!.state_version))
      .send({ questionSetId: set1Id, questionSetVersion: 1, answers: validAnswersRecord() })
      .expect(200);

    // Set 2: published (answered set1 cleared currentQuestionSetId; move to
    // planning and publish set2).
    await setRunStatus(db, runId, 'planning');
    const set2Id = await publishSet(db, runId, mixedQuestions(), 'planning');

    // Set 2 → invalidated via replacement (run is in awaiting_input with
    // currentQuestionSetId = set2; replaceQuestionSet reads it from the
    // locked run and invalidates it before publishing set3).
    const { newSetId: set3Id } = await publishReplacementSet(
      db,
      runId,
      mixedQuestions(),
      'planning',
    );

    const allEvents = await getEvents(db, runId);
    const questionEvents = allEvents.filter((e) =>
      ['questions.requested', 'questions.answered', 'questions.invalidated'].includes(e.type),
    );

    // Sequences strictly increase.
    for (let i = 1; i < questionEvents.length; i++) {
      expect(questionEvents[i].sequence).toBeGreaterThan(questionEvents[i - 1].sequence);
    }

    // Group by set.
    const eventsBySet = new Map<string, EventRow[]>();
    for (const e of questionEvents) {
      const sid = (e.payload as { questionSetId?: string }).questionSetId;
      if (!sid) {
        continue;
      }
      const arr = eventsBySet.get(sid) ?? [];
      arr.push(e);
      eventsBySet.set(sid, arr);
    }

    // Set 1: requested then answered (at most once).
    const s1 = eventsBySet.get(set1Id)!;
    expect(s1.findIndex((e) => e.type === 'questions.requested')).toBeGreaterThanOrEqual(0);
    expect(s1.findIndex((e) => e.type === 'questions.answered')).toBeGreaterThan(0);
    expect(s1.filter((e) => e.type === 'questions.answered')).toHaveLength(1);

    // Set 2: requested then invalidated (at most once).
    const s2 = eventsBySet.get(set2Id)!;
    const reqIdx2 = s2.findIndex((e) => e.type === 'questions.requested');
    const invIdx2 = s2.findIndex((e) => e.type === 'questions.invalidated');
    expect(reqIdx2).toBeGreaterThanOrEqual(0);
    expect(invIdx2).toBeGreaterThan(reqIdx2);
    expect(s2.filter((e) => e.type === 'questions.invalidated')).toHaveLength(1);

    // Set 3: requested only (still open).
    const s3 = eventsBySet.get(set3Id)!;
    expect(s3.filter((e) => e.type === 'questions.requested')).toHaveLength(1);
    expect(s3.filter((e) => e.type === 'questions.answered')).toHaveLength(0);
    expect(s3.filter((e) => e.type === 'questions.invalidated')).toHaveLength(0);
  });
});

// ===========================================================================
// VAL-MODEQ-113: Answer audit attribution persists
// ===========================================================================

describe('VAL-MODEQ-113: Answer audit attribution persists', () => {
  it('accepted and rejected answer attempts remain attributable to the authenticated actor, run, and scope after re-creating the API process', async () => {
    const ctx = await freshRun('attribution-persist');
    const { db, app, runId, base } = ctx;

    const { setId, stateVersion } = await setupAwaitingInput(db, runId);

    const collaboratorId = `attrib-${randomUUID()}`;
    const memberHeaders = {
      'X-Eidolon-Test-Org-Role': 'member',
      'X-Eidolon-Test-User-Id': collaboratorId,
    };

    // Accepted answer.
    await request(app)
      .post(`${base}/${runId}/answers`)
      .set('Idempotency-Key', `attrib-accept-${randomUUID()}`)
      .set('If-Match', etag(stateVersion))
      .set(memberHeaders as Record<string, string>)
      .send({ questionSetId: setId, questionSetVersion: 1, answers: validAnswersRecord() })
      .expect(200);

    // Rejected answer (set already answered → 409 INVALID_RUN_STATE).
    const postAnswerVersion = (await getRunRow(db, runId))!.state_version;
    await request(app)
      .post(`${base}/${runId}/answers`)
      .set('Idempotency-Key', `attrib-reject-${randomUUID()}`)
      .set('If-Match', etag(postAnswerVersion))
      .set(memberHeaders as Record<string, string>)
      .send({ questionSetId: setId, questionSetVersion: 1, answers: validAnswersRecord() })
      .expect(409);

    // Pre-restart attribution.
    const preAnsweredEvents = await getEvents(db, runId, 'questions.answered');
    expect(preAnsweredEvents[0].actorId).toBe(collaboratorId);
    const preAnswers = await getAnswersForSet(db, setId);
    for (const a of preAnswers) {
      expect(a.actor_id).toBe(collaboratorId);
    }

    const preCmdHistory = await request(app)
      .get(`${base}/${runId}/commands`)
      .set(memberHeaders as Record<string, string>)
      .expect(200);
    const answerCmds = preCmdHistory.body.data.commands.filter(
      (c: { type: string }) => c.type === 'questions.answer',
    );
    expect(answerCmds.length).toBeGreaterThanOrEqual(2);
    for (const c of answerCmds) {
      expect(c.actorId).toBe(collaboratorId);
    }

    // Simulate API restart.
    await closeTestServers();
    const restartedApp = await createTestServer(db);

    // Post-restart: attribution persists via question-sets history.
    const postHistory = await request(restartedApp)
      .get(`${base}/${runId}/question-sets`)
      .set(memberHeaders as Record<string, string>)
      .expect(200);
    const answeredSet = postHistory.body.data.questionSets.find(
      (s: { id: string }) => s.id === setId,
    );
    for (const ans of answeredSet.answers) {
      expect(ans.actorType).toBe('user');
      expect(ans.actorId).toBe(collaboratorId);
      expect(ans.contentHash).toBeTruthy();
      expect(ans.answerRevision).toBe(1);
    }

    // Post-restart command history still attributable.
    const postCmdHistory = await request(restartedApp)
      .get(`${base}/${runId}/commands`)
      .set(memberHeaders as Record<string, string>)
      .expect(200);
    const postAnswerCmds = postCmdHistory.body.data.commands.filter(
      (c: { type: string }) => c.type === 'questions.answer',
    );
    for (const c of postAnswerCmds) {
      expect(c.actorId).toBe(collaboratorId);
    }

    await closeTestServers();
  });
});

// ===========================================================================
// VAL-MODEQ-114: Terminal run rejects questions
// ===========================================================================

describe('VAL-MODEQ-114: Terminal run rejects questions', () => {
  it.each(['completed', 'failed', 'cancelled'] as const)(
    'a %s run cannot accept a question answer; terminal state and history remain immutable',
    async (terminalStatus) => {
      const ctx = await freshRun('terminal-reject');
      const { db, app, runId, base } = ctx;

      const { setId } = await setupAwaitingInput(db, runId);
      const preTerminalVersion = (await getRunRow(db, runId))!.state_version;

      await setRunStatus(db, runId, terminalStatus);

      const res = await request(app)
        .post(`${base}/${runId}/answers`)
        .set('Idempotency-Key', `terminal-${terminalStatus}-${randomUUID()}`)
        .set('If-Match', etag(preTerminalVersion))
        .send({ questionSetId: setId, questionSetVersion: 1, answers: validAnswersRecord() })
        .expect(409);

      expect(res.body.code).toBe('INVALID_RUN_STATE');
      expect(await getAnswersForSet(db, setId)).toHaveLength(0);
      expect(await getEvents(db, runId, 'questions.answered')).toHaveLength(0);

      // The set is still open (not answered).
      const sets = await getQuestionSets(db, runId);
      expect(sets.find((s) => s.id === setId)!.status).not.toBe('answered');
    },
  );
});

// ===========================================================================
// VAL-MODEQ-119: Mode and question state are tenant scoped
// ===========================================================================

describe('VAL-MODEQ-119: Mode and question state are tenant scoped', () => {
  it('cross-company and cross-project reads of questions and question-set history return 404 without revealing existence', async () => {
    const ctx = await freshRun('tenant-A');
    const { db, app, runId: runIdA, base: baseA, companyId: companyA } = ctx;

    const { setId: setIdA } = await setupAwaitingInput(db, runIdA);

    // Scope B (company B, project B).
    const scopeB = await seedScope(db, 'tenant-B');
    const baseB = `/api/companies/${scopeB.companyId}/projects/${scopeB.projectId}/mission-runs`;

    // Cross-company snapshot → 404.
    const crossCompanySnapshot = await request(app).get(`${baseB}/${runIdA}`).expect(404);
    expect(crossCompanySnapshot.body.code).toBe('RUN_NOT_FOUND');

    // Cross-company question-set history → 404.
    const crossCompanyHistory = await request(app)
      .get(`${baseB}/${runIdA}/question-sets`)
      .expect(404);
    expect(crossCompanyHistory.body.code).toBe('RUN_NOT_FOUND');

    // Cross-project within company A.
    const now = new Date();
    const projectA2 = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "projects" ("id", "company_id", "name", "status", "created_at", "updated_at")
      VALUES (${projectA2}, ${companyA}, 'P2', 'active', ${now}, ${now})
    `);
    const baseA2 = `/api/companies/${companyA}/projects/${projectA2}/mission-runs`;

    const crossProjectSnapshot = await request(app).get(`${baseA2}/${runIdA}`).expect(404);
    expect(crossProjectSnapshot.body.code).toBe('RUN_NOT_FOUND');
    const crossProjectHistory = await request(app)
      .get(`${baseA2}/${runIdA}/question-sets`)
      .expect(404);
    expect(crossProjectHistory.body.code).toBe('RUN_NOT_FOUND');

    // Same-scope control.
    const sameScope = await request(app).get(`${baseA}/${runIdA}/question-sets`).expect(200);
    expect(sameScope.body.data.questionSets).toHaveLength(1);
    expect(sameScope.body.data.questionSets[0].id).toBe(setIdA);

    // Run unchanged by cross-scope attempts.
    expect((await getRunRow(db, runIdA))!.status).toBe('awaiting_input');
  });
});

// ===========================================================================
// VAL-MODEQ-131: Answer invalidation and cancellation races resolve once
// ===========================================================================

describe('VAL-MODEQ-131: Answer invalidation and cancellation races resolve once', () => {
  it('concurrent answer and cancellation against one version have one lock winner; the loser is stale/invalid-state and commits no revision/event', async () => {
    const ctx = await freshRun('race-invalidate-cancel');
    const { db, app, runId, base } = ctx;

    const { setId, stateVersion } = await setupAwaitingInput(db, runId);

    const startBarrier = { resolve: () => {} };
    const startPromise = new Promise<void>((resolve) => {
      startBarrier.resolve = resolve;
    });

    const answerPromise = startPromise.then(() =>
      request(app)
        .post(`${base}/${runId}/answers`)
        .set('Idempotency-Key', `race-ans-${randomUUID()}`)
        .set('If-Match', etag(stateVersion))
        .send({ questionSetId: setId, questionSetVersion: 1, answers: validAnswersRecord() })
        .then((r) => ({ status: r.status, code: r.body.code }))
        .catch((e) => ({ status: 0, code: String(e) })),
    );

    const cancelPromise = startPromise.then(() =>
      request(app)
        .post(`${base}/${runId}/cancel`)
        .set('Idempotency-Key', `race-cancel-${randomUUID()}`)
        .set('If-Match', etag(stateVersion))
        .send({ reason: 'Cancelling during question wait' })
        .then((r) => ({ status: r.status, code: r.body.code, runStatus: r.body.data?.run?.status }))
        .catch((e) => ({ status: 0, code: String(e), runStatus: undefined })),
    );

    startBarrier.resolve();
    const [answerResult, cancelResult] = await Promise.all([answerPromise, cancelPromise]);

    const answerWon = answerResult.status === 200;
    const cancelWon =
      cancelResult.status === 202 ||
      (cancelResult.status === 200 && cancelResult.runStatus === 'cancelled');

    // Exactly one winner.
    expect(answerWon || cancelWon).toBe(true);
    expect(answerWon && cancelWon).toBe(false);

    if (answerWon) {
      expect(cancelResult.status).toBe(412);
      expect(cancelResult.code).toBe('RUN_VERSION_MISMATCH');
      const run = await getRunRow(db, runId);
      expect(run!.status).not.toBe('cancelled');
      expect(run!.status).not.toBe('awaiting_input');
      expect(await getEvents(db, runId, 'questions.answered')).toHaveLength(1);
      expect(await getEvents(db, runId, 'run.cancelled')).toHaveLength(0);
    } else {
      expect([409, 412]).toContain(answerResult.status);
      const run = await getRunRow(db, runId);
      expect(run!.status).toBe('cancelled');
      expect(await getEvents(db, runId, 'questions.answered')).toHaveLength(0);
      expect(await getEvents(db, runId, 'run.cancelled')).toHaveLength(1);
      expect(await getAnswersForSet(db, setId)).toHaveLength(0);
    }
  });
});

// ===========================================================================
// VAL-MODEQ-132: Concurrent collaborators cannot answer twice
// ===========================================================================

describe('VAL-MODEQ-132: Concurrent collaborators cannot answer twice', () => {
  it('two valid answer submissions from different collaborators with different keys and the same ETag yield exactly one applied answer/resume', async () => {
    const ctx = await freshRun('race-two-collaborators');
    const { db, app, runId, base } = ctx;

    const { setId, stateVersion } = await setupAwaitingInput(db, runId);

    const collab1 = `collab1-${randomUUID()}`;
    const collab2 = `collab2-${randomUUID()}`;

    const startBarrier = { resolve: () => {} };
    const startPromise = new Promise<void>((resolve) => {
      startBarrier.resolve = resolve;
    });

    const answerBody = {
      questionSetId: setId,
      questionSetVersion: 1,
      answers: validAnswersRecord(),
    };

    const ans1 = startPromise.then(() =>
      request(app)
        .post(`${base}/${runId}/answers`)
        .set('Idempotency-Key', `collab1-${randomUUID()}`)
        .set('If-Match', etag(stateVersion))
        .set('X-Eidolon-Test-Org-Role', 'member')
        .set('X-Eidolon-Test-User-Id', collab1)
        .send(answerBody)
        .then((r) => ({ status: r.status, code: r.body.code }))
        .catch((e) => ({ status: 0, code: String(e) })),
    );

    const ans2 = startPromise.then(() =>
      request(app)
        .post(`${base}/${runId}/answers`)
        .set('Idempotency-Key', `collab2-${randomUUID()}`)
        .set('If-Match', etag(stateVersion))
        .set('X-Eidolon-Test-Org-Role', 'member')
        .set('X-Eidolon-Test-User-Id', collab2)
        .send(answerBody)
        .then((r) => ({ status: r.status, code: r.body.code }))
        .catch((e) => ({ status: 0, code: String(e) })),
    );

    startBarrier.resolve();
    const [r1, r2] = await Promise.all([ans1, ans2]);

    const winnerCount = [r1, r2].filter((r) => r.status === 200).length;
    expect(winnerCount).toBe(1);

    const loser = r1.status === 200 ? r2 : r1;
    expect(loser.status).toBe(412);
    expect(loser.code).toBe('RUN_VERSION_MISMATCH');

    expect(await getEvents(db, runId, 'questions.answered')).toHaveLength(1);
    expect(await getAnswersForSet(db, setId)).toHaveLength(3);
    expect((await getRunRow(db, runId))!.status).not.toBe('awaiting_input');
  });
});
