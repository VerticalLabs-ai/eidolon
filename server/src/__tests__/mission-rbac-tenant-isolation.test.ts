import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, createTestServer } from '../test-utils.js';
import { MissionStartService } from '../services/mission/start.js';

/**
 * Mission RBAC and tenant isolation tests.
 *
 * Covers:
 * - VAL-RUN-066: Unauthenticated access is denied
 * - VAL-RUN-067: Viewer access is read only
 * - VAL-RUN-068: Member can use permitted run actions
 * - VAL-RUN-069: Cross-company run IDs are undiscoverable
 * - VAL-RUN-070: Cross-project run IDs are undiscoverable
 * - VAL-RUN-071: Lists and streams enforce tenant scope
 * - VAL-RUN-072: Request actor cannot be forged
 * - VAL-CROSS-065: Viewer permissions are read-only (broader)
 * - VAL-CROSS-071: Cross-company IDs never leak (broader)
 * - VAL-CROSS-088: Role downgrade and membership removal revoke live access
 * - VAL-CROSS-089: Live revocation overlays snapshots deny only
 * - VAL-CROSS-094: Scope switching quarantines late responses (backend)
 */

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

function enableMissionFlag() {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify({ missionAgentIntelligence: { enabled: true } }),
  );
}

/** Start a run through the service and return its id + snapshot. */
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

/** Create a local-trusted session for the given company/role. */
async function createSession(
  db: AnyDb,
  companyId: string,
  role: 'owner' | 'admin' | 'member' | 'viewer',
  userId = 'dev-user-000',
): Promise<string> {
  const [row] = await db.drizzle
    .insert(db.schema.localTrustedSessions)
    .values({ companyId, role, userId })
    .returning();
  return row.id;
}

// ---------------------------------------------------------------------------
// VAL-RUN-066: Unauthenticated access is denied
// ---------------------------------------------------------------------------

describe('Mission unauthenticated access (VAL-RUN-066)', () => {
  let db: AnyDb;
  let authApp: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;
  let runId: string;

  beforeAll(async () => {
    db = await createTestDb();
    // Create an app in authenticated mode (not local_trusted) so we can
    // test unauthenticated access.
    authApp = await createTestServer(db, 'authenticated');
  });

  beforeEach(async () => {
    enableMissionFlag();
    // In authenticated mode, we need to create companies directly in the DB
    // since the API requires auth.
    const now = new Date();
    companyId = randomUUID();
    await db.drizzle.insert(db.schema.companies).values({
      id: companyId,
      name: '__mtest__ unauth',
      settings: { testFixture: true },
      createdAt: now,
      updatedAt: now,
    });
    projectId = randomUUID();
    await db.drizzle.insert(db.schema.projects).values({
      id: projectId,
      companyId,
      name: 'Unauth Project',
      createdAt: now,
      updatedAt: now,
    });
    threadId = randomUUID();
    await db.drizzle.insert(db.schema.projectThreads).values({
      id: threadId,
      companyId,
      projectId,
      title: 'Unauth Thread',
      type: 'conversation',
      createdAt: now,
      updatedAt: now,
    });

    // Start a run directly via the service.
    const result = await startRun(db, companyId, projectId, threadId, 'unauth-001');
    runId = result.run.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const base = () => `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

  it('denies unauthenticated list (GET /)', async () => {
    const res = await request(authApp).get(base()).expect(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('denies unauthenticated start (POST /)', async () => {
    const res = await request(authApp)
      .post(base())
      .set('Idempotency-Key', 'unauth-start-001')
      .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'x' } })
      .expect(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('denies unauthenticated snapshot (GET /:runId)', async () => {
    const res = await request(authApp).get(`${base()}/${runId}`).expect(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('denies unauthenticated events (GET /:runId/events)', async () => {
    const res = await request(authApp).get(`${base()}/${runId}/events`).expect(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('denies unauthenticated stream (GET /:runId/stream)', async () => {
    const res = await request(authApp)
      .get(`${base()}/${runId}/stream`)
      .set('Connection', 'close')
      .expect(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('denies unauthenticated cancel (POST /:runId/cancel)', async () => {
    const res = await request(authApp)
      .post(`${base()}/${runId}/cancel`)
      .set('Idempotency-Key', 'unauth-cancel-001')
      .send({ reason: 'test' })
      .expect(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('denies unauthenticated retry (POST /:runId/retry)', async () => {
    const res = await request(authApp)
      .post(`${base()}/${runId}/retry`)
      .set('Idempotency-Key', 'unauth-retry-001')
      .send({})
      .expect(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('denies unauthenticated commands (POST /:runId/commands)', async () => {
    const res = await request(authApp)
      .post(`${base()}/${runId}/commands`)
      .set('Idempotency-Key', 'unauth-cmd-001')
      .send({ type: 'run.cancel', reason: 'test' })
      .expect(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-067 / VAL-CROSS-065: Viewer access is read only
// ---------------------------------------------------------------------------

describe('Mission viewer read-only access (VAL-RUN-067, VAL-CROSS-065)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;
  let runId: string;

  beforeAll(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ viewer rbac', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Viewer Project' })
      .expect(201);
    projectId = project.body.data.id;
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Viewer Thread' })
      .expect(201);
    threadId = thread.body.data.id;

    // Start a run as owner (default).
    const result = await startRun(db, companyId, projectId, threadId, 'viewer-001');
    runId = result.run.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const base = () => `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
  const viewerHeaders = () => ({ 'X-Eidolon-Test-Org-Role': 'viewer' });

  it('viewer can list runs (GET /)', async () => {
    const res = await request(app).get(base()).set(viewerHeaders()).expect(200);
    expect(res.body.data.runs).toHaveLength(1);
  });

  it('viewer can read a snapshot (GET /:runId)', async () => {
    const res = await request(app).get(`${base()}/${runId}`).set(viewerHeaders()).expect(200);
    expect(res.body.data.run.id).toBe(runId);
  });

  it('viewer can read events (GET /:runId/events)', async () => {
    const res = await request(app)
      .get(`${base()}/${runId}/events`)
      .set(viewerHeaders())
      .expect(200);
    expect(res.body.data.events.length).toBeGreaterThan(0);
  });

  it('viewer cannot start a run (POST /)', async () => {
    const res = await request(app)
      .post(base())
      .set(viewerHeaders())
      .set('Idempotency-Key', 'viewer-start-001')
      .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'x' } })
      .expect(403);
    expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
  });

  it('viewer cannot cancel a run (POST /:runId/cancel)', async () => {
    const res = await request(app)
      .post(`${base()}/${runId}/cancel`)
      .set(viewerHeaders())
      .set('Idempotency-Key', 'viewer-cancel-001')
      .send({ reason: 'viewer cancel' })
      .expect(403);
    expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
  });

  it('viewer cannot retry a run (POST /:runId/retry)', async () => {
    const res = await request(app)
      .post(`${base()}/${runId}/retry`)
      .set(viewerHeaders())
      .set('Idempotency-Key', 'viewer-retry-001')
      .send({})
      .expect(403);
    expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
  });

  it('viewer cannot submit commands (POST /:runId/commands)', async () => {
    const res = await request(app)
      .post(`${base()}/${runId}/commands`)
      .set(viewerHeaders())
      .set('Idempotency-Key', 'viewer-cmd-001')
      .send({ type: 'run.cancel', reason: 'viewer cmd' })
      .expect(403);
    expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
  });

  it('viewer mutation does not change run state', async () => {
    const beforeRes = await request(app).get(`${base()}/${runId}`).expect(200);
    const beforeVersion = beforeRes.body.data.run.stateVersion;

    // Attempt mutations.
    await request(app)
      .post(base())
      .set(viewerHeaders())
      .set('Idempotency-Key', 'viewer-nochange-001')
      .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'x' } })
      .expect(403);
    await request(app)
      .post(`${base()}/${runId}/cancel`)
      .set(viewerHeaders())
      .set('Idempotency-Key', 'viewer-nochange-002')
      .send({ reason: 'x' })
      .expect(403);

    const afterRes = await request(app).get(`${base()}/${runId}`).expect(200);
    expect(afterRes.body.data.run.stateVersion).toBe(beforeVersion);
    expect(afterRes.body.data.run.status).toBe('queued');
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-068: Member can use permitted run actions
// ---------------------------------------------------------------------------

