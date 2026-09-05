import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { createTestDb, createTestServer } from '../test-utils.js';
import { MissionStartService } from '../services/mission/start.js';
import { MissionSnapshotService } from '../services/mission/snapshot.js';
import {
  MissionWorkerHealthService,
  WORKER_HEARTBEAT_STALE_MS,
} from '../services/mission/worker-health.js';

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

/** Insert a worker heartbeat row with an explicit last_heartbeat_at. */
async function seedHeartbeat(db: AnyDb, workerId: string, lastHeartbeatAt: Date): Promise<void> {
  // Use the health service with an injected clock so the Drizzle query
  // builder applies the JS-side $defaultFn for the primary key id.
  const health = new MissionWorkerHealthService(db, { clock: () => lastHeartbeatAt });
  await health.recordHeartbeat(workerId);
}

describe('Mission run snapshot queueHealth (VAL-RUN-088)', () => {
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
    // The heartbeats registry is global (not tenant-scoped), so clear it
    // between tests to avoid cross-test liveness leakage.
    await db.drizzle.execute(sql`TRUNCATE TABLE "mission_worker_heartbeats"`);
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ queue health', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Queue Health Project' })
      .expect(201);
    projectId = project.body.data.id;
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Queue Health Thread' })
      .expect(201);
    threadId = thread.body.data.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const detailUrl = (runId: string) =>
    `/api/companies/${companyId}/projects/${projectId}/mission-runs/${runId}`;

  it('always includes queueHealth in the snapshot, even with no worker heartbeat', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'qh-nohb-001');
    const res = await request(app).get(detailUrl(start.run.id)).expect(200);
    expect(res.body.data.run).toHaveProperty('queueHealth');
    // No worker has heartbeated → unavailable.
    expect(res.body.data.run.queueHealth).toBe('unavailable');
  });

  it('reports queueHealth "available" when a worker heartbeat is recent', async () => {
    // Seed a heartbeat at the current real time.
    await seedHeartbeat(db, 'worker-recent', new Date());
    const start = await startRun(db, companyId, projectId, threadId, 'qh-recent-001');

    const res = await request(app).get(detailUrl(start.run.id)).expect(200);
    expect(res.body.data.run.queueHealth).toBe('available');
  });

  it('reports queueHealth "unavailable" when the only heartbeat is older than 30s', async () => {
    // Seed a heartbeat 31 seconds in the past — just past the 30s window.
    const stale = new Date(Date.now() - (WORKER_HEARTBEAT_STALE_MS + 1000));
    await seedHeartbeat(db, 'worker-stale', stale);
    const start = await startRun(db, companyId, projectId, threadId, 'qh-stale-001');

    const res = await request(app).get(detailUrl(start.run.id)).expect(200);
    expect(res.body.data.run.queueHealth).toBe('unavailable');
  });

  it('reports "available" when at least one of several workers is recent, ignoring stale ones', async () => {
    // One stale worker and one recent worker.
    await seedHeartbeat(db, 'worker-stale-a', new Date(Date.now() - 60_000));
    await seedHeartbeat(db, 'worker-recent-b', new Date());
    const start = await startRun(db, companyId, projectId, threadId, 'qh-mixed-001');

    const res = await request(app).get(detailUrl(start.run.id)).expect(200);
    expect(res.body.data.run.queueHealth).toBe('available');
  });

  it('reflects the latest heartbeat: available immediately after, unavailable after staleness', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'qh-transition-001');

    // Initially no heartbeat → unavailable.
    let res = await request(app).get(detailUrl(start.run.id)).expect(200);
    expect(res.body.data.run.queueHealth).toBe('unavailable');

    // Worker heartbeats → available.
    await seedHeartbeat(db, 'worker-trans', new Date());
    res = await request(app).get(detailUrl(start.run.id)).expect(200);
    expect(res.body.data.run.queueHealth).toBe('available');

    // Worker goes silent (heartbeat becomes stale) → unavailable.
    await db.drizzle.execute(sql`
      UPDATE "mission_worker_heartbeats" SET "last_heartbeat_at" = ${new Date(
        Date.now() - 45_000,
      ).toISOString()}::timestamptz WHERE "worker_id" = 'worker-trans'
    `);
    res = await request(app).get(detailUrl(start.run.id)).expect(200);
    expect(res.body.data.run.queueHealth).toBe('unavailable');
  });
});

// ---------------------------------------------------------------------------
// Unit-level: MissionWorkerHealthService with injected clock.
// ---------------------------------------------------------------------------

describe('MissionWorkerHealthService queueHealth derivation (VAL-RUN-088)', () => {
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
    await db.drizzle.execute(sql`TRUNCATE TABLE "mission_worker_heartbeats"`);
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ queue health unit', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'QH Unit Project' })
      .expect(201);
    projectId = project.body.data.id;
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'QH Unit Thread' })
      .expect(201);
    threadId = thread.body.data.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('derives availability deterministically from the injected clock', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'qh-unit-001');
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const health = new MissionWorkerHealthService(db, { clock: () => t0 });
    const snapshotService = new MissionSnapshotService(db, health);

    // No heartbeat at t0 → unavailable.
    let snap = await snapshotService.getSnapshot(companyId, projectId, start.run.id);
    expect(snap.queueHealth).toBe('unavailable');

    // Worker heartbeats at t0 → available.
    await health.recordHeartbeat('worker-unit');
    snap = await snapshotService.getSnapshot(companyId, projectId, start.run.id);
    expect(snap.queueHealth).toBe('available');

    // Advance clock past the 30s window with no new heartbeat → unavailable.
    const staleHealth = new MissionWorkerHealthService(db, {
      clock: () => new Date(t0.getTime() + WORKER_HEARTBEAT_STALE_MS + 1),
    });
    const staleSnapshotService = new MissionSnapshotService(db, staleHealth);
    snap = await staleSnapshotService.getSnapshot(companyId, projectId, start.run.id);
    expect(snap.queueHealth).toBe('unavailable');
  });
});
