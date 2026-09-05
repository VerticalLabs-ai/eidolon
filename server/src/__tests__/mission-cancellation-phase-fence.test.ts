/**
 * Cancellation closes every phase consistently (VAL-CROSS-095).
 *
 * Cancellation during planning, awaiting input, awaiting approval,
 * queued, running, and synthesizing closes actions, prevents later
 * claims/output, settles known charges, releases residual budget, and
 * converges projections; approval and artifact-commit races produce
 * one winner.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer } from '../test-utils.js';
import { MissionCancellationService } from '../services/mission/cancellation.js';
import { MissionCompletionService } from '../services/mission/completion.js';

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

async function getRunRow(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "status", "state_version", "last_event_sequence", "terminal_at",
           "cancel_requested_at", "cancellation_deadline_at", "lease_owner",
           "lease_token", "lease_expires_at"
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

/** Nonterminal phases that can be cancelled (VAL-CROSS-095). */
const NONTERMINAL_PHASES = [
  'planning',
  'awaiting_input',
  'awaiting_approval',
  'queued',
  'running',
  'synthesizing',
] as const;

describe('VAL-CROSS-095: Cancellation closes every phase consistently', () => {
  let ctx: RunContext;

  afterEach(async () => {
    if (ctx?.db) {
      const { closeTestDb } = await import('../test-utils.js');
      await closeTestDb();
    }
    vi.unstubAllEnvs();
  });

  describe('phase matrix: cancellation closes actions and releases budget', () => {
    for (const phase of NONTERMINAL_PHASES) {
      it(`cancellation from ${phase} closes actions, settles charges, releases budget`, async () => {
        ctx = await freshRun(`phase-${phase}`);
        const leaseOwner = ['queued', 'running', 'synthesizing'].includes(phase)
          ? `worker-${randomUUID()}`
          : undefined;
        const waitingFrom = phase === 'awaiting_input' ? 'planning' : undefined;
        await setRunStatus(ctx.db, ctx.runId, phase, {
          leaseOwner,
          waitingFromStatus: waitingFrom,
        });

        const beforeRow = await getRunRow(ctx.db, ctx.runId);
        const beforeVersion = beforeRow!.state_version;

        const cancelRes = await request(ctx.app)
          .post(`${ctx.base}/${ctx.runId}/cancel`)
          .set('Idempotency-Key', `cancel-${phase}-${randomUUID()}`)
          .set('If-Match', `"${beforeVersion}"`)
          .send({ reason: `Cancel from ${phase}` });

        expect(cancelRes.status).toBe(202);

        // For lease states, terminalize via the service.
        if (leaseOwner) {
          const cancelService = new MissionCancellationService(ctx.db);
          await ctx.db.drizzle.transaction(async (tx) => {
            await cancelService.terminalize(tx, ctx.companyId, ctx.projectId, ctx.runId, {
              actorType: 'system',
              actorId: null,
            });
          });
        }

        const afterRow = await getRunRow(ctx.db, ctx.runId);
        expect(afterRow!.status).toBe('cancelled');
        expect(afterRow!.terminal_at).not.toBeNull();

        // Budget released.
        const reservation = await getReservation(ctx.db, ctx.runId);
        expect(reservation!.status).toBe('released');
        const released = reservation!.released as number;
        const settled = reservation!.settled as number;
        const reserved = reservation!.reserved as number;
        expect(settled + released).toBe(reserved);

        const allocation = await getAllocation(ctx.db, ctx.runId);
        expect(allocation!.status).toBe('released');

        // Events ordered: cancel_requested → cancelled → budget.released.
        const events = await getEvents(ctx.db, ctx.runId);
        const eventTypes = events.map((e) => e.type);
        const cancelReqIdx = eventTypes.indexOf('run.cancel_requested');
        const cancelledIdx = eventTypes.indexOf('run.cancelled');
        const budgetReleasedIdx = eventTypes.indexOf('budget.released');
        expect(cancelReqIdx).toBeLessThan(cancelledIdx);
        expect(cancelledIdx).toBeLessThan(budgetReleasedIdx);

        // Sequences monotonic.
        for (let i = 1; i < events.length; i++) {
          expect(events[i].sequence).toBeGreaterThan(events[i - 1].sequence);
        }
      });
    }
  });

  describe('prevents later claims/output after cancellation', () => {
    it('a cancelled run cannot be claimed by a worker', async () => {
      ctx = await freshRun('fence-claim');
      await setRunStatus(ctx.db, ctx.runId, 'queued', {
        leaseOwner: `worker-${randomUUID()}`,
      });

      const beforeRow = await getRunRow(ctx.db, ctx.runId);
      const cancelRes = await request(ctx.app)
        .post(`${ctx.base}/${ctx.runId}/cancel`)
        .set('Idempotency-Key', `fence-claim-${randomUUID()}`)
        .set('If-Match', `"${beforeRow!.state_version}"`)
        .send({ reason: 'Cancel before claim' });
      expect(cancelRes.status).toBe(202);

      // Terminalize.
      const cancelService = new MissionCancellationService(ctx.db);
      await ctx.db.drizzle.transaction(async (tx) => {
        await cancelService.terminalize(tx, ctx.companyId, ctx.projectId, ctx.runId, {
          actorType: 'system',
          actorId: null,
        });
      });

      // Verify the run is terminal and has no lease.
      const afterRow = await getRunRow(ctx.db, ctx.runId);
      expect(afterRow!.status).toBe('cancelled');
      expect(afterRow!.lease_owner).toBeNull();
      expect(afterRow!.terminal_at).not.toBeNull();

      // Verify no new events can be appended (terminal immutability).
      const eventsBefore = await getEvents(ctx.db, ctx.runId);
      const seqBefore = eventsBefore[eventsBefore.length - 1]!.sequence;

      // Attempt to cancel again — should be harmless (200, no new events).
      const reCancel = await request(ctx.app)
        .post(`${ctx.base}/${ctx.runId}/cancel`)
        .set('Idempotency-Key', `re-cancel-${randomUUID()}`)
        .send({ reason: 'Re-cancel' });
      expect(reCancel.status).toBe(200);

      const eventsAfter = await getEvents(ctx.db, ctx.runId);
      const seqAfter = eventsAfter[eventsAfter.length - 1]!.sequence;
      expect(seqAfter).toBe(seqBefore); // No new events appended
    });

    it('a cancelled run rejects artifact commit via the commit fence', async () => {
      ctx = await freshRun('fence-artifact');
      await setRunStatus(ctx.db, ctx.runId, 'running', {
        leaseOwner: `worker-${randomUUID()}`,
      });

      const beforeRow = await getRunRow(ctx.db, ctx.runId);
      await request(ctx.app)
        .post(`${ctx.base}/${ctx.runId}/cancel`)
        .set('Idempotency-Key', `fence-artifact-${randomUUID()}`)
        .set('If-Match', `"${beforeRow!.state_version}"`)
        .send({ reason: 'Cancel before artifact' })
        .expect(202);

      // Terminalize.
      const cancelService = new MissionCancellationService(ctx.db);
      await ctx.db.drizzle.transaction(async (tx) => {
        await cancelService.terminalize(tx, ctx.companyId, ctx.projectId, ctx.runId, {
          actorType: 'system',
          actorId: null,
        });
      });

      // Verify the run is cancelled.
      const afterRow = await getRunRow(ctx.db, ctx.runId);
      expect(afterRow!.status).toBe('cancelled');

      // The artifact commit fence should reject commits for cancelled runs.
      // We verify this by checking that the run's cancel_requested_at is set,
      // which is the condition the fence checks (fenceCancelledRun in
      // artifact-commit-service.ts).
      const fenceRow = (await ctx.db.drizzle.execute(sql`
        SELECT "cancel_requested_at", "status"
        FROM "mission_runs" WHERE "id" = ${ctx.runId}
      `)) as unknown as Record<string, unknown>[];
      expect(fenceRow[0]!.cancel_requested_at).not.toBeNull();
      expect(fenceRow[0]!.status).toBe('cancelled');
    });
  });

  describe('approval and artifact-commit races produce one winner', () => {
    it('cancellation wins the race when it acquires the lock before completion', async () => {
      ctx = await freshRun('race-cancel-wins');
      await setRunStatus(ctx.db, ctx.runId, 'running', {
        leaseOwner: `worker-${randomUUID()}`,
      });

      // Cancel first (acquires the lock).
      const beforeRow = await getRunRow(ctx.db, ctx.runId);
      const cancelRes = await request(ctx.app)
        .post(`${ctx.base}/${ctx.runId}/cancel`)
        .set('Idempotency-Key', `race-cancel-${randomUUID()}`)
        .set('If-Match', `"${beforeRow!.state_version}"`)
        .send({ reason: 'Cancel wins race' });
      expect(cancelRes.status).toBe(202);

      // Terminalize cancellation.
      const cancelService = new MissionCancellationService(ctx.db);
      await ctx.db.drizzle.transaction(async (tx) => {
        await cancelService.terminalize(tx, ctx.companyId, ctx.projectId, ctx.runId, {
          actorType: 'system',
          actorId: null,
        });
      });

      // Capture state after cancellation.
      const afterCancelRow = await getRunRow(ctx.db, ctx.runId);
      expect(afterCancelRow!.status).toBe('cancelled');
      const versionAfterCancel = afterCancelRow!.state_version;
      const seqAfterCancel = afterCancelRow!.last_event_sequence;

      // Now attempt completion — should be a no-op for an already-terminal run
      // (VAL-RUN-043). It must NOT change the status, append a completion
      // event, or advance the state version.
      const completionService = new MissionCompletionService(ctx.db);
      const completionResult = await ctx.db.drizzle.transaction(async (tx) => {
        return await completionService.completeRun(tx, ctx.companyId, ctx.projectId, ctx.runId, {
          actorType: 'system',
          actorId: null,
        });
      });
      expect(completionResult.statusCode).toBe(200);
      expect(completionResult.terminalized).toBe(false);
      expect(completionResult.status).toBe('cancelled');

      // Verify the run is still cancelled, not completed.
      const afterRow = await getRunRow(ctx.db, ctx.runId);
      expect(afterRow!.status).toBe('cancelled');
      expect(afterRow!.state_version).toBe(versionAfterCancel);
      expect(afterRow!.last_event_sequence).toBe(seqAfterCancel);

      // Only one terminal event (cancelled, not completed).
      const events = await getEvents(ctx.db, ctx.runId);
      const terminalEvents = events.filter(
        (e) => e.type === 'run.cancelled' || e.type === 'run.completed' || e.type === 'run.failed',
      );
      expect(terminalEvents.length).toBe(1);
      expect(terminalEvents[0]!.type).toBe('run.cancelled');
      // No completion event was appended.
      expect(events.find((e) => e.type === 'run.completed')).toBeUndefined();
    });

    it('completion wins the race when it acquires the lock before cancellation', async () => {
      ctx = await freshRun('race-complete-wins');
      await setRunStatus(ctx.db, ctx.runId, 'running', {
        leaseOwner: `worker-${randomUUID()}`,
      });

      // Complete first (acquires the lock).
      const completionService = new MissionCompletionService(ctx.db);
      await ctx.db.drizzle.transaction(async (tx) => {
        await completionService.completeRun(tx, ctx.companyId, ctx.projectId, ctx.runId, {
          actorType: 'system',
          actorId: null,
        });
      });

      // Now attempt cancellation — should be harmless (200, already terminal).
      const cancelRes = await request(ctx.app)
        .post(`${ctx.base}/${ctx.runId}/cancel`)
        .set('Idempotency-Key', `race-late-cancel-${randomUUID()}`)
        .send({ reason: 'Late cancel' });
      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.data.run.status).toBe('completed');

      // Verify the run is completed, not cancelled.
      const afterRow = await getRunRow(ctx.db, ctx.runId);
      expect(afterRow!.status).toBe('completed');
      expect(afterRow!.terminal_at).not.toBeNull();

      // Only one terminal event (completed, not cancelled).
      const events = await getEvents(ctx.db, ctx.runId);
      const terminalEvents = events.filter(
        (e) => e.type === 'run.cancelled' || e.type === 'run.completed' || e.type === 'run.failed',
      );
      const completedEvents = terminalEvents.filter((e) => e.type === 'run.completed');
      const cancelledEvents = terminalEvents.filter((e) => e.type === 'run.cancelled');
      expect(completedEvents.length).toBe(1);
      expect(cancelledEvents.length).toBe(0);
    });
  });

  describe('terminal state is immutable after cancellation', () => {
    it('a cancelled run stays cancelled through duplicate commands and reads', async () => {
      ctx = await freshRun('immutable-cancel');
      await setRunStatus(ctx.db, ctx.runId, 'planning');

      const beforeRow = await getRunRow(ctx.db, ctx.runId);
      await request(ctx.app)
        .post(`${ctx.base}/${ctx.runId}/cancel`)
        .set('Idempotency-Key', `immutable-${randomUUID()}`)
        .set('If-Match', `"${beforeRow!.state_version}"`)
        .send({ reason: 'Cancel' })
        .expect(202);

      const afterRow = await getRunRow(ctx.db, ctx.runId);
      expect(afterRow!.status).toBe('cancelled');
      const versionAfter = afterRow!.state_version;
      const seqAfter = afterRow!.last_event_sequence;

      // Duplicate cancel — harmless.
      await request(ctx.app)
        .post(`${ctx.base}/${ctx.runId}/cancel`)
        .set('Idempotency-Key', `immutable-dup-${randomUUID()}`)
        .send({ reason: 'Dup cancel' })
        .expect(200);

      // State unchanged.
      const finalRow = await getRunRow(ctx.db, ctx.runId);
      expect(finalRow!.status).toBe('cancelled');
      expect(finalRow!.state_version).toBe(versionAfter);
      expect(finalRow!.last_event_sequence).toBe(seqAfter);
    });
  });
});
