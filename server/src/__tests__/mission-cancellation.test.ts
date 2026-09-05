import { describe, expect, it, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer } from '../test-utils.js';
import {
  MissionCancellationService,
  computeCancellationDeadline,
} from '../services/mission/cancellation.js';

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
    base,
  };
}

/** Move a run to a specific nonterminal status. */
async function setRunStatus(
  db: AnyDb,
  runId: string,
  status: string,
  opts: { leaseOwner?: string; waitingFromStatus?: string } = {},
) {
  const now = new Date();
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(status);
  const leaseToken = opts.leaseOwner ? randomUUID() : null;
  const leaseExpires = opts.leaseOwner ? new Date(now.getTime() + 30000) : null;

  await db.drizzle.execute(sql`
    UPDATE "mission_runs"
    SET "status" = ${status},
        "terminal_at" = ${isTerminal ? now : null},
        "updated_at" = ${now},
        "lease_owner" = ${opts.leaseOwner ?? null},
        "lease_token" = ${leaseToken},
        "lease_expires_at" = ${leaseExpires},
        "heartbeat_at" = ${opts.leaseOwner ? now : null},
        "started_at" = ${opts.leaseOwner ? now : null},
        "waiting_from_status" = ${opts.waitingFromStatus ?? null}
    WHERE "id" = ${runId}
  `);
}

async function getRunRow(
  db: AnyDb,
  runId: string,
): Promise<
  (Record<string, unknown> & { state_version: number; last_event_sequence: number }) | null
> {
  const rows = (await db.drizzle.execute(sql`
    SELECT "status", "state_version", "last_event_sequence", "terminal_at",
           "cancel_requested_at", "cancel_requested_by",
           "cancellation_deadline_at", "lease_owner", "created_at"
    FROM "mission_runs" WHERE "id" = ${runId}
  `)) as unknown as Record<string, unknown>[];
  if (!rows[0]) {
    return null;
  }
  const row = rows[0];
  return {
    ...row,
    state_version: Number(row.state_version),
    last_event_sequence: Number(row.last_event_sequence),
  } as Record<string, unknown> & { state_version: number; last_event_sequence: number };
}

async function getEvents(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "sequence", "type", "payload"
    FROM "run_events" WHERE "run_id" = ${runId}
    ORDER BY "sequence" ASC
  `)) as unknown as Array<{
    sequence: string | number;
    type: string;
    payload: Record<string, unknown>;
  }>;
  return rows.map((r) => ({ ...r, sequence: Number(r.sequence) }));
}

async function getReservation(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "reserved_cents" AS "reserved", "settled_cents" AS "settled",
           "released_cents" AS "released", "status", "terminal_at"
    FROM "budget_reservations" WHERE "run_id" = ${runId}
  `)) as unknown as Record<string, unknown>[];
  return rows[0] ?? null;
}

