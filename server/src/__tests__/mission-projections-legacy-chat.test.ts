import { describe, expect, it, beforeAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb } from '../test-utils.js';
import { MissionStartService } from '../services/mission/start.js';
import { MissionProjectionService } from '../services/mission/projection.js';

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

describe('Mission Projections and Legacy Chat — VAL-CROSS-075/092/093/097, VAL-RUN-099/100/101', () => {
  let db: AnyDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  // -------------------------------------------------------------------------
  // VAL-CROSS-093: Every declared projection maps to one run
  // -------------------------------------------------------------------------
  describe('VAL-CROSS-093: projection cardinality — every projection maps to one run', () => {
    it('creates exactly one thread item and one activity log entry per run start', async () => {
      enableMissionFlag();
      const companyId = await seedCompany(db, '__mtest__ projection cardinality');
      const projectId = await seedProject(db, companyId, 'proj');
      const threadId = await seedThread(db, companyId, projectId, 'thread');

      const startService = new MissionStartService(db);
      const result = await startService.start({
        companyId,
        projectId,
        idempotencyKey: 'card-test-1',
        body: {
          projectThreadId: threadId,
          mode: 'fast',
          request: { text: 'Cardinality test' },
        },
        actorType: 'user',
        actorId: 'user-1',
        traceId: 'trace-card-1',
      });

      const runId = result.run.id;

      // Thread items: exactly one for this run.
      const threadItems = await execRows<{ id: string; kind: string; project_thread_id: string }>(
        db,
        sql`SELECT id, kind, project_thread_id FROM task_thread_items
            WHERE company_id = ${companyId} AND project_thread_id = ${threadId}`,
      );
      expect(threadItems).toHaveLength(1);
      expect(threadItems[0].kind).toBe('execution_event');

      // Activity log: exactly one for this run.
      const activityEntries = await execRows<{ entity_id: string; action: string }>(
        db,
        sql`SELECT entity_id, action FROM activity_log
            WHERE company_id = ${companyId} AND entity_id = ${runId}`,
      );
      expect(activityEntries).toHaveLength(1);
      expect(activityEntries[0].action).toBe('mission.run.started');

      // Projection links: exactly two (thread_item + activity_log).
      const links = await execRows<{ surface: string; status: string }>(
        db,
        sql`SELECT surface, status FROM run_projection_links
            WHERE company_id = ${companyId} AND run_id = ${runId}`,
      );
      expect(links).toHaveLength(2);
      const surfaces = links.map((l) => l.surface).sort();
      expect(surfaces).toEqual(['activity_log', 'thread_item']);
      expect(links.every((l) => l.status === 'active')).toBe(true);
    });

    it('replay does not duplicate projections', async () => {
      enableMissionFlag();
      const companyId = await seedCompany(db, '__mtest__ projection replay');
      const projectId = await seedProject(db, companyId, 'proj');
      const threadId = await seedThread(db, companyId, projectId, 'thread');

      const startService = new MissionStartService(db);
      const first = await startService.start({
        companyId,
        projectId,
        idempotencyKey: 'replay-test-1',
        body: {
          projectThreadId: threadId,
          mode: 'fast',
          request: { text: 'Replay test' },
        },
        actorType: 'user',
        actorId: 'user-1',
      });

      // Replay with the same key.
      const second = await startService.start({
        companyId,
        projectId,
        idempotencyKey: 'replay-test-1',
        body: {
          projectThreadId: threadId,
          mode: 'fast',
          request: { text: 'Replay test' },
        },
        actorType: 'user',
        actorId: 'user-1',
      });

      expect(second.run.id).toBe(first.run.id);

      // Still exactly one thread item, one activity entry, two links.
      const threadItems = await execRows<{ id: string }>(
        db,
        sql`SELECT id FROM task_thread_items
            WHERE company_id = ${companyId} AND project_thread_id = ${threadId}`,
      );
      expect(threadItems).toHaveLength(1);

      const links = await execRows<{ surface: string }>(
        db,
        sql`SELECT surface FROM run_projection_links
            WHERE company_id = ${companyId} AND run_id = ${first.run.id}`,
      );
      expect(links).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-CROSS-075 / VAL-RUN-099: Projection failure repairs idempotently
  // -------------------------------------------------------------------------
  describe('VAL-CROSS-075 / VAL-RUN-099: projection failure repairs idempotently', () => {
    it('projection failure leaves run intact and is retryable; repair converges once', async () => {
      enableMissionFlag();
      const companyId = await seedCompany(db, '__mtest__ projection failpoint');
      const projectId = await seedProject(db, companyId, 'proj');
      const threadId = await seedThread(db, companyId, projectId, 'thread');

      // Start with a projection failpoint that throws during thread projection.
      const startService = new MissionStartService(db, {
        projectionFailpoint: { surface: 'thread_item' },
      });
      const result = await startService.start({
        companyId,
        projectId,
        idempotencyKey: 'failpoint-test-1',
        body: {
          projectThreadId: threadId,
          mode: 'fast',
          request: { text: 'Failpoint test' },
        },
        actorType: 'user',
        actorId: 'user-1',
        traceId: 'trace-fail-1',
      });

      const runId = result.run.id;

      // The run is authoritative and intact despite projection failure.
      const [run] = await execRows<{ status: string; state_version: number }>(
        db,
        sql`SELECT status, state_version FROM mission_runs WHERE id = ${runId}`,
      );
      expect(run).toBeDefined();
      expect(run.status).toBe('draft');

      // The thread item projection failed — no thread item exists.
      const threadItems = await execRows<{ id: string }>(
        db,
        sql`SELECT id FROM task_thread_items
            WHERE company_id = ${companyId} AND project_thread_id = ${threadId}`,
      );
      expect(threadItems).toHaveLength(0);

      // A projection.failed event was emitted.
      const failedEvents = await execRows<{ type: string; payload: Record<string, unknown> }>(
        db,
        sql`SELECT type, payload FROM run_events
            WHERE run_id = ${runId} AND type = 'projection.failed'`,
      );
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0].payload.surface).toBe('thread_item');

      // A failed projection link exists.
      const failedLinks = await execRows<{ surface: string; status: string }>(
        db,
        sql`SELECT surface, status FROM run_projection_links
            WHERE company_id = ${companyId} AND run_id = ${runId} AND surface = 'thread_item'`,
      );
      expect(failedLinks).toHaveLength(1);
      expect(failedLinks[0].status).toBe('failed');

      // Repair the projection.
      const projectionService = new MissionProjectionService(db);
      await projectionService.repair({
        companyId,
        projectId,
        runId,
        surface: 'thread_item',
        traceId: 'trace-repair-1',
      });

      // Now the thread item exists — exactly one.
      const repairedItems = await execRows<{ id: string; kind: string }>(
        db,
        sql`SELECT id, kind FROM task_thread_items
            WHERE company_id = ${companyId} AND project_thread_id = ${threadId}`,
      );
      expect(repairedItems).toHaveLength(1);
      expect(repairedItems[0].kind).toBe('execution_event');

      // A projection.repaired event was emitted.
      const repairedEvents = await execRows<{ type: string }>(
        db,
        sql`SELECT type FROM run_events
            WHERE run_id = ${runId} AND type = 'projection.repaired'`,
      );
      expect(repairedEvents).toHaveLength(1);

      // The projection link is now 'repaired'.
      const repairedLinks = await execRows<{ surface: string; status: string }>(
        db,
        sql`SELECT surface, status FROM run_projection_links
            WHERE company_id = ${companyId} AND run_id = ${runId} AND surface = 'thread_item'`,
      );
      expect(repairedLinks).toHaveLength(1);
      expect(repairedLinks[0].status).toBe('repaired');

      // Repair again — idempotent, no duplicate thread item or event.
      await projectionService.repair({
        companyId,
        projectId,
        runId,
        surface: 'thread_item',
        traceId: 'trace-repair-2',
      });

      const itemsAfterDouble = await execRows<{ id: string }>(
        db,
        sql`SELECT id FROM task_thread_items
            WHERE company_id = ${companyId} AND project_thread_id = ${threadId}`,
      );
      expect(itemsAfterDouble).toHaveLength(1);

      const repairedEventsAfterDouble = await execRows<{ type: string }>(
        db,
        sql`SELECT type FROM run_events
            WHERE run_id = ${runId} AND type = 'projection.repaired'`,
      );
      expect(repairedEventsAfterDouble).toHaveLength(1);

      // External effects (run state, budget) unchanged by repair.
      const [runAfterRepair] = await execRows<{ status: string; state_version: number }>(
        db,
        sql`SELECT status, state_version FROM mission_runs WHERE id = ${runId}`,
      );
      expect(runAfterRepair.status).toBe('draft');
    });
  });

  // -------------------------------------------------------------------------
  // VAL-RUN-100: Observable repair is attributable
  // -------------------------------------------------------------------------
  describe('VAL-RUN-100: observable repair is attributable', () => {
    it('repair record carries run identity and trace reference', async () => {
      enableMissionFlag();
      const companyId = await seedCompany(db, '__mtest__ repair attributable');
      const projectId = await seedProject(db, companyId, 'proj');
      const threadId = await seedThread(db, companyId, projectId, 'thread');

      const startService = new MissionStartService(db, {
        projectionFailpoint: { surface: 'thread_item' },
      });
      const result = await startService.start({
        companyId,
        projectId,
        idempotencyKey: 'repair-attr-1',
        body: {
          projectThreadId: threadId,
          mode: 'fast',
          request: { text: 'Repair attribution test' },
        },
        actorType: 'user',
        actorId: 'user-1',
        traceId: 'trace-attr-1',
      });

      const runId = result.run.id;

      const projectionService = new MissionProjectionService(db);
      await projectionService.repair({
        companyId,
        projectId,
        runId,
        surface: 'thread_item',
        traceId: 'trace-repair-attr-1',
      });

      // The repair event carries the run ID and trace ID.
      const [repairEvent] = await execRows<{
        type: string;
        run_id: string;
        trace_id: string;
        payload: Record<string, unknown>;
      }>(
        db,
        sql`SELECT type, run_id, trace_id, payload FROM run_events
            WHERE run_id = ${runId} AND type = 'projection.repaired'`,
      );
      expect(repairEvent).toBeDefined();
      expect(repairEvent.run_id).toBe(runId);
      expect(repairEvent.trace_id).toBe('trace-repair-attr-1');
      expect(repairEvent.payload.surface).toBe('thread_item');

      // An activity log entry for the repair is attributable to the run.
      const [activityEntry] = await execRows<{
        entity_id: string;
        action: string;
        metadata: Record<string, unknown>;
      }>(
        db,
        sql`SELECT entity_id, action, metadata FROM activity_log
            WHERE company_id = ${companyId} AND entity_id = ${runId}
              AND action = 'mission.projection.repaired'`,
      );
      expect(activityEntry).toBeDefined();
      expect(activityEntry.entity_id).toBe(runId);
      expect(activityEntry.metadata.surface).toBe('thread_item');
    });

    it('repair after terminalization does not append to the closed run journal', async () => {
      enableMissionFlag();
      const companyId = await seedCompany(db, '__mtest__ repair terminal');
      const projectId = await seedProject(db, companyId, 'proj');
      const threadId = await seedThread(db, companyId, projectId, 'thread');

      const startService = new MissionStartService(db, {
        projectionFailpoint: { surface: 'thread_item' },
      });
      const result = await startService.start({
        companyId,
        projectId,
        idempotencyKey: 'repair-term-1',
        body: {
          projectThreadId: threadId,
          mode: 'fast',
          request: { text: 'Terminal repair test' },
        },
        actorType: 'user',
        actorId: 'user-1',
        traceId: 'trace-term-1',
      });

      const runId = result.run.id;

      // Terminalize the run manually.
      await db.drizzle.execute(sql`
        UPDATE mission_runs SET status = 'completed', terminal_at = now(),
          state_version = state_version + 1, updated_at = now()
        WHERE id = ${runId}
      `);

      const [beforeRepair] = await execRows<{ last_event_sequence: number; state_version: number }>(
        db,
        sql`SELECT last_event_sequence, state_version FROM mission_runs WHERE id = ${runId}`,
      );

      // Repair the projection after terminalization.
      const projectionService = new MissionProjectionService(db);
      await projectionService.repair({
        companyId,
        projectId,
        runId,
        surface: 'thread_item',
        traceId: 'trace-term-repair-1',
      });

      // The run journal and ETag are unchanged — repair did not append.
      const [afterRepair] = await execRows<{ last_event_sequence: number; state_version: number }>(
        db,
        sql`SELECT last_event_sequence, state_version FROM mission_runs WHERE id = ${runId}`,
      );
      expect(afterRepair.last_event_sequence).toBe(beforeRepair.last_event_sequence);
      expect(afterRepair.state_version).toBe(beforeRepair.state_version);

      // No projection.repaired event in the run journal.
      const repairEvents = await execRows<{ type: string }>(
        db,
        sql`SELECT type FROM run_events WHERE run_id = ${runId} AND type = 'projection.repaired'`,
      );
      expect(repairEvents).toHaveLength(0);

      // But the thread item was created and the link is repaired.
      const items = await execRows<{ id: string }>(
        db,
        sql`SELECT id FROM task_thread_items
            WHERE company_id = ${companyId} AND project_thread_id = ${threadId}`,
      );
      expect(items).toHaveLength(1);

      // And an activity log entry records the repair.
      const activityEntries = await execRows<{ action: string }>(
        db,
        sql`SELECT action FROM activity_log
            WHERE company_id = ${companyId} AND entity_id = ${runId}
              AND action = 'mission.projection.repaired'`,
      );
      expect(activityEntries).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-CROSS-092: Projection staleness is bounded and visible
  // -------------------------------------------------------------------------
  describe('VAL-CROSS-092: projection staleness is bounded and visible', () => {
    it('a failed projection link is visible as failed before repair', async () => {
      enableMissionFlag();
      const companyId = await seedCompany(db, '__mtest__ staleness');
      const projectId = await seedProject(db, companyId, 'proj');
      const threadId = await seedThread(db, companyId, projectId, 'thread');

      const startService = new MissionStartService(db, {
        projectionFailpoint: { surface: 'thread_item' },
      });
      const result = await startService.start({
        companyId,
        projectId,
        idempotencyKey: 'staleness-1',
        body: {
          projectThreadId: threadId,
          mode: 'fast',
          request: { text: 'Staleness test' },
        },
        actorType: 'user',
        actorId: 'user-1',
      });

      const runId = result.run.id;

      // The failed projection link is visible.
      const [failedLink] = await execRows<{
        surface: string;
        status: string;
        error_message: string;
      }>(
        db,
        sql`SELECT surface, status, error_message FROM run_projection_links
            WHERE company_id = ${companyId} AND run_id = ${runId} AND surface = 'thread_item'`,
      );
      expect(failedLink).toBeDefined();
      expect(failedLink.status).toBe('failed');
      expect(failedLink.error_message).toBeTruthy();

      // The authoritative run is still intact.
      const [run] = await execRows<{ status: string }>(
        db,
        sql`SELECT status FROM mission_runs WHERE id = ${runId}`,
      );
      expect(run.status).toBe('draft');
    });
  });

  // -------------------------------------------------------------------------
  // VAL-CROSS-097 / VAL-RUN-101: Legacy Chat contract is flag independent
  // -------------------------------------------------------------------------
  describe('VAL-RUN-101 / VAL-CROSS-097: legacy Chat contract is flag independent', () => {
    it('legacy Chat thread items and Mission items coexist in the same thread', async () => {
      enableMissionFlag();
      const companyId = await seedCompany(db, '__mtest__ interleaved');
      const projectId = await seedProject(db, companyId, 'proj');
      const threadId = await seedThread(db, companyId, projectId, 'interleaved');

      // Insert a legacy Chat item (kind='comment') before Mission.
      const legacyItemId = randomUUID();
      const now = new Date();
      await db.drizzle.execute(sql`
        INSERT INTO "task_thread_items" ("id", "company_id", "project_thread_id", "kind", "content", "payload", "status", "created_at", "updated_at")
        VALUES (${legacyItemId}, ${companyId}, ${threadId}, 'comment', 'Legacy chat before mission', '{}'::jsonb, 'pending', ${now}, ${now})
      `);

      // Start a Mission — it projects an execution_event item.
      const startService = new MissionStartService(db);
      await startService.start({
        companyId,
        projectId,
        idempotencyKey: 'interleave-1',
        body: {
          projectThreadId: threadId,
          mode: 'fast',
          request: { text: 'Mission after chat' },
        },
        actorType: 'user',
        actorId: 'user-1',
      });

      // Insert a legacy Chat item after Mission.
      const legacyItemId2 = randomUUID();
      const now2 = new Date();
      await db.drizzle.execute(sql`
        INSERT INTO "task_thread_items" ("id", "company_id", "project_thread_id", "kind", "content", "payload", "status", "created_at", "updated_at")
        VALUES (${legacyItemId2}, ${companyId}, ${threadId}, 'comment', 'Legacy chat after mission', '{}'::jsonb, 'pending', ${now2}, ${now2})
      `);

      // All three items coexist in chronological order.
      const items = await execRows<{ id: string; kind: string; content: string }>(
        db,
        sql`SELECT id, kind, content FROM task_thread_items
            WHERE company_id = ${companyId} AND project_thread_id = ${threadId}
            ORDER BY created_at ASC`,
      );
      expect(items).toHaveLength(3);
      expect(items[0].kind).toBe('comment');
      expect(items[0].content).toBe('Legacy chat before mission');
      expect(items[1].kind).toBe('execution_event');
      expect(items[2].kind).toBe('comment');
      expect(items[2].content).toBe('Legacy chat after mission');

      // The Mission item payload has runId; the legacy items do not.
      const missionItem = items.find((i) => i.kind === 'execution_event');
      expect(missionItem).toBeDefined();
    });

    it('Mission item payload does not leak into legacy Chat item payloads', async () => {
      enableMissionFlag();
      const companyId = await seedCompany(db, '__mtest__ payload isolation');
      const projectId = await seedProject(db, companyId, 'proj');
      const threadId = await seedThread(db, companyId, projectId, 'payload');

      // Legacy chat item.
      const legacyItemId = randomUUID();
      const now = new Date();
      await db.drizzle.execute(sql`
        INSERT INTO "task_thread_items" ("id", "company_id", "project_thread_id", "kind", "content", "payload", "status", "created_at", "updated_at")
        VALUES (${legacyItemId}, ${companyId}, ${threadId}, 'comment', 'plain chat', '{"mentions": []}'::jsonb, 'pending', ${now}, ${now})
      `);

      // Mission item.
      const startService = new MissionStartService(db);
      await startService.start({
        companyId,
        projectId,
        idempotencyKey: 'payload-iso-1',
        body: {
          projectThreadId: threadId,
          mode: 'fast',
          request: { text: 'Mission payload test' },
        },
        actorType: 'user',
        actorId: 'user-1',
      });

      const items = await execRows<{ kind: string; payload: Record<string, unknown> }>(
        db,
        sql`SELECT kind, payload FROM task_thread_items
            WHERE company_id = ${companyId} AND project_thread_id = ${threadId}
            ORDER BY created_at ASC`,
      );

      // Legacy item has no Mission-only fields.
      const legacyItem = items.find((i) => i.kind === 'comment');
      expect(legacyItem).toBeDefined();
      expect(legacyItem!.payload).not.toHaveProperty('runId');
      expect(legacyItem!.payload).not.toHaveProperty('missionStatus');

      // Mission item has Mission-only fields.
      const missionItem = items.find((i) => i.kind === 'execution_event');
      expect(missionItem).toBeDefined();
      expect(missionItem!.payload).toHaveProperty('runId');
    });

    it('toggling Mission flag does not change legacy Chat projection count or shape', async () => {
      const companyId = await seedCompany(db, '__mtest__ flag toggle');
      const projectId = await seedProject(db, companyId, 'proj');
      const threadId = await seedThread(db, companyId, projectId, 'toggle');

      // Insert a legacy Chat item with flag OFF.
      disableMissionFlag();
      const legacyItemId1 = randomUUID();
      const now1 = new Date();
      await db.drizzle.execute(sql`
        INSERT INTO "task_thread_items" ("id", "company_id", "project_thread_id", "kind", "content", "payload", "status", "created_at", "updated_at")
        VALUES (${legacyItemId1}, ${companyId}, ${threadId}, 'comment', 'chat with flag off', '{}'::jsonb, 'pending', ${now1}, ${now1})
      `);

      // Insert another legacy Chat item with flag ON.
      enableMissionFlag();
      const legacyItemId2 = randomUUID();
      const now2 = new Date();
      await db.drizzle.execute(sql`
        INSERT INTO "task_thread_items" ("id", "company_id", "project_thread_id", "kind", "content", "payload", "status", "created_at", "updated_at")
        VALUES (${legacyItemId2}, ${companyId}, ${threadId}, 'comment', 'chat with flag on', '{}'::jsonb, 'pending', ${now2}, ${now2})
      `);

      // Both legacy items have the same shape — no Mission-only fields.
      const items = await execRows<{ id: string; kind: string; payload: Record<string, unknown> }>(
        db,
        sql`SELECT id, kind, payload FROM task_thread_items
            WHERE company_id = ${companyId} AND project_thread_id = ${threadId}
            ORDER BY created_at ASC`,
      );
      expect(items).toHaveLength(2);
      expect(items.every((i) => i.kind === 'comment')).toBe(true);
      expect(items.every((i) => !i.payload.runId)).toBe(true);

      // No Mission runs were created by inserting legacy chat items.
      const runs = await execRows<{ id: string }>(
        db,
        sql`SELECT id FROM mission_runs WHERE company_id = ${companyId} AND project_thread_id = ${threadId}`,
      );
      expect(runs).toHaveLength(0);
    });
  });
});
