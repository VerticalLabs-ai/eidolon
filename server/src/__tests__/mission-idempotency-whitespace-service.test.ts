import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb } from '../test-utils.js';
import { MissionStartService } from '../services/mission/start.js';
import { MissionCommandService } from '../services/mission/commands.js';

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

async function countRuns(db: AnyDb, companyId: string, projectId: string): Promise<number> {
  const [row] = (await db.drizzle.execute(
    sql`SELECT count(*)::int AS c FROM "mission_runs" WHERE "company_id" = ${companyId} AND "project_id" = ${projectId}`,
  )) as unknown as { c: number }[];
  return row.c;
}

function expectValidation400(p: Promise<unknown>): Promise<void> {
  return expect(p).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
}

// ---------------------------------------------------------------------------
// VAL-RUN-114 (round 2): Service-level whitespace idempotency rejection.
//
// Node's HTTP parser strips leading/trailing OWS (SP/HTAB) from header
// field-values per RFC 7230 before Express sees the value, so a curl-level
// test of whitespace-padded keys is intransitable — the server literally
// cannot see the whitespace over HTTP. The contract ("reject … before any
// command, state, event, budget, or output change") is therefore enforced
// at the service boundary (MissionStartService.start and
// MissionCommandService.submit) as defense-in-depth: any caller that
// reaches the service with a whitespace-padded key — whether over HTTP
// (where the parser cannot help for non-OWS Unicode whitespace), via an
// internal call, or through a test harness — is rejected with 400
// VALIDATION_ERROR before any database query or state change.
// ---------------------------------------------------------------------------

