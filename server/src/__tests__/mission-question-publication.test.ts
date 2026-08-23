import { describe, expect, it, afterEach, vi } from 'vitest';
import { sql, eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer, closeTestServers, closeTestDb } from '../test-utils.js';
import { MissionQuestionPublicationService } from '../services/mission/question-publication.js';
import { MissionKillSwitchService } from '../services/mission/kill-switch.js';
import { MissionSnapshotService } from '../services/mission/snapshot.js';
import { MissionCancellationService } from '../services/mission/cancellation.js';

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

function enableMissionFlag() {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify({ missionAgentIntelligence: { enabled: true } }),
  );
}

function disableMissionFlag() {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify({ missionAgentIntelligence: { enabled: false } }),
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
    .set('Idempotency-Key', `pub-${randomUUID()}`)
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
  if (!row) {return null;}
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

async function getQuestionSets(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT * FROM "run_question_sets"
    WHERE "run_id" = ${runId} ORDER BY "ordinal" ASC
  `)) as unknown as Record<string, unknown>[];
  return rows;
}

async function getQuestionsForSet(db: AnyDb, setId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT * FROM "run_questions"
    WHERE "question_set_id" = ${setId} ORDER BY "order" ASC
  `)) as unknown as Record<string, unknown>[];
  return rows;
}

