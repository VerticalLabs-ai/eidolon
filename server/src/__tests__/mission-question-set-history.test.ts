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
    .set('Idempotency-Key', `hist-${randomUUID()}`)
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
  opts: { waitingFromStatus?: string | null; currentQuestionSetId?: string | null } = {},
) {
  const now = new Date();
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(status);
  await db.drizzle.execute(sql`
    UPDATE "mission_runs"
    SET "status" = ${status}, "terminal_at" = ${isTerminal ? now : null}, "updated_at" = ${now},
        "waiting_from_status" = ${opts.waitingFromStatus ?? null}, "current_question_set_id" = ${opts.currentQuestionSetId ?? null}
    WHERE "id" = ${runId}
  `);
}

interface RunRow {
  status: string;
  state_version: number;
  [key: string]: unknown;
}

async function getRunRow(db: AnyDb, runId: string): Promise<RunRow | null> {
  const rows = (await db.drizzle.execute(
    sql`SELECT * FROM "mission_runs" WHERE "id" = ${runId}`,
  )) as unknown as Record<string, unknown>[];
  if (!rows[0]) {
    return null;
  }
  return { ...rows[0], state_version: Number(rows[0].state_version) } as RunRow;
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

async function answerSet(
  app: unknown,
  base: string,
  runId: string,
  setId: string,
  stateVersion: number,
): Promise<void> {
  await request(app as Awaited<ReturnType<typeof createTestServer>>)
    .post(`${base}/${runId}/answers`)
    .set('Idempotency-Key', `hist-ans-${randomUUID()}`)
    .set('If-Match', `"${stateVersion}"`)
    .send({ questionSetId: setId, questionSetVersion: 1, answers: validAnswersRecord() })
    .expect(200);
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

afterEach(async () => {
  await closeTestServers();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await closeTestDb();
});

// ===========================================================================
// VAL-MODEQ-148: Question and answer history has a scoped read contract
// ===========================================================================

describe('VAL-MODEQ-148: Question and answer history has a scoped read contract', () => {
  it('returns at most 50 sets ordered by (ordinal, id) with immutable definitions, set version/state, answer revision/hash, actor, and timestamps', async () => {
    const ctx = await freshRun('history-contract');
    const { db, app, runId, base } = ctx;

    // Set 1: answered.
    const { setId: set1Id, stateVersion: sv1 } = await setupAwaitingInput(db, runId);
    await answerSet(app, base, runId, set1Id, sv1);

    // Set 2: published then invalidated via replacement.
    await setRunStatus(db, runId, 'planning');
    const set2Id = await publishSet(db, runId, mixedQuestions(), 'planning');
    const { newSetId: set3Id } = await publishReplacementSet(
      db,
      runId,
      mixedQuestions(),
      'planning',
    );

    // Read history as a member (content access → exact answers).
    const history = await request(app)
      .get(`${base}/${runId}/question-sets?limit=50`)
      .set('X-Eidolon-Test-Org-Role', 'member')
      .expect(200);

    const sets = history.body.data.questionSets;
    expect(sets).toHaveLength(3);

    // Ordered by ordinal ascending.
    expect(sets[0].ordinal).toBe(1);
    expect(sets[1].ordinal).toBe(2);
    expect(sets[2].ordinal).toBe(3);
    expect(sets[0].id).toBe(set1Id);
    expect(sets[1].id).toBe(set2Id);
    expect(sets[2].id).toBe(set3Id);

    // Set 1: answered with immutable definitions and answer revisions.
    expect(sets[0].status).toBe('answered');
    expect(sets[0].version).toBe(1);
    expect(sets[0].questions).toHaveLength(3);
    expect(sets[0].questions.map((q: { questionKey: string }) => q.questionKey)).toEqual([
      'bool_req',
      'choice_req',
      'text_req',
    ]);
    expect(sets[0].answers).toHaveLength(3);
    for (const ans of sets[0].answers) {
      expect(ans.contentHash).toBeTruthy();
      expect(ans.actorType).toBe('user');
      expect(ans.answerRevision).toBe(1);
      expect(ans.createdAt).toBeTruthy();
    }
    const boolAns = sets[0].answers.find(
      (a: { questionKey: string }) => a.questionKey === 'bool_req',
    );
    expect(boolAns.value).toBe(true);

    // Set 2: invalidated with reason 'replaced'.
    expect(sets[1].status).toBe('invalidated');
    expect(sets[1].invalidationReason).toBe('replaced');
    expect(sets[1].answers).toHaveLength(0);

    // Set 3: open.
    expect(sets[2].status).toBe('open');
    expect(sets[2].answers).toHaveLength(0);

    expect(history.body.data.nextCursor).toBeNull();
  });

  it('paginates with opaque keyset cursors ordered by (ordinal, id)', async () => {
    const ctx = await freshRun('history-pagination');
    const { db, app, runId, base } = ctx;

    for (let i = 0; i < 3; i++) {
      await setRunStatus(db, runId, 'planning');
      const { setId, stateVersion } = await setupAwaitingInput(db, runId);
      await answerSet(app, base, runId, setId, stateVersion);
    }

    const page1 = await request(app)
      .get(`${base}/${runId}/question-sets?limit=2`)
      .set('X-Eidolon-Test-Org-Role', 'member')
      .expect(200);
    expect(page1.body.data.questionSets).toHaveLength(2);
    expect(page1.body.data.questionSets[0].ordinal).toBe(1);
    expect(page1.body.data.questionSets[1].ordinal).toBe(2);
    expect(page1.body.data.nextCursor).not.toBeNull();

    const page2 = await request(app)
      .get(`${base}/${runId}/question-sets?limit=2&cursor=${page1.body.data.nextCursor}`)
      .set('X-Eidolon-Test-Org-Role', 'member')
      .expect(200);
    expect(page2.body.data.questionSets).toHaveLength(1);
    expect(page2.body.data.questionSets[0].ordinal).toBe(3);
    expect(page2.body.data.nextCursor).toBeNull();

    const allOrdinals = [
      ...page1.body.data.questionSets.map((s: { ordinal: number }) => s.ordinal),
      ...page2.body.data.questionSets.map((s: { ordinal: number }) => s.ordinal),
    ];
    expect(allOrdinals).toEqual([1, 2, 3]);
  });

  it('viewers receive definitions and sanitized answer metadata only (values redacted)', async () => {
    const ctx = await freshRun('history-viewer');
    const { db, app, runId, base } = ctx;

    const { setId, stateVersion } = await setupAwaitingInput(db, runId);
    await answerSet(app, base, runId, setId, stateVersion);

    const viewerHistory = await request(app)
      .get(`${base}/${runId}/question-sets`)
      .set('X-Eidolon-Test-Org-Role', 'viewer')
      .expect(200);
    const viewerSet = viewerHistory.body.data.questionSets.find(
      (s: { id: string }) => s.id === setId,
    );
    expect(viewerSet.questions).toHaveLength(3);
    for (const ans of viewerSet.answers) {
      expect(ans.value).toEqual({ redacted: true });
      expect(ans.contentHash).toBeTruthy();
      expect(ans.actorType).toBeTruthy();
    }

    const memberHistory = await request(app)
      .get(`${base}/${runId}/question-sets`)
      .set('X-Eidolon-Test-Org-Role', 'member')
      .expect(200);
    const memberSet = memberHistory.body.data.questionSets.find(
      (s: { id: string }) => s.id === setId,
    );
    const boolAns = memberSet.answers.find(
      (a: { questionKey: string }) => a.questionKey === 'bool_req',
    );
    expect(boolAns.value).toBe(true);
  });

  it('ordering survives restart (re-creating the API process)', async () => {
    const ctx = await freshRun('history-restart');
    const { db, app, runId, base } = ctx;

    for (let i = 0; i < 2; i++) {
      await setRunStatus(db, runId, 'planning');
      const { setId, stateVersion } = await setupAwaitingInput(db, runId);
      await answerSet(app, base, runId, setId, stateVersion);
    }

    const preHistory = await request(app)
      .get(`${base}/${runId}/question-sets`)
      .set('X-Eidolon-Test-Org-Role', 'member')
      .expect(200);
    const preOrdinals = preHistory.body.data.questionSets.map(
      (s: { ordinal: number }) => s.ordinal,
    );
    const preIds = preHistory.body.data.questionSets.map((s: { id: string }) => s.id);

    await closeTestServers();
    const restartedApp = await createTestServer(db);

    const postHistory = await request(restartedApp)
      .get(`${base}/${runId}/question-sets`)
      .set('X-Eidolon-Test-Org-Role', 'member')
      .expect(200);
    expect(postHistory.body.data.questionSets.map((s: { ordinal: number }) => s.ordinal)).toEqual(
      preOrdinals,
    );
    expect(postHistory.body.data.questionSets.map((s: { id: string }) => s.id)).toEqual(preIds);

    await closeTestServers();
  });

  it('cross-scope run ID returns 404 without revealing existence', async () => {
    const ctx = await freshRun('history-crossscope');
    const { db, app, runId, base } = ctx;

    await setupAwaitingInput(db, runId);

    const scopeB = await seedScope(db, 'history-crossscope-B');
    const baseB = `/api/companies/${scopeB.companyId}/projects/${scopeB.projectId}/mission-runs`;

    const res = await request(app).get(`${baseB}/${runId}/question-sets`).expect(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');

    // Same-scope still works.
    await request(app).get(`${base}/${runId}/question-sets`).expect(200);
  });
});