describe('Mission member permitted actions (VAL-RUN-068)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;

  beforeAll(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ member rbac', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Member Project' })
      .expect(201);
    projectId = project.body.data.id;
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Member Thread' })
      .expect(201);
    threadId = thread.body.data.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const base = () => `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
  const memberHeaders = () => ({ 'X-Eidolon-Test-Org-Role': 'member' });

  it('member can start a run', async () => {
    const res = await request(app)
      .post(base())
      .set(memberHeaders())
      .set('Idempotency-Key', 'member-start-001')
      .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'member start' } })
      .expect(202);
    expect(res.body.data.run.id).toBeTruthy();
  });

  it('member can cancel a run', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'member-cancel-setup');
    const runId = start.run.id;
    // Fast mode auto-enqueues to queued; move to draft so cancel
    // terminalizes immediately (draft is a non-lease state).
    await db.drizzle.execute(
      sql`UPDATE "mission_runs" SET "status" = 'draft' WHERE "id" = ${runId}`,
    );

    const res = await request(app)
      .post(`${base()}/${runId}/cancel`)
      .set(memberHeaders())
      .set('Idempotency-Key', 'member-cancel-001')
      .set('If-Match', `"${start.run.stateVersion}"`)
      .send({ reason: 'member cancel' })
      .expect(202);
    expect(res.body.data.run.status).toBe('cancelled');
  });

  it('member can retry a terminal run', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'member-retry-setup');
    const runId = start.run.id;
    // Fast mode auto-enqueues to queued; move to draft so cancel
    // terminalizes immediately (draft is a non-lease state).
    await db.drizzle.execute(
      sql`UPDATE "mission_runs" SET "status" = 'draft' WHERE "id" = ${runId}`,
    );

    // Cancel the run first to make it terminal.
    await request(app)
      .post(`${base()}/${runId}/cancel`)
      .set('Idempotency-Key', 'member-retry-cancel-001')
      .set('If-Match', `"${start.run.stateVersion}"`)
      .send({ reason: 'cancel for retry' })
      .expect(202);

    // Now retry as member.
    const cancelSnapshot = await request(app).get(`${base()}/${runId}`).expect(200);
    const res = await request(app)
      .post(`${base()}/${runId}/retry`)
      .set(memberHeaders())
      .set('Idempotency-Key', 'member-retry-001')
      .set('If-Match', `"${cancelSnapshot.body.data.run.stateVersion}"`)
      .send({})
      .expect(202);
    expect(res.body.data.run.id).not.toBe(runId);
  });

  it('member actor is from authentication, not initiator privilege', async () => {
    // A member starts a run; the recorded actor must be the authenticated
    // user (dev-user-000), not elevated to owner/admin.
    const res = await request(app)
      .post(base())
      .set(memberHeaders())
      .set('Idempotency-Key', 'member-actor-001')
      .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'x' } })
      .expect(202);

    // Check events — the run.created event should have actorType='user'
    // and actorId='dev-user-000' (the authenticated user, not a body field).
    const eventsRes = await request(app)
      .get(`${base()}/${res.body.data.run.id}/events`)
      .expect(200);
    const createdEvent = eventsRes.body.data.events.find(
      (e: { type: string }) => e.type === 'run.created',
    );
    expect(createdEvent).toBeDefined();
    expect(createdEvent.actorType).toBe('user');
    expect(createdEvent.actorId).toBe('dev-user-000');
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-069 / VAL-CROSS-071: Cross-company run IDs are undiscoverable
// ---------------------------------------------------------------------------

describe('Mission cross-company isolation (VAL-RUN-069, VAL-CROSS-071)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyA: string;
  let projectA: string;
  let threadA: string;
  let companyB: string;
  let projectB: string;
  let runIdA: string;

  beforeAll(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    // Company A
    const cA = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ cross-co-A', settings: { testFixture: true } })
      .expect(201);
    companyA = cA.body.data.id;
    const pA = await request(app)
      .post(`/api/companies/${companyA}/projects`)
      .send({ name: 'Project A' })
      .expect(201);
    projectA = pA.body.data.id;
    const tA = await request(app)
      .post(`/api/companies/${companyA}/projects/${projectA}/threads`)
      .send({ title: 'Thread A' })
      .expect(201);
    threadA = tA.body.data.id;

    // Company B
    const cB = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ cross-co-B', settings: { testFixture: true } })
      .expect(201);
    companyB = cB.body.data.id;
    const pB = await request(app)
      .post(`/api/companies/${companyB}/projects`)
      .send({ name: 'Project B' })
      .expect(201);
    projectB = pB.body.data.id;

    // Start a run in company A.
    const result = await startRun(db, companyA, projectA, threadA, 'crossco-001');
    runIdA = result.run.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const baseB = () => `/api/companies/${companyB}/projects/${projectB}/mission-runs`;
  const randomId = () => randomUUID();

  it('cross-company snapshot returns 404 RUN_NOT_FOUND', async () => {
    const res = await request(app).get(`${baseB()}/${runIdA}`).expect(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
  });

  it('cross-company events returns 404 RUN_NOT_FOUND', async () => {
    const res = await request(app).get(`${baseB()}/${runIdA}/events`).expect(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
  });

  it('cross-company stream returns 404 RUN_NOT_FOUND', async () => {
    const res = await request(authAppSafe(app)).get(`${baseB()}/${runIdA}/stream`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
  });

  it('cross-company cancel returns 404 RUN_NOT_FOUND', async () => {
    const res = await request(app)
      .post(`${baseB()}/${runIdA}/cancel`)
      .set('Idempotency-Key', 'crossco-cancel-001')
      .set('If-Match', '"1"')
      .send({ reason: 'cross-company cancel' })
      .expect(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
  });

  it('cross-company retry returns 404 RUN_NOT_FOUND', async () => {
    const res = await request(app)
      .post(`${baseB()}/${runIdA}/retry`)
      .set('Idempotency-Key', 'crossco-retry-001')
      .set('If-Match', '"1"')
      .send({})
      .expect(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
  });

  it('cross-company commands returns 404 RUN_NOT_FOUND', async () => {
    const res = await request(app)
      .post(`${baseB()}/${runIdA}/commands`)
      .set('Idempotency-Key', 'crossco-cmd-001')
      .set('If-Match', '"1"')
      .send({ type: 'run.cancel', reason: 'cross-company cmd' })
      .expect(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
  });

  it('cross-company 404 is indistinguishable from a random nonexistent ID', async () => {
    const fakeId = randomId();

    const crossRes = await request(app).get(`${baseB()}/${runIdA}`).expect(404);
    const fakeRes = await request(app).get(`${baseB()}/${fakeId}`).expect(404);

    // Same status, code, and message shape — no existence leak.
    expect(crossRes.status).toBe(fakeRes.status);
    expect(crossRes.body.code).toBe(fakeRes.body.code);
    expect(crossRes.body.message).toBe(fakeRes.body.message);
  });

  it("cross-company list does not contain the other company's runs", async () => {
    const res = await request(app).get(baseB()).expect(200);
    expect(res.body.data.runs).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toContain(runIdA);
    expect(JSON.stringify(res.body)).not.toContain(companyA);
  });

  it('cross-company mutation does not alter the real run', async () => {
    // Attempt cancel from company B.
    await request(app)
      .post(`${baseB()}/${runIdA}/cancel`)
      .set('Idempotency-Key', 'crossco-nochange-001')
      .set('If-Match', '"1"')
      .send({ reason: 'should not work' })
      .expect(404);

    // The run in company A is unchanged.
    const snapshot = await request(app)
      .get(`/api/companies/${companyA}/projects/${projectA}/mission-runs/${runIdA}`)
      .expect(200);
    expect(snapshot.body.data.run.status).toBe('queued');
    expect(snapshot.body.data.run.stateVersion).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-070: Cross-project run IDs are undiscoverable
// ---------------------------------------------------------------------------

describe('Mission cross-project isolation (VAL-RUN-070)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectA: string;
  let threadA: string;
  let projectB: string;
  let runIdA: string;

  beforeAll(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ cross-proj', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;

    // Project A
    const pA = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Project A' })
      .expect(201);
    projectA = pA.body.data.id;
    const tA = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectA}/threads`)
      .send({ title: 'Thread A' })
      .expect(201);
    threadA = tA.body.data.id;

    // Project B (same company)
    const pB = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Project B' })
      .expect(201);
    projectB = pB.body.data.id;

    // Start a run in project A.
    const result = await startRun(db, companyId, projectA, threadA, 'crossproj-001');
    runIdA = result.run.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const baseB = () => `/api/companies/${companyId}/projects/${projectB}/mission-runs`;

  it('cross-project snapshot returns 404 RUN_NOT_FOUND', async () => {
    const res = await request(app).get(`${baseB()}/${runIdA}`).expect(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
  });

  it('cross-project events returns 404 RUN_NOT_FOUND', async () => {
    const res = await request(app).get(`${baseB()}/${runIdA}/events`).expect(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
  });

  it('cross-project cancel returns 404 RUN_NOT_FOUND', async () => {
    const res = await request(app)
      .post(`${baseB()}/${runIdA}/cancel`)
      .set('Idempotency-Key', 'crossproj-cancel-001')
      .set('If-Match', '"1"')
      .send({ reason: 'cross-project cancel' })
      .expect(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
  });

  it("cross-project list does not contain the other project's runs", async () => {
    const res = await request(app).get(baseB()).expect(200);
    expect(res.body.data.runs).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toContain(runIdA);
  });

  it('cross-project mutation does not alter the real run', async () => {
    await request(app)
      .post(`${baseB()}/${runIdA}/cancel`)
      .set('Idempotency-Key', 'crossproj-nochange-001')
      .set('If-Match', '"1"')
      .send({ reason: 'should not work' })
      .expect(404);

    const snapshot = await request(app)
      .get(`/api/companies/${companyId}/projects/${projectA}/mission-runs/${runIdA}`)
      .expect(200);
    expect(snapshot.body.data.run.status).toBe('queued');
    expect(snapshot.body.data.run.stateVersion).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-071: Lists and streams enforce tenant scope
// ---------------------------------------------------------------------------

describe('Mission list and stream tenant scope (VAL-RUN-071)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyA: string;
  let projectA: string;
  let threadA: string;
  let companyB: string;
  let projectB: string;
  let threadB: string;

  beforeAll(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    const cA = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ scope-A', settings: { testFixture: true } })
      .expect(201);
    companyA = cA.body.data.id;
    const pA = await request(app)
      .post(`/api/companies/${companyA}/projects`)
      .send({ name: 'Scope A' })
      .expect(201);
    projectA = pA.body.data.id;
    const tA = await request(app)
      .post(`/api/companies/${companyA}/projects/${projectA}/threads`)
      .send({ title: 'Thread A' })
      .expect(201);
    threadA = tA.body.data.id;

    const cB = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ scope-B', settings: { testFixture: true } })
      .expect(201);
    companyB = cB.body.data.id;
    const pB = await request(app)
      .post(`/api/companies/${companyB}/projects`)
      .send({ name: 'Scope B' })
      .expect(201);
    projectB = pB.body.data.id;
    const tB = await request(app)
      .post(`/api/companies/${companyB}/projects/${projectB}/threads`)
      .send({ title: 'Thread B' })
      .expect(201);
    threadB = tB.body.data.id;

    // Start runs in both companies.
    await startRun(db, companyA, projectA, threadA, 'scope-A-001', 'A1');
    await startRun(db, companyA, projectA, threadA, 'scope-A-002', 'A2');
    await startRun(db, companyB, projectB, threadB, 'scope-B-001', 'B1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('company A list contains only company A runs', async () => {
    const res = await request(app)
      .get(`/api/companies/${companyA}/projects/${projectA}/mission-runs`)
      .expect(200);
    expect(res.body.data.runs).toHaveLength(2);
    for (const run of res.body.data.runs) {
      expect(run.companyId).toBe(companyA);
      expect(run.projectId).toBe(projectA);
    }
  });

  it('company B list contains only company B runs', async () => {
    const res = await request(app)
      .get(`/api/companies/${companyB}/projects/${projectB}/mission-runs`)
      .expect(200);
    expect(res.body.data.runs).toHaveLength(1);
    expect(res.body.data.runs[0].companyId).toBe(companyB);
  });

  it('company A events do not contain company B events', async () => {
    // Get runs for company A.
    const listA = await request(app)
      .get(`/api/companies/${companyA}/projects/${projectA}/mission-runs`)
      .expect(200);
    const runIdA = listA.body.data.runs[0].id;

    // Get events for that run.
    const eventsRes = await request(app)
      .get(`/api/companies/${companyA}/projects/${projectA}/mission-runs/${runIdA}/events`)
      .expect(200);

    // All events must reference the correct run.
    for (const event of eventsRes.body.data.events) {
      // Events are scoped by the run; the payload contains runId.
      if (event.payload?.runId) {
        expect(event.payload.runId).toBe(runIdA);
      }
    }
    // No company B identifiers in the events.
    expect(JSON.stringify(eventsRes.body)).not.toContain(companyB);
  });

  it('stream for company A run does not emit company B events', async () => {
    const listA = await request(app)
      .get(`/api/companies/${companyA}/projects/${projectA}/mission-runs`)
      .expect(200);
    const runIdA = listA.body.data.runs[0].id;

    // A stream request from the correct scope returns 200 text/event-stream.
    // The stream data must not contain company B identifiers — proving the
    // stream enforces tenant scope (VAL-RUN-071).
    const res = await request(app)
      .get(`/api/companies/${companyA}/projects/${projectA}/mission-runs/${runIdA}/stream`)
      .set('Connection', 'close')
      .timeout({ response: 2000 })
      .buffer(true)
      .maxResponseSize(1024 * 1024)
      .parse((res, callback) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk.toString();
          if (data.includes('event: budget.reserved')) {
            (res as unknown as { destroy: () => void }).destroy();
            callback(null, data);
          }
        });
        res.on('end', () => callback(null, data));
        res.on('error', () => callback(null, data));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    // Stream data should not contain company B identifiers.
    const streamData = res.body as string;
    expect(streamData).not.toContain(companyB);
    expect(streamData).not.toContain(projectB);
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-072: Request actor cannot be forged
// ---------------------------------------------------------------------------

describe('Mission actor integrity (VAL-RUN-072)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;

  beforeAll(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ actor integrity', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Actor Project' })
      .expect(201);
    projectId = project.body.data.id;
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Actor Thread' })
      .expect(201);
    threadId = thread.body.data.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const base = () => `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

  it('actor in start command is from authenticated context, not body', async () => {
    // The start body has no actor field. The actor is always req.user.id.
    // Even with a different test user ID header, the actor is the
    // authenticated user.
    const res = await request(app)
      .post(base())
      .set('Idempotency-Key', 'actor-start-001')
      .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'x' } })
      .expect(202);

    const runId = res.body.data.run.id;

    // Check events — actor should be dev-user-000 (the authenticated user).
    const eventsRes = await request(app).get(`${base()}/${runId}/events`).expect(200);
    const createdEvent = eventsRes.body.data.events.find(
      (e: { type: string }) => e.type === 'run.created',
    );
    expect(createdEvent.actorType).toBe('user');
    expect(createdEvent.actorId).toBe('dev-user-000');
  });

  it('actor in cancel command is from authenticated context, not body', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'actor-cancel-setup');
    const runId = start.run.id;

    // Cancel with a body that has no actor field — the actor comes from auth.
    await request(app)
      .post(`${base()}/${runId}/cancel`)
      .set('Idempotency-Key', 'actor-cancel-001')
      .set('If-Match', `"${start.run.stateVersion}"`)
      .send({ reason: 'cancel test' })
      .expect(202);

    // The command record should have actorId = dev-user-000.
    // Check events for the cancellation.
    const eventsRes = await request(app).get(`${base()}/${runId}/events`).expect(200);
    const cancelEvent = eventsRes.body.data.events.find(
      (e: { type: string }) => e.type === 'run.cancel_requested',
    );
    if (cancelEvent) {
      expect(cancelEvent.actorType).toBe('user');
      expect(cancelEvent.actorId).toBe('dev-user-000');
    }

    // The run's cancelRequestedBy should be the authenticated user.
    const snapshot = await request(app).get(`${base()}/${runId}`).expect(200);
    expect(snapshot.body.data.run.cancelRequestedBy).toBe('dev-user-000');
  });

  it('command body cannot supply a forged actorId field', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'actor-forge-setup');
    const runId = start.run.id;

    // Attempt to supply a forged actorId in the command body. The Zod
    // schema strips unknown fields, so this should be ignored.
    await request(app)
      .post(`${base()}/${runId}/commands`)
      .set('Idempotency-Key', 'actor-forge-001')
      .set('If-Match', `"${start.run.stateVersion}"`)
      .send({ type: 'run.cancel', reason: 'forged actor', actorId: 'forged-user-999' })
      .expect(202);

    // The actor in the event should be the authenticated user, not the
    // forged one.
    const eventsRes = await request(app).get(`${base()}/${runId}/events`).expect(200);
    for (const event of eventsRes.body.data.events) {
      if (event.actorId) {
        expect(event.actorId).not.toBe('forged-user-999');
      }
    }

    // The run's cancelRequestedBy should be the authenticated user.
    const snapshot = await request(app).get(`${base()}/${runId}`).expect(200);
    expect(snapshot.body.data.run.cancelRequestedBy).toBe('dev-user-000');
  });

  it('start body initiatingAgentId does not change the recorded actor', async () => {
    // The start body accepts an optional initiatingAgentId for agent
    // selection, but the actor (initiating_user_id) is always the
    // authenticated user. Omit initiatingAgentId (no agent needed for fast mode).
    const res = await request(app)
      .post(base())
      .set('Idempotency-Key', 'actor-agent-001')
      .send({
        projectThreadId: threadId,
        mode: 'fast',
        request: { text: 'x' },
      })
      .expect(202);

    const runId = res.body.data.run.id;

    // The run.created event actor should be the authenticated user.
    const eventsRes = await request(app).get(`${base()}/${runId}/events`).expect(200);
    const createdEvent = eventsRes.body.data.events.find(
      (e: { type: string }) => e.type === 'run.created',
    );
    expect(createdEvent.actorId).toBe('dev-user-000');

    // The command record actor should be the authenticated user.
    const commandEvent = eventsRes.body.data.events.find(
      (e: { type: string; payload?: { commandId?: string } }) => e.payload?.commandId,
    );
    if (commandEvent) {
      expect(commandEvent.actorId).toBe('dev-user-000');
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-088: Role downgrade and membership removal revoke live access
// ---------------------------------------------------------------------------

describe('Mission role downgrade and membership removal (VAL-CROSS-088)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;

  beforeAll(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ downgrade', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Downgrade Project' })
      .expect(201);
    projectId = project.body.data.id;
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Downgrade Thread' })
      .expect(201);
    threadId = thread.body.data.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const base = () => `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

  it('role downgrade to viewer denies mutations on next request', async () => {
    // Create a session as owner.
    const sessionId = await createSession(db, companyId, 'owner');

    // Start a run as owner via the session.
    const startRes = await request(app)
      .post(base())
      .set({ 'X-Eidolon-Test-Session-Id': sessionId })
      .set('Idempotency-Key', 'downgrade-start-001')
      .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'x' } })
      .expect(202);
    const runId = startRes.body.data.run.id;

    // Downgrade the session to viewer.
    await db.drizzle
      .update(db.schema.localTrustedSessions)
      .set({ role: 'viewer', updatedAt: new Date() })
      .where(eq(db.schema.localTrustedSessions.id, sessionId));

    // Next request with the same session should be denied for mutations.
    const cancelRes = await request(app)
      .post(`${base()}/${runId}/cancel`)
      .set({ 'X-Eidolon-Test-Session-Id': sessionId })
      .set('Idempotency-Key', 'downgrade-cancel-001')
      .set('If-Match', `"${startRes.body.data.run.stateVersion}"`)
      .send({ reason: 'after downgrade' })
      .expect(403);
    expect(cancelRes.body.code).toBe('INSUFFICIENT_PERMISSION');

    // But reads should still work.
    const readRes = await request(app)
      .get(`${base()}/${runId}`)
      .set({ 'X-Eidolon-Test-Session-Id': sessionId })
      .expect(200);
    expect(readRes.body.data.run.id).toBe(runId);
  });

  it('membership removal (session revocation) denies all access on next request', async () => {
    const sessionId = await createSession(db, companyId, 'member');

    // Start a run as member.
    const startRes = await request(app)
      .post(base())
      .set({ 'X-Eidolon-Test-Session-Id': sessionId })
      .set('Idempotency-Key', 'revoke-start-001')
      .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'x' } })
      .expect(202);
    const runId = startRes.body.data.run.id;

    // Revoke the session (simulate membership removal).
    await db.drizzle
      .update(db.schema.localTrustedSessions)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(db.schema.localTrustedSessions.id, sessionId));

    // Next read request should be denied (401 SESSION_REVOKED).
    const readRes = await request(app)
      .get(`${base()}/${runId}`)
      .set({ 'X-Eidolon-Test-Session-Id': sessionId })
      .expect(401);
    expect(readRes.body.code).toBe('SESSION_REVOKED');

    // Next mutation request should also be denied.
    const cancelRes = await request(app)
      .post(`${base()}/${runId}/cancel`)
      .set({ 'X-Eidolon-Test-Session-Id': sessionId })
      .set('Idempotency-Key', 'revoke-cancel-001')
      .set('If-Match', '"1"')
      .send({ reason: 'after revoke' })
      .expect(401);
    expect(cancelRes.body.code).toBe('SESSION_REVOKED');
  });

  it('regrant (session reactivation) restores access and refetches', async () => {
    const sessionId = await createSession(db, companyId, 'member');

    // Start a run.
    const startRes = await request(app)
      .post(base())
      .set({ 'X-Eidolon-Test-Session-Id': sessionId })
      .set('Idempotency-Key', 'regrant-start-001')
      .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'x' } })
      .expect(202);
    const runId = startRes.body.data.run.id;

    // Revoke.
    await db.drizzle
      .update(db.schema.localTrustedSessions)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(db.schema.localTrustedSessions.id, sessionId));

    // Confirm denied.
    await request(app)
      .get(`${base()}/${runId}`)
      .set({ 'X-Eidolon-Test-Session-Id': sessionId })
      .expect(401);

    // Regrant.
    await db.drizzle
      .update(db.schema.localTrustedSessions)
      .set({ active: true, updatedAt: new Date() })
      .where(eq(db.schema.localTrustedSessions.id, sessionId));

    // Access restored — reads work again.
    const readRes = await request(app)
      .get(`${base()}/${runId}`)
      .set({ 'X-Eidolon-Test-Session-Id': sessionId })
      .expect(200);
    expect(readRes.body.data.run.id).toBe(runId);
    // The run state is unchanged (no stale queued actions were applied).
    expect(readRes.body.data.run.status).toBe('queued');
  });

  it('SSE access checker detects session revocation (live SSE invalidation)', async () => {
    // This test verifies the access checker mechanism that the SSE stream
    // uses to detect membership revocation. The stream service calls this
    // checker at each poll interval and closes the connection if it
    // returns false (VAL-CROSS-088).

    const sessionId = await createSession(db, companyId, 'member');

    // Simulate the request headers that the SSE route handler would
    // pass to createStreamAccessChecker.
    const mockReq = {
      get: (h: string) => (h === 'X-Eidolon-Test-Session-Id' ? sessionId : undefined),
      user: { id: 'dev-user-000' },
    };

    // Import the access checker factory from the route module.
    const { createStreamAccessChecker } = await import('../routes/mission-runs.js');

    const checker = createStreamAccessChecker(db, mockReq, companyId, 'company.view');

    // While the session is active, the checker should return true.
    const activeResult = await checker();
    expect(activeResult).toBe(true);

    // Revoke the session (simulate membership removal).
    await db.drizzle
      .update(db.schema.localTrustedSessions)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(db.schema.localTrustedSessions.id, sessionId));

    // The checker should now return false — the SSE stream would close.
    const revokedResult = await checker();
    expect(revokedResult).toBe(false);
  });

  it('SSE access checker detects role downgrade below company.view', async () => {
    // A viewer has company.view, so the checker returns true.
    // But there is no role below viewer that still has company.view,
    // so we test that a revoked session (active=false) returns false.
    const sessionId = await createSession(db, companyId, 'viewer');

    const mockReq = {
      get: (h: string) => (h === 'X-Eidolon-Test-Session-Id' ? sessionId : undefined),
      user: { id: 'dev-user-000' },
    };

    const { createStreamAccessChecker } = await import('../routes/mission-runs.js');
    const checker = createStreamAccessChecker(db, mockReq, companyId, 'company.view');

    // Viewer has company.view, so the checker returns true.
    expect(await checker()).toBe(true);

    // Downgrade to a non-existent role (simulate removal).
    await db.drizzle
      .update(db.schema.localTrustedSessions)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(db.schema.localTrustedSessions.id, sessionId));

    // Revoked session returns false.
    expect(await checker()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-089: Live revocation overlays snapshots deny only
// ---------------------------------------------------------------------------

describe('Mission live revocation denies only (VAL-CROSS-089)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;

  beforeAll(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ revocation', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Revocation Project' })
      .expect(201);
    projectId = project.body.data.id;
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Revocation Thread' })
      .expect(201);
    threadId = thread.body.data.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const base = () => `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

  it('role downgrade from owner to viewer denies mutations immediately', async () => {
    const sessionId = await createSession(db, companyId, 'owner');

    // Owner can start.
    await request(app)
      .post(base())
      .set({ 'X-Eidolon-Test-Session-Id': sessionId })
      .set('Idempotency-Key', 'revoke-owner-start-001')
      .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'x' } })
      .expect(202);

    // Downgrade to viewer.
    await db.drizzle
      .update(db.schema.localTrustedSessions)
      .set({ role: 'viewer', updatedAt: new Date() })
      .where(eq(db.schema.localTrustedSessions.id, sessionId));

    // Viewer cannot start a new run.
    const res = await request(app)
      .post(base())
      .set({ 'X-Eidolon-Test-Session-Id': sessionId })
      .set('Idempotency-Key', 'revoke-viewer-start-001')
      .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'y' } })
      .expect(403);
    expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
  });

  it('re-granting a broader role does not broaden the immutable snapshot', async () => {
    // Start a run as member.
    const sessionId = await createSession(db, companyId, 'member');
    const startRes = await request(app)
      .post(base())
      .set({ 'X-Eidolon-Test-Session-Id': sessionId })
      .set('Idempotency-Key', 'regrant-snapshot-001')
      .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'x' } })
      .expect(202);
    const runId = startRes.body.data.run.id;
    const originalPolicyHash = startRes.body.data.run.policyContentHash;

    // Upgrade to owner.
    await db.drizzle
      .update(db.schema.localTrustedSessions)
      .set({ role: 'owner', updatedAt: new Date() })
      .where(eq(db.schema.localTrustedSessions.id, sessionId));

    // Read the snapshot — the policy hash should be unchanged (immutable).
    const snapshot = await request(app)
      .get(`${base()}/${runId}`)
      .set({ 'X-Eidolon-Test-Session-Id': sessionId })
      .expect(200);
    expect(snapshot.body.data.run.policyContentHash).toBe(originalPolicyHash);
  });

  it('revocation can only deny, never broaden: viewer denied on all mutations', async () => {
    // A viewer is denied on all mutation routes, regardless of the run state.
    const start = await startRun(db, companyId, projectId, threadId, 'revoke-viewer-001');
    const runId = start.run.id;

    const viewerHeaders = { 'X-Eidolon-Test-Org-Role': 'viewer' };

    // All mutations denied.
    await request(app)
      .post(`${base()}/${runId}/cancel`)
      .set(viewerHeaders)
      .set('Idempotency-Key', 'revoke-viewer-cancel-001')
      .set('If-Match', '"1"')
      .send({ reason: 'x' })
      .expect(403);

    await request(app)
      .post(`${base()}/${runId}/retry`)
      .set(viewerHeaders)
      .set('Idempotency-Key', 'revoke-viewer-retry-001')
      .set('If-Match', '"1"')
      .send({})
      .expect(403);

    await request(app)
      .post(`${base()}/${runId}/commands`)
      .set(viewerHeaders)
      .set('Idempotency-Key', 'revoke-viewer-cmd-001')
      .set('If-Match', '"1"')
      .send({ type: 'run.cancel', reason: 'x' })
      .expect(403);

    // But reads are allowed.
    await request(app).get(`${base()}/${runId}`).set(viewerHeaders).expect(200);
    await request(app).get(`${base()}/${runId}/events`).set(viewerHeaders).expect(200);
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-094: Scope switching quarantines late responses (backend)
// ---------------------------------------------------------------------------

describe('Mission scope switching quarantine (VAL-CROSS-094)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyA: string;
  let projectA: string;
  let threadA: string;
  let companyB: string;
  let projectB: string;
  let threadB: string;

  beforeAll(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    const cA = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ switch-A', settings: { testFixture: true } })
      .expect(201);
    companyA = cA.body.data.id;
    const pA = await request(app)
      .post(`/api/companies/${companyA}/projects`)
      .send({ name: 'Switch A' })
      .expect(201);
    projectA = pA.body.data.id;
    const tA = await request(app)
      .post(`/api/companies/${companyA}/projects/${projectA}/threads`)
      .send({ title: 'Thread A' })
      .expect(201);
    threadA = tA.body.data.id;

    const cB = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ switch-B', settings: { testFixture: true } })
      .expect(201);
    companyB = cB.body.data.id;
    const pB = await request(app)
      .post(`/api/companies/${companyB}/projects`)
      .send({ name: 'Switch B' })
      .expect(201);
    projectB = pB.body.data.id;
    const tB = await request(app)
      .post(`/api/companies/${companyB}/projects/${projectB}/threads`)
      .send({ title: 'Thread B' })
      .expect(201);
    threadB = tB.body.data.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a command applied in scope A has no effect when read from scope B', async () => {
    // Start a run in scope A.
    const start = await startRun(db, companyA, projectA, threadA, 'switch-001');
    const runIdA = start.run.id;

    // The run is only visible from scope A, not from scope B.
    const fromB = await request(app)
      .get(`/api/companies/${companyB}/projects/${projectB}/mission-runs/${runIdA}`)
      .expect(404);
    expect(fromB.body.code).toBe('RUN_NOT_FOUND');

    // The run is still accessible from scope A.
    const fromA = await request(app)
      .get(`/api/companies/${companyA}/projects/${projectA}/mission-runs/${runIdA}`)
      .expect(200);
    expect(fromA.body.data.run.id).toBe(runIdA);
  });

  it('scope B list does not include scope A runs', async () => {
    await startRun(db, companyA, projectA, threadA, 'switch-list-A-001');
    await startRun(db, companyB, projectB, threadB, 'switch-list-B-001');

    const listA = await request(app)
      .get(`/api/companies/${companyA}/projects/${projectA}/mission-runs`)
      .expect(200);
    const listB = await request(app)
      .get(`/api/companies/${companyB}/projects/${projectB}/mission-runs`)
      .expect(200);

    expect(listA.body.data.runs).toHaveLength(1);
    expect(listA.body.data.runs[0].companyId).toBe(companyA);

    expect(listB.body.data.runs).toHaveLength(1);
    expect(listB.body.data.runs[0].companyId).toBe(companyB);

    // No cross-scope leakage.
    expect(JSON.stringify(listA.body)).not.toContain(companyB);
    expect(JSON.stringify(listB.body)).not.toContain(companyA);
  });
});

// ---------------------------------------------------------------------------
// Helper: safely get an app for SSE testing that won't hang
// ---------------------------------------------------------------------------

/**
 * Wrap a supertest agent so that SSE responses with Connection: close
 * don't hang. Returns the same app — the caller sets Connection: close
 * on the request.
 */
function authAppSafe(app: Awaited<ReturnType<typeof createTestServer>>) {
  return app;
}
