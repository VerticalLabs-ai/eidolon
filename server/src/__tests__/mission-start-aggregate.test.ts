import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, createTestServer } from '../test-utils.js';
import { MissionStartService } from '../services/mission/start.js';

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

async function execRows<T extends Record<string, unknown>>(
  db: AnyDb,
  query: ReturnType<typeof sql>,
): Promise<T[]> {
  const result = await db.drizzle.execute(query);
  return (result as unknown as { rows: T[] }).rows;
}

async function seedCompany(db: AnyDb, name: string) {
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "companies" ("id", "name", "status", "budget_monthly_cents", "spent_monthly_cents", "settings", "created_at", "updated_at")
    VALUES (${id}, ${name}, 'active', 100000, 0, '{}'::jsonb, ${now}, ${now})
  `);
  return id;
}

async function seedProject(db: AnyDb, companyId: string, name: string) {
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "projects" ("id", "company_id", "name", "status", "created_at", "updated_at")
    VALUES (${id}, ${companyId}, ${name}, 'active', ${now}, ${now})
  `);
  return id;
}

async function seedThread(db: AnyDb, companyId: string, projectId: string, title: string) {
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "project_threads" ("id", "company_id", "project_id", "title", "type", "status", "created_at", "updated_at")
    VALUES (${id}, ${companyId}, ${projectId}, ${title}, 'conversation', 'active', ${now}, ${now})
  `);
  return id;
}

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

// ---------------------------------------------------------------------------
// VAL-RUN-113 / schema: forward-only tenant-scoped persistence constraints
// ---------------------------------------------------------------------------

describe('Mission schema: migration and constraints', () => {
  let db: AnyDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  it('mission_runs is company-scoped with the required lifecycle columns', async () => {
    const rows = await execRows<{ column_name: string }>(
      db,
      sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'mission_runs' AND column_name IN
        ('id','company_id','project_id','project_thread_id','root_run_id','status',
         'state_version','last_event_sequence','terminal_at','request_content_hash',
         'policy_snapshot_id','resolved_mode','actual_cost_cents')
    `,
    );
    const names = rows.map((r) => r.column_name);
    expect(names).toContain('id');
    expect(names).toContain('company_id');
    expect(names).toContain('project_id');
    expect(names).toContain('project_thread_id');
    expect(names).toContain('root_run_id');
    expect(names).toContain('status');
    expect(names).toContain('state_version');
    expect(names).toContain('last_event_sequence');
    expect(names).toContain('terminal_at');
    expect(names).toContain('request_content_hash');
    expect(names).toContain('policy_snapshot_id');
    expect(names).toContain('resolved_mode');
    expect(names).toContain('actual_cost_cents');
  });

  it('enforces terminal_at lifecycle check on mission_runs', async () => {
    const rows = await execRows<{ consrc: string }>(
      db,
      sql`
      SELECT pg_get_constraintdef(oid) AS consrc FROM pg_constraint
      WHERE conrelid = '"mission_runs"'::regclass AND conname = 'chk_mission_runs_terminal_at'
    `,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].consrc).toContain('terminal_at');
    expect(rows[0].consrc).toContain('completed');
  });

  it('enforces nonnegative counters and depth on mission_runs', async () => {
    const rows = await execRows<{ conname: string }>(
      db,
      sql`
      SELECT conname FROM pg_constraint
      WHERE conrelid = '"mission_runs"'::regclass AND conname LIKE 'chk_mission_runs_%'
    `,
    );
    const names = rows.map((r) => r.conname);
    expect(names).toContain('chk_mission_runs_counters_nonneg');
    expect(names).toContain('chk_mission_runs_depth_nonneg');
    expect(names).toContain('chk_mission_runs_parent_not_self');
  });

  it('enforces budget settled+released <= reserved on reservations', async () => {
    const rows = await execRows<{ conname: string }>(
      db,
      sql`
      SELECT conname FROM pg_constraint
      WHERE conrelid = '"budget_reservations"'::regclass AND conname = 'chk_budget_reservations_settled_le_reserved'
    `,
    );
    expect(rows.length).toBe(1);
  });

  it('enforces positive event sequence and bounded idempotency key', async () => {
    const evRows = await execRows<{ conname: string }>(
      db,
      sql`
      SELECT conname FROM pg_constraint WHERE conrelid = '"run_events"'::regclass AND conname = 'chk_run_events_sequence_pos'
    `,
    );
    expect(evRows.length).toBe(1);
    const cmdRows = await execRows<{ conname: string }>(
      db,
      sql`
      SELECT conname FROM pg_constraint WHERE conrelid = '"run_commands"'::regclass AND conname = 'chk_run_commands_idempotency_key_len'
    `,
    );
    expect(cmdRows.length).toBe(1);
  });

  it('enforces unique run-local event sequence and start idempotency', async () => {
    const seqIdx = await execRows<{ indexname: string }>(
      db,
      sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'run_events' AND indexname = 'uq_run_events_sequence'
    `,
    );
    expect(seqIdx.length).toBe(1);
    const startIdx = await execRows<{ indexname: string }>(
      db,
      sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'run_commands' AND indexname = 'uq_run_commands_start_idempotency'
    `,
    );
    expect(startIdx.length).toBe(1);
  });

  it('run_policy_snapshots content_hash is indexed for binding lookups', async () => {
    const rows = await execRows<{ indexname: string }>(
      db,
      sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'run_policy_snapshots' AND indexname = 'idx_run_policy_snapshots_content_hash'
    `,
    );
    expect(rows.length).toBe(1);
  });

  it('rejects a terminal status without terminal_at (lifecycle immutability)', async () => {
    const companyId = await seedCompany(db, '__mtest__ lifecycle');
    const projectId = await seedProject(db, companyId, 'P');
    const threadId = await seedThread(db, companyId, projectId, 'T');
    const runId = randomUUID();
    const now = new Date();
    await expect(
      db.drizzle.execute(sql`
        INSERT INTO "mission_runs" ("id","company_id","project_id","project_thread_id","root_run_id",
          "request_envelope","request_content_hash","resolved_mode","status","state_version",
          "last_event_sequence","created_at","updated_at")
        VALUES (${runId},${companyId},${projectId},${threadId},${runId},
          '{}'::jsonb, 'x', 'fast', 'completed', 1, 0, ${now}, ${now})
      `),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Mission start API: VAL-CROSS-003, VAL-RUN-009, VAL-RUN-010, VAL-RUN-011,
// VAL-RUN-012, VAL-RUN-013
// ---------------------------------------------------------------------------

async function countRuns(db: AnyDb, companyId: string, projectId: string): Promise<number> {
  const rows = await execRows<{ c: number }>(
    db,
    sql`
    SELECT count(*)::int AS c FROM "mission_runs" WHERE company_id = ${companyId} AND project_id = ${projectId}
  `,
  );
  return rows[0].c;
}

describe('Mission start API', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;
  let otherCompanyId: string;
  let otherProjectId: string;
  let otherThreadId: string;

  beforeAll(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ mission start', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Mission Project' })
      .expect(201);
    projectId = project.body.data.id;

    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Mission Thread' })
      .expect(201);
    threadId = thread.body.data.id;

    // A second company/project/thread for cross-scope tests.
    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ other scope', settings: { testFixture: true } })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;
    const otherProject = await request(app)
      .post(`/api/companies/${otherCompanyId}/projects`)
      .send({ name: 'Other Project' })
      .expect(201);
    otherProjectId = otherProject.body.data.id;
    const otherThread = await request(app)
      .post(`/api/companies/${otherCompanyId}/projects/${otherProjectId}/threads`)
      .send({ title: 'Other Thread' })
      .expect(201);
    otherThreadId = otherThread.body.data.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const startUrl = () => `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

  const validBody = (thread: string = threadId) => ({
    projectThreadId: thread,
    mode: 'fast',
    request: { text: 'Summarize the quarterly report.' },
  });

  // VAL-CROSS-003 / VAL-RUN-009 / VAL-RUN-010
  it('starts asynchronously with 202, Location, ETag, run+command, and links.ui', async () => {
    const res = await request(app)
      .post(startUrl())
      .set('Idempotency-Key', 'start-001')
      .send(validBody())
      .expect(202);

    expect(res.body.data.run).toBeDefined();
    expect(res.body.data.command).toBeDefined();
    expect(res.body.data.run.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.data.command.type).toBe('run.start');
    expect(res.body.data.command.status).toBe('applied');
    expect(res.body.data.command.resultStatusCode).toBe(202);
    expect(res.headers.location).toContain(res.body.data.run.id);
    expect(res.headers.etag).toBe(`"${res.body.data.run.stateVersion}"`);
    expect(res.body.links.ui).toContain(companyId);
    expect(res.body.links.ui).toContain(projectId);
    expect(res.body.links.ui).toContain(res.body.data.run.id);

    // Run is non-terminal (draft) — no terminal event yet.
    expect(res.body.data.run.status).toBe('draft');
    expect(res.body.data.run.lastEventSequence).toBe(4);
    expect(res.body.data.run.budget.reservedCents).toBeGreaterThan(0);
  });

  // VAL-RUN-010 / VAL-CROSS-003: Location GET resolves to the scoped run JSON
  it('Location GET returns the scoped run with matching identity and ETag', async () => {
    const start = await request(app)
      .post(startUrl())
      .set('Idempotency-Key', 'start-loc-001')
      .send(validBody())
      .expect(202);

    const location = start.headers.location;
    const getRes = await request(app).get(location).expect(200);
    expect(getRes.body.data.run.id).toBe(start.body.data.run.id);
    expect(getRes.body.data.run.companyId).toBe(companyId);
    expect(getRes.body.data.run.projectId).toBe(projectId);
    expect(getRes.body.data.run.projectThreadId).toBe(threadId);
    expect(getRes.headers.etag).toBe(`"${start.body.data.run.stateVersion}"`);
    expect(getRes.body.data.links.ui).toContain(start.body.data.run.id);
  });

  // VAL-RUN-011
  it('rejects a start without an Idempotency-Key and creates no run', async () => {
    const before = await countRuns(db, companyId, projectId);

    const res = await request(app).post(startUrl()).send(validBody()).expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');

    const after = await countRuns(db, companyId, projectId);
    expect(after).toBe(before);
  });

  // VAL-RUN-012
  it('rejects a malformed start with 400 VALIDATION_ERROR and creates no run', async () => {
    const before = await countRuns(db, companyId, projectId);

    // Missing required request.text
    const res = await request(app)
      .post(startUrl())
      .set('Idempotency-Key', 'start-bad-001')
      .send({ projectThreadId: threadId, mode: 'fast', request: {} })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');

    // Unknown mode
    await request(app)
      .post(startUrl())
      .set('Idempotency-Key', 'start-bad-002')
      .send({ projectThreadId: threadId, mode: 'turbo', request: { text: 'x' } })
      .expect(400);

    const after = await countRuns(db, companyId, projectId);
    expect(after).toBe(before);
  });

  // VAL-RUN-013
  it('rejects a thread from another project/company with 404 and creates no run', async () => {
    const before = await countRuns(db, companyId, projectId);

    const res = await request(app)
      .post(startUrl())
      .set('Idempotency-Key', 'start-cross-001')
      .send(validBody(otherThreadId))
      .expect(404);
    expect(res.body.code).toBe('THREAD_NOT_FOUND');
    // Does not reveal the other scope
    expect(JSON.stringify(res.body)).not.toContain(otherCompanyId);

    const after = await countRuns(db, companyId, projectId);
    expect(after).toBe(before);
  });

  it('returns 404 FEATURE_NOT_AVAILABLE when the flag is disabled', async () => {
    disableMissionFlag();
    const res = await request(app)
      .post(startUrl())
      .set('Idempotency-Key', 'start-disabled-001')
      .send(validBody())
      .expect(404);
    expect(res.body.code).toBe('FEATURE_NOT_AVAILABLE');
  });

  it('replays an identical start with the same idempotency key', async () => {
    const first = await request(app)
      .post(startUrl())
      .set('Idempotency-Key', 'start-replay-001')
      .send(validBody())
      .expect(202);
    const second = await request(app)
      .post(startUrl())
      .set('Idempotency-Key', 'start-replay-001')
      .send(validBody())
      .expect(202);
    expect(second.body.data.run.id).toBe(first.body.data.run.id);
    expect(second.body.data.command.id).toBe(first.body.data.command.id);
  });

  it('rejects idempotency key reuse with different content', async () => {
    await request(app)
      .post(startUrl())
      .set('Idempotency-Key', 'start-conflict-001')
      .send(validBody())
      .expect(202);
    const res = await request(app)
      .post(startUrl())
      .set('Idempotency-Key', 'start-conflict-001')
      .send({ projectThreadId: threadId, mode: 'deep_work', request: { text: 'Different' } })
      .expect(409);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('GET run detail returns 404 for a cross-scope run id', async () => {
    const start = await request(app)
      .post(startUrl())
      .set('Idempotency-Key', 'start-xscope-001')
      .send(validBody())
      .expect(202);
    const runId = start.body.data.run.id;

    // Read the run through the other company's project route.
    const crossUrl = `/api/companies/${otherCompanyId}/projects/${otherProjectId}/mission-runs/${runId}`;
    const res = await request(app).get(crossUrl).expect(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-113: one complete durable aggregate; failpoints leave none
// ---------------------------------------------------------------------------

describe('Mission start aggregate atomicity (VAL-RUN-113)', () => {
  let db: AnyDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    enableMissionFlag();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function seedScope() {
    const companyId = await seedCompany(db, '__mtest__ aggregate');
    const projectId = await seedProject(db, companyId, 'P');
    const threadId = await seedThread(db, companyId, projectId, 'T');
    return { companyId, projectId, threadId };
  }

  async function countAggregate(db: AnyDb, companyId: string, projectId: string) {
    const [runs] = await execRows<{ c: number }>(
      db,
      sql`
      SELECT count(*)::int AS c FROM "mission_runs" WHERE company_id = ${companyId} AND project_id = ${projectId}
    `,
    );
    const [cmds] = await execRows<{ c: number }>(
      db,
      sql`
      SELECT count(*)::int AS c FROM "run_commands" WHERE company_id = ${companyId} AND project_id = ${projectId}
    `,
    );
    const [evts] = await execRows<{ c: number }>(
      db,
      sql`
      SELECT count(*)::int AS c FROM "run_events" WHERE company_id = ${companyId} AND project_id = ${projectId}
    `,
    );
    const [res] = await execRows<{ c: number }>(
      db,
      sql`
      SELECT count(*)::int AS c FROM "budget_reservations" br
      JOIN "mission_runs" mr ON mr.id = br.run_id
      WHERE mr.company_id = ${companyId} AND mr.project_id = ${projectId}
    `,
    );
    const [allocs] = await execRows<{ c: number }>(
      db,
      sql`
      SELECT count(*)::int AS c FROM "budget_allocations" ba
      JOIN "mission_runs" mr ON mr.id = ba.run_id
      WHERE mr.company_id = ${companyId} AND mr.project_id = ${projectId}
    `,
    );
    const [pols] = await execRows<{ c: number }>(
      db,
      sql`
      SELECT count(*)::int AS c FROM "run_policy_snapshots" WHERE company_id = ${companyId}
    `,
    );
    return {
      runs: runs.c,
      commands: cmds.c,
      events: evts.c,
      reservations: res.c,
      allocations: allocs.c,
      policies: pols.c,
    };
  }

  it('a successful start commits exactly one complete aggregate', async () => {
    const { companyId, projectId, threadId } = await seedScope();
    const service = new MissionStartService(db);
    const result = await service.start({
      companyId,
      projectId,
      idempotencyKey: 'agg-ok-001',
      body: { projectThreadId: threadId, mode: 'fast', request: { text: 'Do work' } },
      actorType: 'user',
      actorId: 'dev-user-000',
    });

    expect(result.run.status).toBe('draft');
    expect(result.run.lastEventSequence).toBe(4);

    const counts = await countAggregate(db, companyId, projectId);
    expect(counts.runs).toBe(1);
    expect(counts.commands).toBe(1);
    expect(counts.events).toBe(4);
    expect(counts.reservations).toBe(1);
    expect(counts.allocations).toBe(1);
    expect(counts.policies).toBe(1);
  });

  it('a failure after the policy snapshot leaves no partial aggregate', async () => {
    const { companyId, projectId, threadId } = await seedScope();
    const service = new MissionStartService(db, {
      failpoint: { at: 'after_run', throw: () => new Error('injected after run') },
    });
    await expect(
      service.start({
        companyId,
        projectId,
        idempotencyKey: 'agg-fail-run-001',
        body: { projectThreadId: threadId, mode: 'fast', request: { text: 'Do work' } },
        actorType: 'user',
        actorId: 'dev-user-000',
      }),
    ).rejects.toThrow('injected after run');

    const counts = await countAggregate(db, companyId, projectId);
    expect(counts.runs).toBe(0);
    expect(counts.commands).toBe(0);
    expect(counts.events).toBe(0);
    expect(counts.reservations).toBe(0);
    expect(counts.allocations).toBe(0);
    expect(counts.policies).toBe(0);
  });

  it('a failure after the reservation leaves no partial aggregate', async () => {
    const { companyId, projectId, threadId } = await seedScope();
    const service = new MissionStartService(db, {
      failpoint: { at: 'after_reservation', throw: () => new Error('injected after reservation') },
    });
    await expect(
      service.start({
        companyId,
        projectId,
        idempotencyKey: 'agg-fail-res-001',
        body: { projectThreadId: threadId, mode: 'deep_work', request: { text: 'Do work' } },
        actorType: 'user',
        actorId: 'dev-user-000',
      }),
    ).rejects.toThrow('injected after reservation');

    const counts = await countAggregate(db, companyId, projectId);
    expect(counts.runs).toBe(0);
    expect(counts.reservations).toBe(0);
    expect(counts.events).toBe(0);
  });

  it('a failure after the events leaves no partial aggregate', async () => {
    const { companyId, projectId, threadId } = await seedScope();
    const service = new MissionStartService(db, {
      failpoint: { at: 'after_events', throw: () => new Error('injected after events') },
    });
    await expect(
      service.start({
        companyId,
        projectId,
        idempotencyKey: 'agg-fail-evt-001',
        body: { projectThreadId: threadId, mode: 'analyst', request: { text: 'Do work' } },
        actorType: 'user',
        actorId: 'dev-user-000',
      }),
    ).rejects.toThrow('injected after events');

    const counts = await countAggregate(db, companyId, projectId);
    expect(counts.runs).toBe(0);
    expect(counts.events).toBe(0);
    expect(counts.commands).toBe(0);
  });

  it('initial events are ordered: created, mode, policy, budget', async () => {
    const { companyId, projectId, threadId } = await seedScope();
    const service = new MissionStartService(db);
    const result = await service.start({
      companyId,
      projectId,
      idempotencyKey: 'agg-order-001',
      body: { projectThreadId: threadId, mode: 'fast', request: { text: 'Do work' } },
      actorType: 'user',
      actorId: 'dev-user-000',
    });

    const events = await execRows<{ sequence: number; type: string }>(
      db,
      sql`
      SELECT sequence, type FROM "run_events" WHERE run_id = ${result.run.id} ORDER BY sequence
    `,
    );
    expect(events.map((e) => e.type)).toEqual([
      'run.created',
      'mode.resolved',
      'policy.snapshotted',
      'budget.reserved',
    ]);
    expect(events.map((e) => Number(e.sequence))).toEqual([1, 2, 3, 4]);
  });

  it('the root run references itself and the reservation is finite', async () => {
    const { companyId, projectId, threadId } = await seedScope();
    const service = new MissionStartService(db);
    const result = await service.start({
      companyId,
      projectId,
      idempotencyKey: 'agg-root-001',
      body: { projectThreadId: threadId, mode: 'fast', request: { text: 'Do work' } },
      actorType: 'user',
      actorId: 'dev-user-000',
    });

    const [run] = await execRows<{ root_run_id: string; parent_run_id: string | null }>(
      db,
      sql`
      SELECT root_run_id, parent_run_id FROM "mission_runs" WHERE id = ${result.run.id}
    `,
    );
    expect(run.root_run_id).toBe(result.run.id);
    expect(run.parent_run_id).toBeNull();
    expect(result.run.budget.reservedCents).toBeGreaterThan(0);
    expect(result.run.budget.reservedCents).toBeLessThanOrEqual(10000);
  });
});
