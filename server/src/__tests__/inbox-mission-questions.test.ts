import { describe, expect, it, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer, closeTestServers } from '../test-utils.js';

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

/** Start a real Mission run through the API so the full aggregate exists. */
async function startRun(
  app: Awaited<ReturnType<typeof createTestServer>>,
  companyId: string,
  projectId: string,
  threadId: string,
  text: string,
): Promise<string> {
  const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
  const res = await request(app)
    .post(base)
    .set('Idempotency-Key', `inbox-${randomUUID()}`)
    .send({ projectThreadId: threadId, mode: 'fast', request: { text } })
    .expect(202);
  return res.body.data.run.id as string;
}

/** Directly persist a question set row for inbox query coverage. */
async function insertQuestionSet(
  db: AnyDb,
  ctx: { companyId: string; projectId: string; runId: string },
  opts: {
    ordinal?: number;
    status?: 'open' | 'answered' | 'invalidated';
    invalidationReason?: string | null;
    createdAt?: Date;
    resolvedAt?: Date | null;
  } = {},
): Promise<string> {
  const id = randomUUID();
  const now = opts.createdAt ?? new Date();
  const status = opts.status ?? 'open';
  await db.drizzle.execute(sql`
    INSERT INTO "run_question_sets"
      ("id", "company_id", "project_id", "run_id", "ordinal", "version", "status", "invalidation_reason", "prompt_context_hash", "created_at", "answered_at", "invalidated_at")
    VALUES
      (${id}, ${ctx.companyId}, ${ctx.projectId}, ${ctx.runId}, ${opts.ordinal ?? 1}, 1, ${status}, ${opts.invalidationReason ?? null}, null, ${now}, ${status === 'answered' ? (opts.resolvedAt ?? now) : null}, ${status === 'invalidated' ? (opts.resolvedAt ?? now) : null})
  `);
  return id;
}

async function setRunStatus(
  db: AnyDb,
  runId: string,
  status: string,
  currentQuestionSetId?: string | null,
) {
  const now = new Date();
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(status);
  await db.drizzle.execute(sql`
    UPDATE "mission_runs"
    SET "status" = ${status},
        "terminal_at" = ${isTerminal ? now : null},
        "updated_at" = ${now},
        "current_question_set_id" = ${currentQuestionSetId ?? null}
    WHERE "id" = ${runId}
  `);
}

