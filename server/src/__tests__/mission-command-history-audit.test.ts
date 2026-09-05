import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, createTestServer, createTestApp } from '../test-utils.js';
import { MissionStartService } from '../services/mission/start.js';

/**
 * VAL-RUN-075: Command history is scoped, bounded, and inert.
 *
 * The declared GET .../commands?limit=&cursor= route returns at most 100
 * command summaries ordered by (createdAt,id), with opaque keyset cursors,
 * request hash, actor/result metadata, and redacted payload access by
 * permission. Domain-rejected stale, invalid-state, or idempotency-conflict
 * commands remain visible but change no state, event, budget, or output;
 * middleware 401/403 attempts expose only safe HTTP/security audit data
 * and create no user-readable command row.
 */

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

async function startRun(
  db: AnyDb,
  companyId: string,
  projectId: string,
  threadId: string,
  key: string,
  text = 'Do work',
) {
  const service = new MissionStartService(db);
  return service.start({
    companyId,
    projectId,
    idempotencyKey: key,
    body: { projectThreadId: threadId, mode: 'fast', request: { text } },
    actorType: 'user',
    actorId: 'dev-user-000',
  });
}

async function countCommands(db: AnyDb, runId: string): Promise<number> {
  const [row] = (await db.drizzle.execute(
    sql`SELECT count(*)::int AS c FROM "run_commands" WHERE "run_id" = ${runId}`,
  )) as unknown as { c: number }[];
  return row.c;
}

async function countEvents(db: AnyDb, runId: string, type?: string): Promise<number> {
  const q = type
    ? sql`SELECT count(*)::int AS c FROM "run_events" WHERE "run_id" = ${runId} AND "type" = ${type}`
    : sql`SELECT count(*)::int AS c FROM "run_events" WHERE "run_id" = ${runId}`;
  const [row] = (await db.drizzle.execute(q)) as unknown as { c: number }[];
  return row.c;
}

async function getRunVersion(db: AnyDb, runId: string): Promise<number> {
  const [row] = (await db.drizzle.execute(
    sql`SELECT "state_version" FROM "mission_runs" WHERE "id" = ${runId}`,
  )) as unknown as { state_version: number }[];
  return row.state_version;
}

const etag = (v: number): string => `"${v}"`;