async function getBudgetReservation(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "reserved_cents", "settled_cents", "released_cents", "status"
    FROM "budget_reservations" WHERE "run_id" = ${runId}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

/** Valid question definitions for testing. */
function validQuestions(): unknown[] {
  return [
    {
      questionKey: 'q1',
      order: 0,
      type: 'boolean',
      label: 'Use the default approach?',
      required: true,
    },
    {
      questionKey: 'q2',
      order: 1,
      type: 'single_choice',
      label: 'Which priority?',
      required: false,
      options: [
        { key: 'high', label: 'High' },
        { key: 'low', label: 'Low' },
      ],
    },
  ];
}

/** Malformed question definitions (unknown type). */
function malformedQuestions(): unknown[] {
  return [
    {
      questionKey: 'q1',
      order: 0,
      type: 'unknown_type',
      label: 'Bad',
      required: false,
    },
  ];
}

afterEach(async () => {
  await closeTestServers();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-147: Publishing a question request is atomic
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-147: Publishing a question request is atomic', () => {
  it('atomically creates one schema-valid set, questions, run pointer, and events', async () => {
    const ctx = await freshRun('pub-atomic');
    const { db, companyId, projectId, runId } = ctx;

    // Move to planning first.
    await setRunStatus(db, runId, 'planning');

    const pubService = new MissionQuestionPublicationService(db);
    const run = (await getRunRow(db, runId))!;

    let result;
    await db.drizzle.transaction(async (tx) => {
      // Lock the run.
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);

      result = await pubService.publishQuestionSet(tx, locked!, validQuestions(), 'planning', {
        actorType: 'system',
        actorId: null,
      });
    });

    expect(result!.questionSetId).toBeDefined();
    expect(result!.ordinal).toBe(1);
    expect(result!.version).toBe(1);

    // Run should be awaiting_input with the correct pointer.
    const updatedRun = await getRunRow(db, runId);
    expect(updatedRun!.status).toBe('awaiting_input');
    expect(updatedRun!.current_question_set_id).toBe(result!.questionSetId);
    expect(updatedRun!.waiting_from_status).toBe('planning');

    // Question set should exist with status open and version 1.
    const sets = await getQuestionSets(db, runId);
    expect(sets).toHaveLength(1);
    expect(sets[0].status).toBe('open');
    expect(sets[0].version).toBe(1);
    expect(sets[0].ordinal).toBe(1);

    // Questions should be persisted.
    const questions = await getQuestionsForSet(db, result!.questionSetId);
    expect(questions).toHaveLength(2);
    expect(questions[0].question_key).toBe('q1');
    expect(questions[0].type).toBe('boolean');
    expect(questions[0].required).toBe(1);
    expect(questions[1].question_key).toBe('q2');
    expect(questions[1].type).toBe('single_choice');

    // Events should include questions.requested and run.status_changed.
    const events = await getEvents(db, runId);
    const requestedEvent = events.find((e) => e.type === 'questions.requested');
    const statusChangedEvent = events.find(
      (e) =>
        e.type === 'run.status_changed' && (e.payload as { to?: string }).to === 'awaiting_input',
    );
    expect(requestedEvent).toBeDefined();
    expect(requestedEvent!.payload.questionSetId).toBe(result!.questionSetId);
    expect(requestedEvent!.payload.waitingFromStatus).toBe('planning');
    expect(statusChangedEvent).toBeDefined();
    expect(statusChangedEvent!.payload.to).toBe('awaiting_input');

    // Invalidation before request (ordered): requested should come before status_changed.
    expect(requestedEvent!.sequence).toBeLessThan(statusChangedEvent!.sequence);
  });

  it('releases active work (clears lease) when entering awaiting_input', async () => {
    const ctx = await freshRun('pub-lease-release');
    const { db, runId } = ctx;

    // Set up as running with a lease.
    await db.drizzle.execute(sql`
      UPDATE "mission_runs"
      SET "status" = 'running',
          "lease_owner" = 'worker-1',
          "lease_token" = ${randomUUID()},
          "lease_expires_at" = ${new Date(Date.now() + 30000)},
          "heartbeat_at" = ${new Date()},
          "available_at" = ${new Date()}
      WHERE "id" = ${runId}
    `);

    const pubService = new MissionQuestionPublicationService(db);

    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);

      await pubService.publishQuestionSet(tx, locked!, validQuestions(), 'running');
    });

    const updatedRun = await getRunRow(db, runId);
    expect(updatedRun!.status).toBe('awaiting_input');
    expect(updatedRun!.lease_owner).toBeNull();
    expect(updatedRun!.lease_token).toBeNull();
    expect(updatedRun!.lease_expires_at).toBeNull();
    expect(updatedRun!.heartbeat_at).toBeNull();
    expect(updatedRun!.available_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-044: Question pause is durable
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-044: Question pause is durable', () => {
  it('snapshot shows awaiting_input, waiting origin, open question-set identity, and no execution progress', async () => {
    const ctx = await freshRun('pub-durable');
    const { db, companyId, projectId, runId } = ctx;

    await setRunStatus(db, runId, 'planning');

    const pubService = new MissionQuestionPublicationService(db);

    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);

      await pubService.publishQuestionSet(tx, locked!, validQuestions(), 'planning');
    });

    const snapshotService = new MissionSnapshotService(db);
    const snapshot = await snapshotService.getSnapshot(companyId, projectId, runId);

    expect(snapshot.status).toBe('awaiting_input');
    expect(snapshot.waitingFromStatus).toBe('planning');
    expect(snapshot.currentQuestionSetId).not.toBeNull();
    expect(snapshot.currentQuestionSet).not.toBeNull();
    expect(snapshot.currentQuestionSet!.status).toBe('open');
    expect(snapshot.currentQuestionSet!.version).toBe(1);
    expect(snapshot.currentQuestionSet!.questions).toHaveLength(2);
    expect(snapshot.currentQuestionSet!.questions[0].questionKey).toBe('q1');
    expect(snapshot.currentQuestionSet!.questions[0].type).toBe('boolean');
    expect(snapshot.currentQuestionSet!.questions[0].required).toBe(true);

    // No execution progress (providerCallCount should be 0).
    expect(snapshot.providerCallCount).toBe(0);
  });

  it('waitingFromStatus records resume target as running', async () => {
    const ctx = await freshRun('pub-durable-running');
    const { db, companyId, projectId, runId } = ctx;

    await setRunStatus(db, runId, 'running');

    const pubService = new MissionQuestionPublicationService(db);

    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);

      await pubService.publishQuestionSet(tx, locked!, validQuestions(), 'running');
    });

    const snapshotService = new MissionSnapshotService(db);
    const snapshot = await snapshotService.getSnapshot(companyId, projectId, runId);

    expect(snapshot.status).toBe('awaiting_input');
    expect(snapshot.waitingFromStatus).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-130: Exactly one current open question set exists
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-130: Exactly one current open question set exists', () => {
  it('replacement atomically invalidates the old set before the new request', async () => {
    const ctx = await freshRun('pub-replace');
    const { db, runId } = ctx;

    await setRunStatus(db, runId, 'planning');

    const pubService = new MissionQuestionPublicationService(db);

    // Publish the first set.
    let firstSetId: string;
    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);

      const result = await pubService.publishQuestionSet(tx, locked!, validQuestions(), 'planning');
      firstSetId = result.questionSetId;
    });

    // Move back to planning for the replacement.
    await setRunStatus(db, runId, 'planning', { currentQuestionSetId: firstSetId! });

    // Replace with a new set.
    let replaceResult;
    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);

      replaceResult = await pubService.replaceQuestionSet(
        tx,
        locked!,
        validQuestions(),
        'planning',
      );
    });

    expect(replaceResult!.invalidatedSetId).toBe(firstSetId!);
    expect(replaceResult!.questionSetId).not.toBe(firstSetId!);

    // Old set should be invalidated with reason 'replaced'.
    const sets = await getQuestionSets(db, runId);
    expect(sets).toHaveLength(2);

    const oldSet = sets.find((s) => s.id === firstSetId!);
    expect(oldSet).toBeDefined();
    expect(oldSet!.status).toBe('invalidated');
    expect(oldSet!.invalidation_reason).toBe('replaced');

    const newSet = sets.find((s) => s.id === replaceResult!.questionSetId);
    expect(newSet).toBeDefined();
    expect(newSet!.status).toBe('open');

    // Run should point to the new set.
    const updatedRun = await getRunRow(db, runId);
    expect(updatedRun!.current_question_set_id).toBe(replaceResult!.questionSetId);

    // Events: invalidation before the new request.
    const events = await getEvents(db, runId);
    const invalidatedEvents = events.filter((e) => e.type === 'questions.invalidated');
    const requestedEvents = events.filter((e) => e.type === 'questions.requested');
    expect(invalidatedEvents).toHaveLength(1);
    expect(requestedEvents).toHaveLength(2);

    // The invalidation event should come before the second request.
    const invalidationSeq = invalidatedEvents[0].sequence;
    const secondRequestSeq = requestedEvents[1].sequence;
    expect(invalidationSeq).toBeLessThan(secondRequestSeq);

    // Only one open set at a time.
    const openSets = sets.filter((s) => s.status === 'open');
    expect(openSets).toHaveLength(1);
  });

  it('never exposes two actionable sets', async () => {
    const ctx = await freshRun('pub-one-open');
    const { db, companyId, projectId, runId } = ctx;

    await setRunStatus(db, runId, 'planning');

    const pubService = new MissionQuestionPublicationService(db);

    // Publish first set.
    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);
      await pubService.publishQuestionSet(tx, locked!, validQuestions(), 'planning');
    });

    // Verify one open set.
    const sets1 = await getQuestionSets(db, runId);
    expect(sets1.filter((s) => s.status === 'open')).toHaveLength(1);

    // Replace.
    await setRunStatus(db, runId, 'planning', {
      currentQuestionSetId: sets1.find((s) => s.status === 'open')!.id as string,
    });

    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);
      await pubService.replaceQuestionSet(tx, locked!, validQuestions(), 'planning');
    });

    const sets2 = await getQuestionSets(db, runId);
    expect(sets2.filter((s) => s.status === 'open')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-059: Question set count bound
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-059: Question set count bound', () => {
  it('allows up to 3 sets and rejects the 4th with QUESTION_SET_LIMIT_EXCEEDED', async () => {
    const ctx = await freshRun('pub-count-limit');
    const { db, runId } = ctx;

    const pubService = new MissionQuestionPublicationService(db);

    // Publish 3 sets (each time: publish, answer, move back to planning, replace).
    for (let i = 0; i < 3; i++) {
      await setRunStatus(db, runId, 'planning', {
        currentQuestionSetId: i > 0 ? null : undefined,
      });

      await db.drizzle.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(db.schema.missionRuns)
          .where(eq(db.schema.missionRuns.id, runId))
          .for('update')
          .limit(1);

        if (i === 0) {
          await pubService.publishQuestionSet(tx, locked!, validQuestions(), 'planning');
        } else {
          await pubService.replaceQuestionSet(tx, locked!, validQuestions(), 'planning');
        }
      });

      // Mark the set as answered.
      const sets = await getQuestionSets(db, runId);
      const openSet = sets.find((s) => s.status === 'open');
      if (openSet) {
        await db.drizzle.execute(sql`
          UPDATE "run_question_sets"
          SET "status" = 'answered', "answered_at" = ${new Date()}
          WHERE "id" = ${openSet.id}
        `);
        await db.drizzle.execute(sql`
          UPDATE "mission_runs"
          SET "status" = 'planning', "current_question_set_id" = NULL
          WHERE "id" = ${runId}
        `);
      }
    }

    // Verify 3 sets exist.
    const sets = await getQuestionSets(db, runId);
    expect(sets).toHaveLength(3);

    // Attempt the 4th — should fail.
    await setRunStatus(db, runId, 'planning');

    let error: unknown;
    await db.drizzle
      .transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(db.schema.missionRuns)
          .where(eq(db.schema.missionRuns.id, runId))
          .for('update')
          .limit(1);

        try {
          await pubService.publishQuestionSet(tx, locked!, validQuestions(), 'planning');
        } catch (err) {
          error = err;
          // Roll back by throwing — but we want to catch and verify.
          throw err;
        }
      })
      .catch((err) => {
        error = err;
      });

    expect(error).toBeDefined();
    expect((error as { code?: string }).code).toBe('QUESTION_SET_LIMIT_EXCEEDED');

    // Still only 3 sets.
    const finalSets = await getQuestionSets(db, runId);
    expect(finalSets).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-135: Generated question failures are bounded
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-135: Generated question failures are bounded', () => {
  it('rejects malformed question definitions with QUESTION_SCHEMA_INVALID before presentation', async () => {
    const ctx = await freshRun('pub-malformed');
    const { db, runId } = ctx;

    await setRunStatus(db, runId, 'planning');

    const pubService = new MissionQuestionPublicationService(db);

    let error: unknown;
    await db.drizzle
      .transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(db.schema.missionRuns)
          .where(eq(db.schema.missionRuns.id, runId))
          .for('update')
          .limit(1);

        try {
          await pubService.publishQuestionSet(tx, locked!, malformedQuestions(), 'planning');
        } catch (err) {
          error = err;
          throw err;
        }
      })
      .catch((err) => {
        error = err;
      });

    expect(error).toBeDefined();
    expect((error as { code?: string }).code).toBe('QUESTION_SCHEMA_INVALID');

    // No set should have been created.
    const sets = await getQuestionSets(db, runId);
    expect(sets).toHaveLength(0);

    // Run should not have been moved to awaiting_input.
    const run = await getRunRow(db, runId);
    expect(run!.status).toBe('planning');
    expect(run!.current_question_set_id).toBeNull();
  });

  it('rejects oversized sets (more than 12 questions) with QUESTION_SCHEMA_INVALID', async () => {
    const ctx = await freshRun('pub-oversized');
    const { db, runId } = ctx;

    await setRunStatus(db, runId, 'planning');

    const oversized = Array.from({ length: 13 }, (_, i) => ({
      questionKey: `q${i}`,
      order: i,
      type: 'boolean',
      label: `Question ${i}`,
      required: false,
    }));

    const pubService = new MissionQuestionPublicationService(db);

    let error: unknown;
    await db.drizzle
      .transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(db.schema.missionRuns)
          .where(eq(db.schema.missionRuns.id, runId))
          .for('update')
          .limit(1);

        try {
          await pubService.publishQuestionSet(tx, locked!, oversized, 'planning');
        } catch (err) {
          error = err;
          throw err;
        }
      })
      .catch((err) => {
        error = err;
      });

    expect(error).toBeDefined();
    expect((error as { code?: string }).code).toBe('QUESTION_SCHEMA_INVALID');

    const sets = await getQuestionSets(db, runId);
    expect(sets).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-128: Wall-time accounting includes human waits
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-128: Wall-time accounting includes human waits', () => {
  it('snapshot exposes deadlineAt and remainingWallMs computed from createdAt + durationSeconds', async () => {
    const ctx = await freshRun('pub-walltime');
    const { db, companyId, projectId, runId } = ctx;

    await setRunStatus(db, runId, 'planning');

    const pubService = new MissionQuestionPublicationService(db);

    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);

      await pubService.publishQuestionSet(tx, locked!, validQuestions(), 'planning');
    });

    const snapshotService = new MissionSnapshotService(db);
    const snapshot = await snapshotService.getSnapshot(companyId, projectId, runId);

    expect(snapshot.deadlineAt).not.toBeNull();
    expect(snapshot.remainingWallMs).not.toBeNull();
    // The deadline is absolute from creation. For Fast mode, the default
    // duration is 300 seconds (5 minutes). The remaining time should be
    // positive (the run just started).
    expect(snapshot.remainingWallMs!).toBeGreaterThan(0);

    // The deadline should be approximately createdAt + 300s.
    const expectedDeadline = new Date(snapshot.createdAt).getTime() + 300 * 1000;
    const actualDeadline = new Date(snapshot.deadlineAt!).getTime();
    expect(Math.abs(actualDeadline - expectedDeadline)).toBeLessThan(5000); // within 5s
  });

  it('remaining wall time decreases while awaiting input (includes human wait)', async () => {
    const ctx = await freshRun('pub-walltime-decrease');
    const { db, companyId, projectId, runId } = ctx;

    await setRunStatus(db, runId, 'planning');

    const pubService = new MissionQuestionPublicationService(db);

    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);

      await pubService.publishQuestionSet(tx, locked!, validQuestions(), 'planning');
    });

    const snapshotService = new MissionSnapshotService(db);
    const snapshot1 = await snapshotService.getSnapshot(companyId, projectId, runId);
    const remaining1 = snapshot1.remainingWallMs!;

    // Wait a bit to simulate human think time.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const snapshot2 = await snapshotService.getSnapshot(companyId, projectId, runId);
    const remaining2 = snapshot2.remainingWallMs!;

    // Remaining time should have decreased (includes human wait time).
    expect(remaining2).toBeLessThan(remaining1);
  });

  it('restart cannot reset the deadline (deadline computed from createdAt, not current time)', async () => {
    const ctx = await freshRun('pub-walltime-restart');
    const { db, companyId, projectId, runId } = ctx;

    const snapshotService = new MissionSnapshotService(db);
    const snapshot1 = await snapshotService.getSnapshot(companyId, projectId, runId);
    const deadline1 = snapshot1.deadlineAt;

    // Simulate "restart" by creating a new snapshot service instance.
    const snapshotService2 = new MissionSnapshotService(db);
    const snapshot2 = await snapshotService2.getSnapshot(companyId, projectId, runId);

    // Deadline is the same (computed from immutable createdAt).
    expect(snapshot2.deadlineAt).toBe(deadline1);
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-142: Questions obey the kill switch
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-142: Questions obey the kill switch', () => {
  it('disabling while awaiting input: reads continue, answer mutations denied, cancellation closes the set', async () => {
    const ctx = await freshRun('pub-kill-switch');
    const { db, app, companyId, projectId, runId, base } = ctx;

    await setRunStatus(db, runId, 'planning');

    const pubService = new MissionQuestionPublicationService(db);

    let questionSetId: string;
    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);

      const result = await pubService.publishQuestionSet(tx, locked!, validQuestions(), 'planning');
      questionSetId = result.questionSetId;
    });

    // Disable the flag.
    disableMissionFlag();

    // Authorized reads should continue.
    const getSnapshot = await request(app).get(`${base}/${runId}`).expect(200);
    expect(getSnapshot.body.data.run.status).toBe('awaiting_input');
    expect(getSnapshot.body.data.run.currentQuestionSet).not.toBeNull();

    // Answer mutations should return 404 FEATURE_NOT_AVAILABLE.
    const answerAttempt = await request(app)
      .post(`${base}/${runId}/commands`)
      .set('Idempotency-Key', `answer-${randomUUID()}`)
      .set('If-Match', `"${getSnapshot.body.data.run.stateVersion}"`)
      .send({
        type: 'questions.answer',
        body: {
          questionSetId: questionSetId!,
          questionSetVersion: 1,
          answers: { q1: true, q2: 'high' },
        },
      });
    expect(answerAttempt.status).toBe(404);
    expect(answerAttempt.body.code).toBe('FEATURE_NOT_AVAILABLE');

    // Cancellation should remain available.
    const cancelRes = await request(app)
      .post(`${base}/${runId}/commands`)
      .set('Idempotency-Key', `cancel-${randomUUID()}`)
      .set('If-Match', `"${getSnapshot.body.data.run.stateVersion}"`)
      .send({ type: 'run.cancel', reason: 'Kill switch' });
    expect([200, 202]).toContain(cancelRes.status);

    // The run should be cancelled (non-lease state terminalizes immediately).
    const finalSnapshot = await request(app).get(`${base}/${runId}`).expect(200);
    expect(finalSnapshot.body.data.run.status).toBe('cancelled');

    // The question set should be invalidated with reason 'cancelled'.
    const sets = await getQuestionSets(db, runId);
    const invalidatedSet = sets.find((s) => s.id === questionSetId!);
    expect(invalidatedSet).toBeDefined();
    expect(invalidatedSet!.status).toBe('invalidated');
    expect(invalidatedSet!.invalidation_reason).toBe('cancelled');
  });

  it('re-enable preserves terminal history and does not recreate an actionable set', async () => {
    const ctx = await freshRun('pub-kill-switch-reenable');
    const { db, app, companyId, projectId, runId, base } = ctx;

    await setRunStatus(db, runId, 'planning');

    const pubService = new MissionQuestionPublicationService(db);

    let questionSetId: string;
    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);

      const result = await pubService.publishQuestionSet(tx, locked!, validQuestions(), 'planning');
      questionSetId = result.questionSetId;
    });

    // Disable and cancel.
    disableMissionFlag();
    await request(app)
      .post(`${base}/${runId}/commands`)
      .set('Idempotency-Key', `cancel-${randomUUID()}`)
      .set('If-Match', `"${(await getRunRow(db, runId))!.state_version}"`)
      .send({ type: 'run.cancel', reason: 'Kill switch' });

    // Re-enable.
    enableMissionFlag();

    // Read should show the terminal state with invalidated set.
    const snapshot = await request(app).get(`${base}/${runId}`).expect(200);
    expect(snapshot.body.data.run.status).toBe('cancelled');
    expect(snapshot.body.data.run.currentQuestionSet).toBeNull();

    // No new open set should exist.
    const sets = await getQuestionSets(db, runId);
    expect(sets.filter((s) => s.status === 'open')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-150: Input deadline and answer races close once
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-150: Input deadline and answer races close once', () => {
  it('deadline expiry in awaiting_input invalidates the set with deadline_expired and fails the run', async () => {
    const ctx = await freshRun('pub-deadline-expiry');
    const { db, companyId, projectId, runId } = ctx;

    await setRunStatus(db, runId, 'planning');

    const pubService = new MissionQuestionPublicationService(db);

    let questionSetId: string;
    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);

      const result = await pubService.publishQuestionSet(tx, locked!, validQuestions(), 'planning');
      questionSetId = result.questionSetId;
    });

    // Move the run's createdAt far into the past so the deadline has passed.
    // Fast mode default duration is 300 seconds (5 minutes).
    const pastDate = new Date(Date.now() - 600 * 1000); // 10 minutes ago
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "created_at" = ${pastDate} WHERE "id" = ${runId}
    `);

    // Run enforceDeadlines — should detect the expired deadline and fail the run.
    const killSwitch = new MissionKillSwitchService(ctx.db);
    const result = await killSwitch.enforceDeadlines();
    expect(result.terminalized).toBeGreaterThan(0);

    // Run should be failed with category 'limit' and code 'TIME_LIMIT'.
    const run = await getRunRow(db, runId);
    expect(run!.status).toBe('failed');
    expect(run!.failure_category).toBe('limit');
    expect(run!.failure_code).toBe('TIME_LIMIT');
    expect(run!.terminal_at).not.toBeNull();

    // The question set should be invalidated with reason 'deadline_expired'.
    const sets = await getQuestionSets(db, runId);
    const expiredSet = sets.find((s) => s.id === questionSetId!);
    expect(expiredSet).toBeDefined();
    expect(expiredSet!.status).toBe('invalidated');
    expect(expiredSet!.invalidation_reason).toBe('deadline_expired');

    // Events should include questions.invalidated and run.failed.
    const events = await getEvents(db, runId);
    const invalidatedEvent = events.find(
      (e) =>
        e.type === 'questions.invalidated' &&
        (e.payload as { reason?: string }).reason === 'deadline_expired',
    );
    const failedEvent = events.find((e) => e.type === 'run.failed');
    expect(invalidatedEvent).toBeDefined();
    expect(failedEvent).toBeDefined();
    expect((failedEvent!.payload as { code?: string }).code).toBe('TIME_LIMIT');

    // Budget should be released.
    const budget = await getBudgetReservation(db, runId);
    expect(budget).not.toBeNull();
    expect(budget!.released_cents).toBeGreaterThan(0);
  });

  it('deadline expiry terminalization is atomic — no partial state on failure', async () => {
    const ctx = await freshRun('pub-deadline-atomic');
    const { db, runId } = ctx;

    await setRunStatus(db, runId, 'planning');

    const pubService = new MissionQuestionPublicationService(db);

    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);

      await pubService.publishQuestionSet(tx, locked!, validQuestions(), 'planning');
    });

    // Move the run's createdAt far into the past.
    const pastDate = new Date(Date.now() - 600 * 1000);
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "created_at" = ${pastDate} WHERE "id" = ${runId}
    `);

    // Run enforceDeadlines.
    const killSwitch = new MissionKillSwitchService(ctx.db);
    await killSwitch.enforceDeadlines();

    // Verify the run is in a consistent terminal state.
    const run = await getRunRow(db, runId);
    expect(run!.status).toBe('failed');
    expect(run!.terminal_at).not.toBeNull();
    expect(run!.current_question_set_id).toBeNull();

    // The set should be invalidated (not left open).
    const sets = await getQuestionSets(db, runId);
    const openSets = sets.filter((s) => s.status === 'open');
    expect(openSets).toHaveLength(0);
  });

  it('a run not yet past its deadline is not terminalized', async () => {
    const ctx = await freshRun('pub-deadline-not-expired');
    const { db, runId } = ctx;

    await setRunStatus(db, runId, 'planning');

    const pubService = new MissionQuestionPublicationService(db);

    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);

      await pubService.publishQuestionSet(tx, locked!, validQuestions(), 'planning');
    });

    // Run enforceDeadlines — the run was just created, deadline not passed.
    const killSwitch = new MissionKillSwitchService(ctx.db);
    const result = await killSwitch.enforceDeadlines();
    expect(result.terminalized).toBe(0);

    const run = await getRunRow(db, runId);
    expect(run!.status).toBe('awaiting_input');
    expect(run!.terminal_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cancellation terminalization invalidates open question sets
// ---------------------------------------------------------------------------

describe('Cancellation terminalization invalidates open question sets', () => {
  it('cancelling a run in awaiting_input invalidates the open set with reason cancelled', async () => {
    const ctx = await freshRun('pub-cancel-invalidates');
    const { db, runId } = ctx;

    await setRunStatus(db, runId, 'planning');

    const pubService = new MissionQuestionPublicationService(db);

    let questionSetId: string;
    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);

      const result = await pubService.publishQuestionSet(tx, locked!, validQuestions(), 'planning');
      questionSetId = result.questionSetId;
    });

    // Cancel the run via the cancellation service.
    const cancelService = new MissionCancellationService(db);

    await db.drizzle.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, runId))
        .for('update')
        .limit(1);

      // Request cancellation (non-lease state → terminalizes immediately).
      await cancelService.requestCancellation(tx, locked!, {
        companyId: ctx.companyId,
        projectId: ctx.projectId,
        runId,
        actorType: 'user',
        actorId: 'test-user',
      });
    });

    // Run should be cancelled.
    const run = await getRunRow(db, runId);
    expect(run!.status).toBe('cancelled');

    // Set should be invalidated with reason 'cancelled'.
    const sets = await getQuestionSets(db, runId);
    const cancelledSet = sets.find((s) => s.id === questionSetId!);
    expect(cancelledSet).toBeDefined();
    expect(cancelledSet!.status).toBe('invalidated');
    expect(cancelledSet!.invalidation_reason).toBe('cancelled');

    // Run pointer should be cleared.
    expect(run!.current_question_set_id).toBeNull();

    // Events should include questions.invalidated before run.cancelled.
    const events = await getEvents(db, runId);
    const invalidatedEvent = events.find((e) => e.type === 'questions.invalidated');
    const cancelledEvent = events.find((e) => e.type === 'run.cancelled');
    expect(invalidatedEvent).toBeDefined();
    expect(cancelledEvent).toBeDefined();
    expect(invalidatedEvent!.sequence).toBeLessThan(cancelledEvent!.sequence);
  });
});