afterEach(async () => {
  await closeTestServers();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-087 / 088 / 089 / 090 / 091 / 120 / 141: Mission question
// needs-attention items in the unified inbox feed.
// ---------------------------------------------------------------------------

describe('Mission question needs-attention inbox items', () => {
  it('surfaces an open question set as an active mission_question item with a deep link (VAL-MODEQ-087, 088)', async () => {
    enableMissionFlag();
    const db = await createTestDb();
    const app = await createTestServer(db);
    const { companyId, projectId, threadId } = await seedScope(db, 'inbox-active');
    const runId = await startRun(app, companyId, projectId, threadId, 'Active question');
    const setId = await insertQuestionSet(db, { companyId, projectId, runId });
    await setRunStatus(db, runId, 'awaiting_input', setId);

    const res = await request(app).get(`/api/companies/${companyId}/inbox`).expect(200);

    const item = res.body.data.find((i: { id: string }) => i.id === `mission_question:${setId}`);
    expect(item).toBeDefined();
    expect(item.kind).toBe('mission_question');
    expect(item.status).toBe('open');
    expect(item.entityType).toBe('mission_question_set');
    expect(item.entityId).toBe(setId);
    expect(item.taskId).toBeUndefined();
    // Deep link points to Project Work with mission + question target.
    expect(item.link).toContain(`/company/${companyId}/projects/${projectId}`);
    expect(item.link).toContain('tab=work');
    expect(item.link).toContain(`mission=${runId}`);
    expect(item.link).toContain(`question=${setId}`);
    // Identifies the Mission, project, and requested input (VAL-MODEQ-087).
    expect(item.title).toMatch(/mission/i);
    expect(item.subtitle).toMatch(/awaiting input|needs input|question/i);
    // Meta exposes a pending mission question count.
    expect(res.body.meta.pendingMissionQuestions).toBe(1);
  });

  it('deduplicates to one active item per open question set across repeated reads (VAL-MODEQ-089)', async () => {
    enableMissionFlag();
    const db = await createTestDb();
    const app = await createTestServer(db);
    const { companyId, projectId, threadId } = await seedScope(db, 'inbox-dedup');
    const runId = await startRun(app, companyId, projectId, threadId, 'Dedup');
    const setId = await insertQuestionSet(db, { companyId, projectId, runId });
    await setRunStatus(db, runId, 'awaiting_input', setId);

    const first = await request(app).get(`/api/companies/${companyId}/inbox`).expect(200);
    const second = await request(app).get(`/api/companies/${companyId}/inbox`).expect(200);

    const firstItems = first.body.data.filter(
      (i: { kind: string }) => i.kind === 'mission_question',
    );
    const secondItems = second.body.data.filter(
      (i: { kind: string }) => i.kind === 'mission_question',
    );
    expect(firstItems).toHaveLength(1);
    expect(secondItems).toHaveLength(1);
    expect(firstItems[0].id).toBe(secondItems[0].id);
  });

  it('resolves the active item and retains answered history after the set is answered (VAL-MODEQ-090, 120)', async () => {
    enableMissionFlag();
    const db = await createTestDb();
    const app = await createTestServer(db);
    const { companyId, projectId, threadId } = await seedScope(db, 'inbox-resolved');
    const runId = await startRun(app, companyId, projectId, threadId, 'Resolved');
    const setId = await insertQuestionSet(db, { companyId, projectId, runId });
    await setRunStatus(db, runId, 'awaiting_input', setId);

    const before = await request(app).get(`/api/companies/${companyId}/inbox`).expect(200);
    expect(before.body.meta.pendingMissionQuestions).toBe(1);

    // Answer the set and resume the run.
    await db.drizzle.execute(sql`
      UPDATE "run_question_sets" SET "status" = 'answered', "answered_at" = NOW() WHERE "id" = ${setId}
    `);
    await setRunStatus(db, runId, 'running', null);

    const after = await request(app).get(`/api/companies/${companyId}/inbox`).expect(200);
    // No active pending question.
    expect(after.body.meta.pendingMissionQuestions).toBe(0);
    const active = after.body.data.filter(
      (i: { kind: string; status: string }) => i.kind === 'mission_question' && i.status === 'open',
    );
    expect(active).toHaveLength(0);
    // Resolved history item remains and is non-actionable.
    const resolved = after.body.data.find(
      (i: { id: string }) => i.id === `mission_question:${setId}`,
    );
    expect(resolved).toBeDefined();
    expect(resolved.status).toBe('answered');
    // Stale link still resolves to the run (read-only history).
    expect(resolved.link).toContain(`mission=${runId}`);
  });

  it('retains invalidated sets as resolved history with the invalidation reason (VAL-MODEQ-090, 142)', async () => {
    enableMissionFlag();
    const db = await createTestDb();
    const app = await createTestServer(db);
    const { companyId, projectId, threadId } = await seedScope(db, 'inbox-invalidated');
    const runId = await startRun(app, companyId, projectId, threadId, 'Invalidated');
    const setId = await insertQuestionSet(db, { companyId, projectId, runId });
    await setRunStatus(db, runId, 'awaiting_input', setId);

    await db.drizzle.execute(sql`
      UPDATE "run_question_sets" SET "status" = 'invalidated', "invalidation_reason" = 'cancelled', "invalidated_at" = NOW() WHERE "id" = ${setId}
    `);
    await setRunStatus(db, runId, 'cancelled', null);

    const res = await request(app).get(`/api/companies/${companyId}/inbox`).expect(200);
    expect(res.body.meta.pendingMissionQuestions).toBe(0);
    const resolved = res.body.data.find(
      (i: { id: string }) => i.id === `mission_question:${setId}`,
    );
    expect(resolved).toBeDefined();
    expect(resolved.status).toBe('invalidated');
  });

  it('never exposes another company question set (VAL-MODEQ-141 tenant scope)', async () => {
    enableMissionFlag();
    const db = await createTestDb();
    const app = await createTestServer(db);
    const a = await seedScope(db, 'inbox-scope-a');
    const b = await seedScope(db, 'inbox-scope-b');
    const runA = await startRun(app, a.companyId, a.projectId, a.threadId, 'A question');
    const setA = await insertQuestionSet(db, {
      companyId: a.companyId,
      projectId: a.projectId,
      runId: runA,
    });
    await setRunStatus(db, runA, 'awaiting_input', setA);

    const resB = await request(app).get(`/api/companies/${b.companyId}/inbox`).expect(200);
    const missionItems = resB.body.data.filter(
      (i: { kind: string }) => i.kind === 'mission_question',
    );
    expect(missionItems).toHaveLength(0);
  });

  it('does not leak answer text in the inbox item (VAL-MODEQ-141)', async () => {
    enableMissionFlag();
    const db = await createTestDb();
    const app = await createTestServer(db);
    const { companyId, projectId, threadId } = await seedScope(db, 'inbox-no-leak');
    const runId = await startRun(app, companyId, projectId, threadId, 'No leak');
    const setId = await insertQuestionSet(db, { companyId, projectId, runId });
    await setRunStatus(db, runId, 'awaiting_input', setId);

    const res = await request(app).get(`/api/companies/${companyId}/inbox`).expect(200);
    const item = res.body.data.find((i: { id: string }) => i.id === `mission_question:${setId}`);
    const serialized = JSON.stringify(item);
    // No answer payloads are joined into the inbox item.
    expect(serialized).not.toMatch(/answer_text_canary/);
    expect(item.title).not.toContain('answer_text_canary');
  });

  it('hides resolved history older than the retention window from the active feed', async () => {
    enableMissionFlag();
    const db = await createTestDb();
    const app = await createTestServer(db);
    const { companyId, projectId, threadId } = await seedScope(db, 'inbox-old');
    const runId = await startRun(app, companyId, projectId, threadId, 'Old resolved');
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const setId = await insertQuestionSet(
      db,
      { companyId, projectId, runId },
      {
        status: 'answered',
        createdAt: old,
        resolvedAt: old,
      },
    );

    const res = await request(app).get(`/api/companies/${companyId}/inbox`).expect(200);
    const item = res.body.data.find((i: { id: string }) => i.id === `mission_question:${setId}`);
    // Old resolved history is not retained in the bounded feed.
    expect(item).toBeUndefined();
  });
});