/** Start a fresh run in a fresh scope so each test owns an isolated run. */
async function freshRun(label: string, text = 'Do work') {
  enableMissionFlag();
  const db = await createTestDb();
  const app = await createTestServer(db);
  const { companyId, projectId, threadId } = await seedScope(db, label);
  const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
  const start = await request(app)
    .post(base)
    .set('Idempotency-Key', `fresh-${randomUUID()}`)
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

// ---------------------------------------------------------------------------
// Command history pagination and ordering
// ---------------------------------------------------------------------------

describe('Mission command history pagination and ordering (VAL-RUN-075)', () => {
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  it('returns command summaries ordered by (createdAt ASC, id ASC) with the start command first', async () => {
    const ctx = await freshRun('__mtest__ history-order');
    const res = await request(ctx.app).get(`${ctx.base}/${ctx.runId}/commands`).expect(200);
    expect(res.body.data.commands).toHaveLength(1);
    const cmd = res.body.data.commands[0];
    expect(cmd.type).toBe('run.start');
    expect(cmd.status).toBe('applied');
    expect(cmd.resultStatusCode).toBe(202);
    expect(cmd.requestHash).toBeTruthy();
    expect(cmd.actorType).toBe('user');
    expect(cmd.actorId).toBe('dev-user-000');
    expect(cmd.createdAt).toBeTruthy();
    expect(cmd.id).toBeTruthy();
  });

  it('paginates with limit and opaque cursor, no duplicates or skips', async () => {
    const ctx = await freshRun('__mtest__ history-pagination');
    // The run starts with one command (run.start). Add several cancels to
    // create enough commands for pagination. The first cancel terminalizes
    // the run; subsequent cancels return 200 (already terminal) and are
    // still recorded as applied commands.
    for (let i = 0; i < 5; i++) {
      await request(ctx.app)
        .post(`${ctx.base}/${ctx.runId}/cancel`)
        .set('Idempotency-Key', `page-cancel-${i}`)
        .set('If-Match', etag(ctx.stateVersion))
        .send({ reason: `cancel ${i}` });
    }

    // 6 total commands (1 start + 5 cancels).
    // Page 1: limit=3 → 3 commands, nextCursor truthy
    const page1 = await request(ctx.app)
      .get(`${ctx.base}/${ctx.runId}/commands?limit=3`)
      .expect(200);
    expect(page1.body.data.commands).toHaveLength(3);
    expect(page1.body.data.nextCursor).toBeTruthy();

    // Page 2: limit=3 → 3 remaining commands, nextCursor null
    const page2 = await request(ctx.app)
      .get(`${ctx.base}/${ctx.runId}/commands?limit=3&cursor=${page1.body.data.nextCursor}`)
      .expect(200);
    expect(page2.body.data.commands).toHaveLength(3);
    expect(page2.body.data.nextCursor).toBeNull();

    // No duplicates across pages
    const allIds = [
      ...page1.body.data.commands.map((c: { id: string }) => c.id),
      ...page2.body.data.commands.map((c: { id: string }) => c.id),
    ];
    expect(new Set(allIds).size).toBe(6);

    // Ordering: createdAt ASC, id ASC
    const allCommands = [...page1.body.data.commands, ...page2.body.data.commands];
    for (let i = 1; i < allCommands.length; i++) {
      const prev = allCommands[i - 1];
      const curr = allCommands[i];
      const prevTime = new Date(prev.createdAt).getTime();
      const currTime = new Date(curr.createdAt).getTime();
      expect(currTime > prevTime || (currTime === prevTime && curr.id > prev.id)).toBe(true);
    }
  });

  it('rejects a limit above 100 with 400 VALIDATION_ERROR', async () => {
    const ctx = await freshRun('__mtest__ history-cap');
    const res = await request(ctx.app)
      .get(`${ctx.base}/${ctx.runId}/commands?limit=101`)
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('accepts a limit of 100', async () => {
    const ctx = await freshRun('__mtest__ history-limit100');
    const res = await request(ctx.app)
      .get(`${ctx.base}/${ctx.runId}/commands?limit=100`)
      .expect(200);
    expect(res.body.data.commands).toHaveLength(1);
  });

  it('rejects a malformed cursor with 400 VALIDATION_ERROR', async () => {
    const ctx = await freshRun('__mtest__ history-bad-cursor');
    const res = await request(ctx.app)
      .get(`${ctx.base}/${ctx.runId}/commands?cursor=!!!invalid!!!`)
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// Restart-stable ordering
// ---------------------------------------------------------------------------

describe('Mission command history restart-stable ordering (VAL-RUN-075)', () => {
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  it('preserves the same ordering after an API restart', async () => {
    const ctx = await freshRun('__mtest__ history-restart');
    // Add a cancel command
    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', 'restart-cancel-001')
      .set('If-Match', etag(ctx.stateVersion))
      .send({ reason: 'restart cancel' })
      .expect(202);

    // Read before restart
    const beforeRestart = await request(ctx.app)
      .get(`${ctx.base}/${ctx.runId}/commands`)
      .expect(200);
    const beforeIds = beforeRestart.body.data.commands.map((c: { id: string }) => c.id);

    // Simulate an API restart: a brand-new Express app over the SAME db.
    const restartedApp = createTestApp(ctx.db);

    const afterRestart = await request(restartedApp)
      .get(`${ctx.base}/${ctx.runId}/commands`)
      .expect(200);
    const afterIds = afterRestart.body.data.commands.map((c: { id: string }) => c.id);

    expect(afterIds).toEqual(beforeIds);
    expect(afterRestart.body.data.commands[0].type).toBe('run.start');
    expect(afterRestart.body.data.commands[1].type).toBe('run.cancel');
  });
});

// ---------------------------------------------------------------------------
// Redaction by permission
// ---------------------------------------------------------------------------

describe('Mission command history payload redaction (VAL-RUN-075)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;
  let runId: string;
  let stateVersion: number;

  beforeAll(async () => {
    enableMissionFlag();
    db = await createTestDb();
    app = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ redaction', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Redaction Project' })
      .expect(201);
    projectId = project.body.data.id;
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Redaction Thread' })
      .expect(201);
    threadId = thread.body.data.id;

    const result = await startRun(db, companyId, projectId, threadId, 'redact-001');
    runId = result.run.id;
    stateVersion = result.run.stateVersion;

    // Add a cancel command so there's a command with a payload (reason).
    await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/mission-runs/${runId}/cancel`)
      .set('Idempotency-Key', 'redact-cancel-001')
      .set('If-Match', etag(stateVersion))
      .send({ reason: 'sensitive cancel reason' })
      .expect(202);
  });

  afterEach(() => vi.unstubAllEnvs());

  const base = () => `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
  const viewerHeaders = () => ({ 'X-Eidolon-Test-Org-Role': 'viewer' });
  const memberHeaders = () => ({ 'X-Eidolon-Test-Org-Role': 'member' });

  it('viewer receives command summaries with redacted payloads', async () => {
    const res = await request(app)
      .get(`${base()}/${runId}/commands`)
      .set(viewerHeaders())
      .expect(200);
    for (const cmd of res.body.data.commands) {
      expect(cmd.payload).toBeNull();
      // But non-payload metadata is still present
      expect(cmd.requestHash).toBeTruthy();
      expect(cmd.actorType).toBeTruthy();
      expect(cmd.status).toBeTruthy();
    }
  });

  it('member receives command summaries with payloads', async () => {
    const res = await request(app)
      .get(`${base()}/${runId}/commands`)
      .set(memberHeaders())
      .expect(200);
    const cancelCmd = res.body.data.commands.find((c: { type: string }) => c.type === 'run.cancel');
    expect(cancelCmd).toBeDefined();
    expect(cancelCmd.payload).not.toBeNull();
    // The cancel payload contains the (encrypted) reason
    expect(cancelCmd.payload).toHaveProperty('reason');
  });

  it('owner receives command summaries with payloads', async () => {
    const res = await request(app).get(`${base()}/${runId}/commands`).expect(200); // default role is owner in local_trusted
    const cancelCmd = res.body.data.commands.find((c: { type: string }) => c.type === 'run.cancel');
    expect(cancelCmd).toBeDefined();
    expect(cancelCmd.payload).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Role and scope matrices
// ---------------------------------------------------------------------------

describe('Mission command history role and scope matrix (VAL-RUN-075)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;
  let runId: string;

  beforeAll(async () => {
    enableMissionFlag();
    db = await createTestDb();
    app = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ scope-matrix', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Scope Project' })
      .expect(201);
    projectId = project.body.data.id;
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Scope Thread' })
      .expect(201);
    threadId = thread.body.data.id;

    const result = await startRun(db, companyId, projectId, threadId, 'scope-001');
    runId = result.run.id;
  });

  afterEach(() => vi.unstubAllEnvs());

  const base = () => `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

  it('viewer can read command history', async () => {
    const res = await request(app)
      .get(`${base()}/${runId}/commands`)
      .set({ 'X-Eidolon-Test-Org-Role': 'viewer' })
      .expect(200);
    expect(res.body.data.commands).toHaveLength(1);
  });

  it('member can read command history', async () => {
    const res = await request(app)
      .get(`${base()}/${runId}/commands`)
      .set({ 'X-Eidolon-Test-Org-Role': 'member' })
      .expect(200);
    expect(res.body.data.commands).toHaveLength(1);
  });

  it('cross-company command history returns 404 RUN_NOT_FOUND', async () => {
    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ other-co', settings: { testFixture: true } })
      .expect(201);
    const otherProject = await request(app)
      .post(`/api/companies/${otherCompany.body.data.id}/projects`)
      .send({ name: 'Other Project' })
      .expect(201);
    const res = await request(app)
      .get(
        `/api/companies/${otherCompany.body.data.id}/projects/${otherProject.body.data.id}/mission-runs/${runId}/commands`,
      )
      .expect(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
  });

  it('cross-project command history returns 404 RUN_NOT_FOUND', async () => {
    const otherProject = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Other Project Same Co' })
      .expect(201);
    const res = await request(app)
      .get(
        `/api/companies/${companyId}/projects/${otherProject.body.data.id}/mission-runs/${runId}/commands`,
      )
      .expect(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
  });

  it('cross-company 404 is indistinguishable from a random nonexistent ID', async () => {
    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ indistinguishable', settings: { testFixture: true } })
      .expect(201);
    const otherProject = await request(app)
      .post(`/api/companies/${otherCompany.body.data.id}/projects`)
      .send({ name: 'Ind Project' })
      .expect(201);
    const fakeId = randomUUID();

    const crossRes = await request(app)
      .get(
        `/api/companies/${otherCompany.body.data.id}/projects/${otherProject.body.data.id}/mission-runs/${runId}/commands`,
      )
      .expect(404);
    const fakeRes = await request(app)
      .get(
        `/api/companies/${otherCompany.body.data.id}/projects/${otherProject.body.data.id}/mission-runs/${fakeId}/commands`,
      )
      .expect(404);

    expect(crossRes.status).toBe(fakeRes.status);
    expect(crossRes.body.code).toBe(fakeRes.body.code);
    expect(crossRes.body.message).toBe(fakeRes.body.message);
  });
});

// ---------------------------------------------------------------------------
// Stale command inertness (412 RUN_VERSION_MISMATCH)
// ---------------------------------------------------------------------------

describe('Mission stale command inertness (VAL-RUN-075)', () => {
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  it('records a stale cancel as a rejected command visible in history with no state change', async () => {
    const ctx = await freshRun('__mtest__ stale-cancel');
    const versionBefore = await getRunVersion(ctx.db, ctx.runId);
    const eventsBefore = await countEvents(ctx.db, ctx.runId);

    // Advance the run version so the original If-Match is stale.
    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "state_version" = "state_version" + 1, "updated_at" = ${new Date()} WHERE "id" = ${ctx.runId}
    `);

    // Submit a cancel with the stale version.
    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', 'stale-cancel-001')
      .set('If-Match', etag(versionBefore))
      .send({ reason: 'stale cancel' })
      .expect(412);
    expect(res.body.code).toBe('RUN_VERSION_MISMATCH');

    // No state, event, or budget change.
    expect(await getRunVersion(ctx.db, ctx.runId)).toBe(versionBefore + 1);
    expect(await countEvents(ctx.db, ctx.runId)).toBe(eventsBefore);

    // The rejected command is visible in history.
    const history = await request(ctx.app).get(`${ctx.base}/${ctx.runId}/commands`).expect(200);
    const rejectedCmd = history.body.data.commands.find(
      (c: { idempotencyKey: string }) => c.idempotencyKey === 'stale-cancel-001',
    );
    expect(rejectedCmd).toBeDefined();
    expect(rejectedCmd.status).toBe('rejected');
    expect(rejectedCmd.resultStatusCode).toBe(412);
    expect(rejectedCmd.errorCode).toBe('RUN_VERSION_MISMATCH');
    expect(rejectedCmd.requestHash).toBeTruthy();
    expect(rejectedCmd.actorType).toBe('user');
    expect(rejectedCmd.actorId).toBe('dev-user-000');
  });

  it('replays a stale cancel rejection with the same error on duplicate key', async () => {
    const ctx = await freshRun('__mtest__ stale-replay');
    const versionBefore = await getRunVersion(ctx.db, ctx.runId);

    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "state_version" = "state_version" + 1, "updated_at" = ${new Date()} WHERE "id" = ${ctx.runId}
    `);

    // First stale cancel.
    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', 'stale-replay-001')
      .set('If-Match', etag(versionBefore))
      .send({ reason: 'stale cancel' })
      .expect(412);

    // Replay with the same key and content.
    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', 'stale-replay-001')
      .set('If-Match', etag(versionBefore))
      .send({ reason: 'stale cancel' })
      .expect(412);
    expect(res.body.code).toBe('RUN_VERSION_MISMATCH');

    // Only one rejected command row.
    expect(await countCommands(ctx.db, ctx.runId)).toBe(2); // start + 1 rejected
  });
});

// ---------------------------------------------------------------------------
// Invalid-state command inertness (409 INVALID_RUN_STATE)
// ---------------------------------------------------------------------------

describe('Mission invalid-state command inertness (VAL-RUN-075)', () => {
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  it('records an invalid-state retry as a rejected command visible in history with no state change', async () => {
    const ctx = await freshRun('__mtest__ invalid-retry');
    const versionBefore = await getRunVersion(ctx.db, ctx.runId);
    const eventsBefore = await countEvents(ctx.db, ctx.runId);

    // Attempt retry from a nonterminal (draft) run.
    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', 'invalid-retry-001')
      .set('If-Match', etag(versionBefore))
      .send({})
      .expect(409);
    expect(res.body.code).toBe('INVALID_RUN_STATE');

    // No state, event, or budget change.
    expect(await getRunVersion(ctx.db, ctx.runId)).toBe(versionBefore);
    expect(await countEvents(ctx.db, ctx.runId)).toBe(eventsBefore);

    // No successor run created.
    const [succCount] = (await ctx.db.drizzle.execute(
      sql`SELECT count(*)::int AS c FROM "mission_runs" WHERE "retry_of_run_id" = ${ctx.runId}`,
    )) as unknown as { c: number }[];
    expect(succCount.c).toBe(0);

    // The rejected command is visible in history.
    const history = await request(ctx.app).get(`${ctx.base}/${ctx.runId}/commands`).expect(200);
    const rejectedCmd = history.body.data.commands.find(
      (c: { idempotencyKey: string }) => c.idempotencyKey === 'invalid-retry-001',
    );
    expect(rejectedCmd).toBeDefined();
    expect(rejectedCmd.status).toBe('rejected');
    expect(rejectedCmd.resultStatusCode).toBe(409);
    expect(rejectedCmd.errorCode).toBe('INVALID_RUN_STATE');
  });

  it('records a precondition-missing cancel as a rejected command visible in history', async () => {
    const ctx = await freshRun('__mtest__ precond-missing-reject');
    const versionBefore = await getRunVersion(ctx.db, ctx.runId);
    const eventsBefore = await countEvents(ctx.db, ctx.runId);

    // Cancel without If-Match (precondition required).
    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', 'precond-missing-001')
      .send({ reason: 'no precondition' })
      .expect(428);
    expect(res.body.code).toBe('PRECONDITION_REQUIRED');

    // No state or event change.
    expect(await getRunVersion(ctx.db, ctx.runId)).toBe(versionBefore);
    expect(await countEvents(ctx.db, ctx.runId)).toBe(eventsBefore);

    // The rejected command is visible in history.
    const history = await request(ctx.app).get(`${ctx.base}/${ctx.runId}/commands`).expect(200);
    const rejectedCmd = history.body.data.commands.find(
      (c: { idempotencyKey: string }) => c.idempotencyKey === 'precond-missing-001',
    );
    expect(rejectedCmd).toBeDefined();
    expect(rejectedCmd.status).toBe('rejected');
    expect(rejectedCmd.resultStatusCode).toBe(428);
    expect(rejectedCmd.errorCode).toBe('PRECONDITION_REQUIRED');
  });
});

// ---------------------------------------------------------------------------
// Idempotency-conflict inertness (409 IDEMPOTENCY_KEY_REUSED)
// ---------------------------------------------------------------------------

describe('Mission idempotency-conflict inertness (VAL-RUN-075)', () => {
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  it('rejects same key with different content and changes no state; original command remains visible', async () => {
    const ctx = await freshRun('__mtest__ idem-conflict');

    // Submit an applied cancel.
    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', 'idem-conflict-001')
      .set('If-Match', etag(ctx.stateVersion))
      .send({ reason: 'original cancel' })
      .expect(202);

    const versionAfterCancel = await getRunVersion(ctx.db, ctx.runId);
    const eventsAfterCancel = await countEvents(ctx.db, ctx.runId);
    const commandsAfterCancel = await countCommands(ctx.db, ctx.runId);

    // Submit with the same key but different content.
    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', 'idem-conflict-001')
      .set('If-Match', etag(ctx.stateVersion))
      .send({ reason: 'different content' })
      .expect(409);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // No state, event, or command change from the conflict attempt.
    expect(await getRunVersion(ctx.db, ctx.runId)).toBe(versionAfterCancel);
    expect(await countEvents(ctx.db, ctx.runId)).toBe(eventsAfterCancel);
    expect(await countCommands(ctx.db, ctx.runId)).toBe(commandsAfterCancel);

    // The original applied command remains visible in history.
    const history = await request(ctx.app).get(`${ctx.base}/${ctx.runId}/commands`).expect(200);
    const originalCmd = history.body.data.commands.find(
      (c: { idempotencyKey: string }) => c.idempotencyKey === 'idem-conflict-001',
    );
    expect(originalCmd).toBeDefined();
    expect(originalCmd.status).toBe('applied');
    expect(originalCmd.resultStatusCode).toBe(202);
  });
});

// ---------------------------------------------------------------------------
// Middleware 401/403 creates no command row
// ---------------------------------------------------------------------------

describe('Mission middleware 401/403 creates no command row (VAL-RUN-075)', () => {
  let db: AnyDb;
  let authApp: Awaited<ReturnType<typeof createTestServer>>;
  let localApp: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;
  let runId: string;

  beforeAll(async () => {
    enableMissionFlag();
    db = await createTestDb();
    authApp = await createTestServer(db, 'authenticated');
    localApp = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    const now = new Date();
    companyId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "companies" ("id", "name", "status", "budget_monthly_cents", "spent_monthly_cents", "settings", "created_at", "updated_at")
      VALUES (${companyId}, '__mtest__ 401-403', 'active', 100000, 0, '{}'::jsonb, ${now}, ${now})
    `);
    projectId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "projects" ("id", "company_id", "name", "status", "created_at", "updated_at")
      VALUES (${projectId}, ${companyId}, 'P', 'active', ${now}, ${now})
    `);
    threadId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "project_threads" ("id", "company_id", "project_id", "title", "type", "status", "created_at", "updated_at")
      VALUES (${threadId}, ${companyId}, ${projectId}, 'T', 'conversation', 'active', ${now}, ${now})
    `);

    const result = await startRun(db, companyId, projectId, threadId, 'mw-001');
    runId = result.run.id;
  });

  afterEach(() => vi.unstubAllEnvs());

  it('unauthenticated cancel creates no command row', async () => {
    const commandsBefore = await countCommands(db, runId);
    const res = await request(authApp)
      .post(`/api/companies/${companyId}/projects/${projectId}/mission-runs/${runId}/cancel`)
      .set('Idempotency-Key', 'mw-unauth-001')
      .set('If-Match', '"1"')
      .send({ reason: 'unauth' })
      .expect(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
    expect(await countCommands(db, runId)).toBe(commandsBefore);
  });

  it('viewer cancel (403) creates no command row', async () => {
    const commandsBefore = await countCommands(db, runId);
    const res = await request(localApp)
      .post(`/api/companies/${companyId}/projects/${projectId}/mission-runs/${runId}/cancel`)
      .set('Idempotency-Key', 'mw-viewer-001')
      .set('If-Match', '"1"')
      .set({ 'X-Eidolon-Test-Org-Role': 'viewer' })
      .send({ reason: 'viewer cancel' })
      .expect(403);
    expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    expect(await countCommands(db, runId)).toBe(commandsBefore);
  });

  it('unauthenticated command history read returns 401', async () => {
    const res = await request(authApp)
      .get(`/api/companies/${companyId}/projects/${projectId}/mission-runs/${runId}/commands`)
      .expect(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });
});

// ---------------------------------------------------------------------------
// Command history does not require the mission flag
// ---------------------------------------------------------------------------

describe('Mission command history available without flag (VAL-RUN-075)', () => {
  beforeEach(() => {
    // Do NOT enable the mission flag — reads should remain available.
    vi.stubEnv('EIDOLON_FEATURE_FLAGS', JSON.stringify({}));
  });
  afterEach(() => vi.unstubAllEnvs());

  it('command history is readable when the mission flag is disabled', async () => {
    // Start the run with the flag enabled, then disable it for the read.
    enableMissionFlag();
    const ctx = await freshRun('__mtest__ no-flag');
    vi.stubEnv('EIDOLON_FEATURE_FLAGS', JSON.stringify({}));

    const res = await request(ctx.app).get(`${ctx.base}/${ctx.runId}/commands`).expect(200);
    expect(res.body.data.commands).toHaveLength(1);
    expect(res.body.data.commands[0].type).toBe('run.start');
  });
});