describe('Mission service-level idempotency whitespace rejection (VAL-RUN-114)', () => {
  let db: AnyDb;
  let companyId: string;
  let projectId: string;
  let threadId: string;

  beforeAll(async () => {
    enableMissionFlag();
    db = await createTestDb();
    const scope = await seedScope(db, '__mtest__ ws-service');
    companyId = scope.companyId;
    projectId = scope.projectId;
    threadId = scope.threadId;
  });
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  // --- Start path (MissionStartService) ---------------------------------

  describe('MissionStartService.start rejects whitespace-padded keys', () => {
    it('rejects a leading-whitespace key with 400 VALIDATION_ERROR before any run', async () => {
      const before = await countRuns(db, companyId, projectId);
      const service = new MissionStartService(db);
      await expectValidation400(
        service.start({
          companyId,
          projectId,
          idempotencyKey: ' leading-ws-start',
          body: {
            projectThreadId: threadId,
            mode: 'fast',
            request: { text: 'leading ws' },
          },
          actorType: 'user',
          actorId: null,
        }),
      );
      expect(await countRuns(db, companyId, projectId)).toBe(before);
    });

    it('rejects a trailing-whitespace key with 400 VALIDATION_ERROR before any run', async () => {
      const before = await countRuns(db, companyId, projectId);
      const service = new MissionStartService(db);
      await expectValidation400(
        service.start({
          companyId,
          projectId,
          idempotencyKey: 'trailing-ws-start ',
          body: {
            projectThreadId: threadId,
            mode: 'fast',
            request: { text: 'trailing ws' },
          },
          actorType: 'user',
          actorId: null,
        }),
      );
      expect(await countRuns(db, companyId, projectId)).toBe(before);
    });

    it('rejects a tab-padded key with 400 VALIDATION_ERROR', async () => {
      const before = await countRuns(db, companyId, projectId);
      const service = new MissionStartService(db);
      await expectValidation400(
        service.start({
          companyId,
          projectId,
          idempotencyKey: '\ttab-start\t',
          body: {
            projectThreadId: threadId,
            mode: 'fast',
            request: { text: 'tab ws' },
          },
          actorType: 'user',
          actorId: null,
        }),
      );
      expect(await countRuns(db, companyId, projectId)).toBe(before);
    });

    it('still accepts a valid key (no whitespace) with 202', async () => {
      const service = new MissionStartService(db);
      const result = await service.start({
        companyId,
        projectId,
        idempotencyKey: 'valid-start-001',
        body: {
          projectThreadId: threadId,
          mode: 'fast',
          request: { text: 'valid key' },
        },
        actorType: 'user',
        actorId: null,
      });
      expect(result.command.resultStatusCode).toBe(202);
      expect(result.run.id).toBeTruthy();
    });

    it('still accepts a key with internal whitespace (not leading/trailing)', async () => {
      const service = new MissionStartService(db);
      const result = await service.start({
        companyId,
        projectId,
        idempotencyKey: 'key with internal spaces',
        body: {
          projectThreadId: threadId,
          mode: 'fast',
          request: { text: 'internal ws ok' },
        },
        actorType: 'user',
        actorId: null,
      });
      expect(result.command.resultStatusCode).toBe(202);
      expect(result.command.idempotencyKey).toBe('key with internal spaces');
    });
  });

  // --- Command path (MissionCommandService) -----------------------------

  describe('MissionCommandService.submit rejects whitespace-padded keys', () => {
    let runId: string;

    beforeAll(async () => {
      // Create a run to target with cancel commands. Use deep_work mode so
      // the run is non-queued (deep_work transitions to planning, requiring
      // mandatory planning); fast/auto simple modes are enqueued to queued.
      enableMissionFlag();
      const service = new MissionStartService(db);
      const result = await service.start({
        companyId,
        projectId,
        idempotencyKey: 't1',
        body: {
          projectThreadId: threadId,
          mode: 'deep_work',
          request: { text: 'target run for whitespace cancel tests' },
        },
        actorType: 'user',
        actorId: null,
      });
      runId = result.run.id;
    });

    it('rejects a leading-whitespace cancel key with 400 VALIDATION_ERROR before any lookup', async () => {
      const service = new MissionCommandService(db);
      await expectValidation400(
        service.submit({
          companyId,
          projectId,
          runId,
          type: 'run.cancel',
          body: { reason: 'cancel me' },
          idempotencyKey: ' leading-ws-cancel',
          ifMatch: 1,
          actorType: 'user',
          actorId: null,
        }),
      );
    });

    it('rejects a trailing-whitespace cancel key with 400 VALIDATION_ERROR before any lookup', async () => {
      const service = new MissionCommandService(db);
      await expectValidation400(
        service.submit({
          companyId,
          projectId,
          runId,
          type: 'run.cancel',
          body: { reason: 'cancel me' },
          idempotencyKey: 'trailing-ws-cancel ',
          ifMatch: 1,
          actorType: 'user',
          actorId: null,
        }),
      );
    });

    it('rejects a tab-padded retry key with 400 VALIDATION_ERROR', async () => {
      const service = new MissionCommandService(db);
      await expectValidation400(
        service.submit({
          companyId,
          projectId,
          runId,
          type: 'run.retry',
          body: {},
          idempotencyKey: '\ttab-retry\t',
          ifMatch: 1,
          actorType: 'user',
          actorId: null,
        }),
      );
    });

    it('still accepts a valid cancel key (no whitespace)', async () => {
      const service = new MissionCommandService(db);
      const result = await service.submit({
        companyId,
        projectId,
        runId,
        type: 'run.cancel',
        body: { reason: 'valid cancel reason' },
        idempotencyKey: 'valid-cancel-001',
        ifMatch: 2,
        actorType: 'user',
        actorId: null,
      });
      // A first cancel on a planning (non-lease) run terminalizes
      // immediately and returns 202 per the cancellation service contract
      // (VAL-RUN-117). The whitespace rejection tests above did not change
      // state, so the run is still planning (state_version=2) here.
      expect(result.statusCode).toBe(202);
    });

    it('still accepts a cancel key with internal whitespace', async () => {
      const service = new MissionCommandService(db);
      const result = await service.submit({
        companyId,
        projectId,
        runId,
        type: 'run.cancel',
        body: { reason: 'another valid cancel reason' },
        idempotencyKey: 'cancel key with spaces',
        ifMatch: 3,
        actorType: 'user',
        actorId: null,
      });
      // After the first cancel, the run is cancelled (terminal). A second
      // cancel with a fresh key returns 200 (already-terminal behavior).
      expect(result.statusCode).toBe(200);
    });
  });
});