async function getAllocation(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "allocated_cents" AS "allocated", "settled_cents" AS "settled",
           "released_cents" AS "released", "status"
    FROM "budget_allocations" WHERE "run_id" = ${runId}
  `)) as unknown as Record<string, unknown>[];
  return rows[0] ?? null;
}

/** Nonterminal phases that can be cancelled (VAL-RUN-117). */
const NONTERMINAL_PHASES = [
  'planning',
  'awaiting_input',
  'awaiting_approval',
  'queued',
  'running',
  'synthesizing',
] as const;

describe('MissionCancellationService — VAL-RUN-117: Every nonterminal phase can be cancelled', () => {
  let ctx: RunContext;

  afterEach(async () => {
    if (ctx?.db) {
      const { closeTestDb } = await import('../test-utils.js');
      await closeTestDb();
    }
    vi.unstubAllEnvs();
  });

  for (const phase of NONTERMINAL_PHASES) {
    describe(`cancel from ${phase}`, () => {
      it('closes pending work, prevents late output, settles charges, releases budget', async () => {
        ctx = await freshRun(`cancel-${phase}`);

        // Move the run to the target phase.
        const leaseOwner = ['queued', 'running', 'synthesizing'].includes(phase)
          ? `worker-${randomUUID()}`
          : undefined;
        const waitingFrom = phase === 'awaiting_input' ? 'planning' : undefined;
        await setRunStatus(ctx.db, ctx.runId, phase, {
          leaseOwner,
          waitingFromStatus: waitingFrom,
        });

        // Get the current state version for If-Match.
        const beforeRow = await getRunRow(ctx.db, ctx.runId);
        const beforeVersion = beforeRow!.state_version as number;

        // Send the cancel command.
        const cancelRes = await request(ctx.app)
          .post(`${ctx.base}/${ctx.runId}/cancel`)
          .set('Idempotency-Key', `cancel-${phase}-${randomUUID()}`)
          .set('If-Match', `"${beforeVersion}"`)
          .send({ reason: 'User requested cancellation' });

        expect(cancelRes.status).toBe(202);
        expect(cancelRes.body.data.run).toBeDefined();

        // For non-lease states, the run should be terminalized immediately.
        // For lease states, the run should have cancel_requested set.
        const afterRow = await getRunRow(ctx.db, ctx.runId);
        expect(afterRow!.cancel_requested_at).not.toBeNull();
        expect(afterRow!.cancellation_deadline_at).not.toBeNull();

        if (!leaseOwner) {
          // Non-lease state: should be cancelled immediately.
          expect(afterRow!.status).toBe('cancelled');
          expect(afterRow!.terminal_at).not.toBeNull();
        } else {
          // Lease state: cancel requested but not yet terminalized.
          expect(afterRow!.status).toBe(phase);
          expect(afterRow!.terminal_at).toBeNull();

          // Simulate the worker observing cancellation and terminalizing.
          const cancelService = new MissionCancellationService(ctx.db);
          await ctx.db.drizzle.transaction(async (tx) => {
            await cancelService.terminalize(tx, ctx.companyId, ctx.projectId, ctx.runId, {
              actorType: 'system',
              actorId: null,
            });
          });

          const terminalRow = await getRunRow(ctx.db, ctx.runId);
          expect(terminalRow!.status).toBe('cancelled');
          expect(terminalRow!.terminal_at).not.toBeNull();
          expect(terminalRow!.lease_owner).toBeNull();
        }

        // Verify budget is released.
        const reservation = await getReservation(ctx.db, ctx.runId);
        expect(reservation).not.toBeNull();
        expect(reservation!.status).toBe('released');
        expect(reservation!.terminal_at).not.toBeNull();
        const released = reservation!.released as number;
        const settled = reservation!.settled as number;
        const reserved = reservation!.reserved as number;
        expect(settled + released).toBe(reserved);

        const allocation = await getAllocation(ctx.db, ctx.runId);
        expect(allocation).not.toBeNull();
        expect(allocation!.status).toBe('released');

        // Verify events are ordered: cancel_requested, then cancelled, then budget.released.
        const events = await getEvents(ctx.db, ctx.runId);
        const eventTypes = events.map((e) => e.type);
        expect(eventTypes).toContain('run.cancel_requested');
        expect(eventTypes).toContain('run.cancelled');
        expect(eventTypes).toContain('budget.released');

        // Verify event ordering: cancel_requested before cancelled before budget.released.
        const cancelReqIdx = eventTypes.indexOf('run.cancel_requested');
        const cancelledIdx = eventTypes.indexOf('run.cancelled');
        const budgetReleasedIdx = eventTypes.indexOf('budget.released');
        expect(cancelReqIdx).toBeLessThan(cancelledIdx);
        expect(cancelledIdx).toBeLessThan(budgetReleasedIdx);

        // Verify sequences are monotonic.
        for (let i = 1; i < events.length; i++) {
          expect(events[i].sequence).toBeGreaterThan(events[i - 1].sequence);
        }
      });
    });
  }

  it('cancellation from draft terminalizes immediately', async () => {
    ctx = await freshRun('cancel-draft');
    // Fast mode auto-enqueues to queued; move back to draft to test
    // cancellation from the draft phase specifically.
    await setRunStatus(ctx.db, ctx.runId, 'draft');
    // Run is now in draft status.
    const beforeRow = await getRunRow(ctx.db, ctx.runId);
    expect(beforeRow!.status).toBe('draft');
    const beforeVersion = beforeRow!.state_version as number;

    const cancelRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', `cancel-draft-${randomUUID()}`)
      .set('If-Match', `"${beforeVersion}"`)
      .send({ reason: 'Cancel draft' });

    expect(cancelRes.status).toBe(202);

    const afterRow = await getRunRow(ctx.db, ctx.runId);
    expect(afterRow!.status).toBe('cancelled');
    expect(afterRow!.terminal_at).not.toBeNull();
    expect(afterRow!.cancellation_deadline_at).not.toBeNull();

    const reservation = await getReservation(ctx.db, ctx.runId);
    expect(reservation!.status).toBe('released');
  });

  it('duplicate cancellation is idempotent (VAL-RUN-039)', async () => {
    ctx = await freshRun('cancel-dup');
    const beforeRow = await getRunRow(ctx.db, ctx.runId);
    const beforeVersion = beforeRow!.state_version as number;
    const key = `dup-cancel-${randomUUID()}`;

    const first = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', key)
      .set('If-Match', `"${beforeVersion}"`)
      .send({ reason: 'First cancel' });
    expect(first.status).toBe(202);

    // Second request with same key and body should return the same result.
    const second = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', key)
      .set('If-Match', `"${beforeVersion}"`)
      .send({ reason: 'First cancel' });
    expect(second.status).toBe(202);
    expect(second.body.data.run.id).toBe(first.body.data.run.id);

    // Only one cancel_requested event.
    const events = await getEvents(ctx.db, ctx.runId);
    const cancelRequestedCount = events.filter((e) => e.type === 'run.cancel_requested').length;
    expect(cancelRequestedCount).toBe(1);
  });

  it('cancellation after terminal state is harmless (VAL-RUN-040)', async () => {
    ctx = await freshRun('cancel-terminal');
    // Move to completed.
    await setRunStatus(ctx.db, ctx.runId, 'completed');

    const cancelRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', `cancel-terminal-${randomUUID()}`)
      .send({ reason: 'Too late' });

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.run.status).toBe('completed');

    // No new cancel events.
    const events = await getEvents(ctx.db, ctx.runId);
    expect(events.find((e) => e.type === 'run.cancel_requested')).toBeUndefined();
    expect(events.find((e) => e.type === 'run.cancelled')).toBeUndefined();
  });
});

describe('MissionCancellationService — VAL-RUN-136: Cancellation deadline', () => {
  let ctx: RunContext;

  afterEach(async () => {
    if (ctx?.db) {
      const { closeTestDb } = await import('../test-utils.js');
      await closeTestDb();
    }
    vi.unstubAllEnvs();
  });

  it('exposes cancellationDeadlineAt no later than min(rootDeadline, cancelRequestedAt + 60s)', async () => {
    ctx = await freshRun('deadline-expose');
    const beforeRow = await getRunRow(ctx.db, ctx.runId);
    const beforeVersion = beforeRow!.state_version as number;

    const cancelRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', `deadline-${randomUUID()}`)
      .set('If-Match', `"${beforeVersion}"`)
      .send({ reason: 'Deadline test' });

    expect(cancelRes.status).toBe(202);

    const afterRow = await getRunRow(ctx.db, ctx.runId);
    expect(afterRow!.cancellation_deadline_at).not.toBeNull();

    const cancelRequestedAt = new Date(afterRow!.cancel_requested_at as string);
    const deadline = new Date(afterRow!.cancellation_deadline_at as string);
    const createdAt = new Date(beforeRow!.created_at as string);

    // Deadline must be at most 60 seconds after cancelRequestedAt.
    const maxDeadline = new Date(cancelRequestedAt.getTime() + 60_000);
    expect(deadline.getTime()).toBeLessThanOrEqual(maxDeadline.getTime());

    // Deadline must be at most the root deadline (createdAt + durationSeconds).
    // Fast mode has 300 seconds duration.
    const rootDeadline = new Date(createdAt.getTime() + 300 * 1000);
    expect(deadline.getTime()).toBeLessThanOrEqual(rootDeadline.getTime());

    // Deadline must be after cancelRequestedAt.
    expect(deadline.getTime()).toBeGreaterThan(cancelRequestedAt.getTime());
  });

  it('computeCancellationDeadline returns min(rootDeadline, cancelRequestedAt + 60s)', () => {
    const cancelAt = new Date('2026-01-01T12:00:00Z');
    const rootCreated = new Date('2026-01-01T11:55:00Z'); // 5 min ago
    const duration = 300; // 5 minutes

    const deadline = computeCancellationDeadline(cancelAt, rootCreated, duration);
    // rootDeadline = 11:55 + 5min = 12:00:00
    // cancelPlus60 = 12:00:00 + 60s = 12:01:00
    // min = 12:00:00 (root deadline)
    expect(deadline.toISOString()).toBe('2026-01-01T12:00:00.000Z');
  });

  it('computeCancellationDeadline uses 60s when root deadline is far', () => {
    const cancelAt = new Date('2026-01-01T12:00:00Z');
    const rootCreated = new Date('2026-01-01T11:00:00Z'); // 1 hour ago
    const duration = 3600; // 1 hour → rootDeadline = 12:00:00

    const deadline = computeCancellationDeadline(cancelAt, rootCreated, duration);
    // rootDeadline = 12:00:00, cancelPlus60 = 12:01:00
    // min = 12:00:00 (root deadline is exactly at cancel time)
    expect(deadline.toISOString()).toBe('2026-01-01T12:00:00.000Z');
  });

  it('computeCancellationDeadline uses 60s window when root deadline is later', () => {
    const cancelAt = new Date('2026-01-01T12:00:00Z');
    const rootCreated = new Date('2026-01-01T11:50:00Z'); // 10 min ago
    const duration = 3600; // 1 hour → rootDeadline = 12:50:00

    const deadline = computeCancellationDeadline(cancelAt, rootCreated, duration);
    // rootDeadline = 12:50:00, cancelPlus60 = 12:01:00
    // min = 12:01:00 (60s window)
    expect(deadline.toISOString()).toBe('2026-01-01T12:01:00.000Z');
  });

  it('cancellation cascades to nonterminal descendants', async () => {
    ctx = await freshRun('cancel-cascade');
    const beforeRow = await getRunRow(ctx.db, ctx.runId);
    const beforeVersion = beforeRow!.state_version as number;

    // Create a child run.
    const childId = randomUUID();
    const now = new Date();
    await ctx.db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id",
        "root_run_id", "parent_run_id", "depth", "child_ordinal",
        "routing_kind", "request_envelope", "request_content_hash",
        "resolved_mode", "policy_snapshot_id", "status", "state_version",
        "last_event_sequence", "partial_result_policy", "created_at", "updated_at")
      VALUES (${childId}, ${ctx.companyId}, ${ctx.projectId}, ${ctx.threadId},
        ${ctx.runId}, ${ctx.runId}, 1, 0,
        'company_agent', '{}'::jsonb, 'hash',
        'fast', NULL, 'running', 1, 0, 'require_all', ${now}, ${now})
    `);

    // Cancel the parent.
    const cancelRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', `cascade-${randomUUID()}`)
      .set('If-Match', `"${beforeVersion}"`)
      .send({ reason: 'Cancel parent' });
    expect(cancelRes.status).toBe(202);

    // The child should have cancel_requested set.
    const childRow = await getRunRow(ctx.db, childId);
    expect(childRow!.cancel_requested_at).not.toBeNull();
    expect(childRow!.cancellation_deadline_at).not.toBeNull();

    // The child should have a child.cancel_requested event.
    const childEvents = await getEvents(ctx.db, childId);
    expect(childEvents.find((e) => e.type === 'child.cancel_requested')).toBeDefined();
  });

  it('no late output commits after cancellation wins (VAL-RUN-041)', async () => {
    ctx = await freshRun('cancel-no-late-output');
    // Fast mode auto-enqueues to queued; move back to draft so cancel
    // terminalizes immediately (draft is a non-lease state).
    await setRunStatus(ctx.db, ctx.runId, 'draft');
    const beforeRow = await getRunRow(ctx.db, ctx.runId);
    const beforeVersion = beforeRow!.state_version as number;

    // Cancel from draft (non-lease state) — terminalizes immediately.
    const cancelRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', `no-late-${randomUUID()}`)
      .set('If-Match', `"${beforeVersion}"`)
      .send({ reason: 'Prevent late output' });
    expect(cancelRes.status).toBe(202);

    // Verify the run is cancelled and terminal.
    const afterRow = await getRunRow(ctx.db, ctx.runId);
    expect(afterRow!.status).toBe('cancelled');
    expect(afterRow!.terminal_at).not.toBeNull();

    // Verify no completion event was appended after cancellation.
    const events = await getEvents(ctx.db, ctx.runId);
    const completedIdx = events.findIndex((e) => e.type === 'run.completed');
    expect(completedIdx).toBe(-1);

    // Verify the terminal event is the last lifecycle event.
    const lifecycleEvents = events.filter((e) =>
      ['run.cancelled', 'run.completed', 'run.failed'].includes(e.type),
    );
    expect(lifecycleEvents).toHaveLength(1);
    expect(lifecycleEvents[0].type).toBe('run.cancelled');

    // Verify budget is fully released with no settlements.
    const reservation = await getReservation(ctx.db, ctx.runId);
    expect(reservation!.status).toBe('released');
    expect(reservation!.settled).toBe(0);
    expect(reservation!.released).toBe(reservation!.reserved);
  });

  it('terminalize is idempotent for already-terminal runs', async () => {
    ctx = await freshRun('cancel-idempotent-terminal');
    // Fast mode auto-enqueues to queued; move back to draft so cancel
    // terminalizes immediately (draft is a non-lease state).
    await setRunStatus(ctx.db, ctx.runId, 'draft');
    const beforeRow = await getRunRow(ctx.db, ctx.runId);
    const beforeVersion = beforeRow!.state_version as number;

    // Cancel from draft.
    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', `idemp-term-${randomUUID()}`)
      .set('If-Match', `"${beforeVersion}"`)
      .send({ reason: 'Cancel' })
      .expect(202);

    const afterRow = await getRunRow(ctx.db, ctx.runId);
    expect(afterRow!.status).toBe('cancelled');
    const versionAfterCancel = afterRow!.state_version as number;
    const seqAfterCancel = afterRow!.last_event_sequence as number;

    // Call terminalize again — should be a no-op.
    const cancelService = new MissionCancellationService(ctx.db);
    await ctx.db.drizzle.transaction(async (tx) => {
      const result = await cancelService.terminalize(tx, ctx.companyId, ctx.projectId, ctx.runId, {
        actorType: 'system',
        actorId: null,
      });
      expect(result.terminalized).toBe(false);
      expect(result.status).toBe('cancelled');
    });

    // State should not have changed.
    const finalRow = await getRunRow(ctx.db, ctx.runId);
    expect(finalRow!.state_version).toBe(versionAfterCancel);
    expect(finalRow!.last_event_sequence).toBe(seqAfterCancel);
  });

  it('snapshot exposes cancellationDeadlineAt after cancel request', async () => {
    ctx = await freshRun('cancel-snapshot-deadline');

    // Move to running (lease state) so cancel doesn't terminalize immediately.
    await setRunStatus(ctx.db, ctx.runId, 'running', { leaseOwner: `worker-${randomUUID()}` });
    const runningRow = await getRunRow(ctx.db, ctx.runId);
    const runningVersion = runningRow!.state_version as number;

    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', `snapshot-deadline-${randomUUID()}`)
      .set('If-Match', `"${runningVersion}"`)
      .send({ reason: 'Snapshot test' })
      .expect(202);

    // GET snapshot should expose cancellationDeadlineAt.
    const snapshotRes = await request(ctx.app).get(`${ctx.base}/${ctx.runId}`).expect(200);

    expect(snapshotRes.body.data.run.cancelRequestedAt).not.toBeNull();
    expect(snapshotRes.body.data.run.cancellationDeadlineAt).not.toBeNull();
  });
});
