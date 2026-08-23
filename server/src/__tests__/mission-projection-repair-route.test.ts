import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, createTestServer } from '../test-utils.js';
import { MissionStartService } from '../services/mission/start.js';
import { MissionProjectionService } from '../services/mission/projection.js';

/**
 * VAL-RUN-100 / VAL-CROSS-075: Projection repair is observable via curl.
 *
 * Projection repair was previously an internal service method invoked only
 * in integration tests. This suite verifies the scoped HTTP read route
 * `GET .../mission-runs/:runId/projection-repair` exposes projection
 * failure and repair evidence (link status, repair journal events, and
 * repair activity entries) carrying the same run identity and safe
 * timestamp/trace reference, scoped to company/project/run, available to
 * authorized readers (including viewers) and without the mission flag.
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

/** Start a fresh run in a fresh scope so each test owns an isolated run. */
async function freshRun(label: string, opts?: { failSurface?: 'thread_item' | 'activity_log' }) {
  enableMissionFlag();
  const db = await createTestDb();
  const app = await createTestServer(db);
  const { companyId, projectId, threadId } = await seedScope(db, label);
  const startService = new MissionStartService(db, {
    projectionFailpoint: opts?.failSurface ? { surface: opts.failSurface } : undefined,
  });
  const start = await startService.start({
    companyId,
    projectId,
    idempotencyKey: `repair-route-${randomUUID()}`,
    body: { projectThreadId: threadId, mode: 'fast', request: { text: 'Repair route test' } },
    actorType: 'user',
    actorId: 'dev-user-000',
    traceId: `trace-route-${randomUUID()}`,
  });
  return {
    db,
    app,
    companyId,
    projectId,
    threadId,
    runId: start.run.id,
    base: `/api/companies/${companyId}/projects/${projectId}/mission-runs`,
  };
}

describe('Mission projection-repair route (VAL-RUN-100, VAL-CROSS-075)', () => {
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  // -------------------------------------------------------------------------
  // Observable projection failure before repair
  // -------------------------------------------------------------------------
  describe('observable projection failure', () => {
    it('GET projection-repair exposes a failed projection link before repair', async () => {
      const ctx = await freshRun('__mtest__ repair-route-failed', {
        failSurface: 'thread_item',
      });

      const res = await request(ctx.app)
        .get(`${ctx.base}/${ctx.runId}/projection-repair`)
        .expect(200);

      const links = res.body.data.projectionLinks;
      expect(Array.isArray(links)).toBe(true);
      const failedLink = links.find(
        (l: { surface: string; status: string }) =>
          l.surface === 'thread_item' && l.status === 'failed',
      );
      expect(failedLink).toBeDefined();
      expect(failedLink.runId).toBe(ctx.runId);
      expect(failedLink.errorMessage).toBeTruthy();
      expect(failedLink.eventSequence).toBeGreaterThan(0);
      expect(failedLink.createdAt).toBeTruthy();

      // The projection.failed journal event is observable.
      const failedEvents = res.body.data.repairEvents.filter(
        (e: { type: string }) => e.type === 'projection.failed',
      );
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0].runId).toBe(ctx.runId);
      expect(failedEvents[0].payload.surface).toBe('thread_item');
      expect(failedEvents[0].sequence).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Observable repair evidence after repair (attributable)
  // -------------------------------------------------------------------------
  describe('observable repair evidence', () => {
    it('GET projection-repair exposes a repaired link, repair event, and repair activity after repair', async () => {
      const ctx = await freshRun('__mtest__ repair-route-repaired', {
        failSurface: 'thread_item',
      });

      // Repair the projection via the service (operator/system action).
      const projectionService = new MissionProjectionService(ctx.db);
      await projectionService.repair({
        companyId: ctx.companyId,
        projectId: ctx.projectId,
        runId: ctx.runId,
        surface: 'thread_item',
        traceId: 'trace-route-repair-1',
      });

      const res = await request(ctx.app)
        .get(`${ctx.base}/${ctx.runId}/projection-repair`)
        .expect(200);

      const links = res.body.data.projectionLinks;
      const repairedLink = links.find(
        (l: { surface: string; status: string }) =>
          l.surface === 'thread_item' && l.status === 'repaired',
      );
      expect(repairedLink).toBeDefined();
      expect(repairedLink.runId).toBe(ctx.runId);
      expect(repairedLink.traceId).toBe('trace-route-repair-1');
      expect(repairedLink.updatedAt).toBeTruthy();

      // The projection.repaired journal event is observable and attributable.
      const repairedEvents = res.body.data.repairEvents.filter(
        (e: { type: string }) => e.type === 'projection.repaired',
      );
      expect(repairedEvents).toHaveLength(1);
      expect(repairedEvents[0].runId).toBe(ctx.runId);
      expect(repairedEvents[0].traceId).toBe('trace-route-repair-1');
      expect(repairedEvents[0].payload.surface).toBe('thread_item');

      // A repair activity log entry is observable and attributable.
      const activity = res.body.data.repairActivity;
      expect(Array.isArray(activity)).toBe(true);
      const repairActivity = activity.find(
        (a: { action: string }) => a.action === 'mission.projection.repaired',
      );
      expect(repairActivity).toBeDefined();
      expect(repairActivity.entityId).toBe(ctx.runId);
      expect(repairActivity.metadata.surface).toBe('thread_item');
      expect(repairActivity.createdAt).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // No projection history → empty (but valid) response
  // -------------------------------------------------------------------------
  describe('empty projection history', () => {
    it('returns empty arrays for a run with no projection failures or repairs', async () => {
      const ctx = await freshRun('__mtest__ repair-route-empty');

      const res = await request(ctx.app)
        .get(`${ctx.base}/${ctx.runId}/projection-repair`)
        .expect(200);

      // A successful run still has active projection links for thread_item
      // and activity_log, but no failed/repaired links or repair events.
      const failedOrRepaired = res.body.data.projectionLinks.filter(
        (l: { status: string }) => l.status === 'failed' || l.status === 'repaired',
      );
      expect(failedOrRepaired).toHaveLength(0);
      expect(res.body.data.repairEvents).toEqual([]);
      expect(res.body.data.repairActivity).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Scope enforcement
  // -------------------------------------------------------------------------
  describe('scope enforcement', () => {
    it('cross-company projection-repair returns 404 RUN_NOT_FOUND', async () => {
      const ctx = await freshRun('__mtest__ repair-route-cross-co', {
        failSurface: 'thread_item',
      });
      const otherCompany = await request(ctx.app)
        .post('/api/companies')
        .send({ name: '__mtest__ other-co', settings: { testFixture: true } })
        .expect(201);
      const otherProject = await request(ctx.app)
        .post(`/api/companies/${otherCompany.body.data.id}/projects`)
        .send({ name: 'Other Project' })
        .expect(201);

      const res = await request(ctx.app)
        .get(
          `/api/companies/${otherCompany.body.data.id}/projects/${otherProject.body.data.id}/mission-runs/${ctx.runId}/projection-repair`,
        )
        .expect(404);
      expect(res.body.code).toBe('RUN_NOT_FOUND');
    });

    it('cross-project projection-repair returns 404 RUN_NOT_FOUND', async () => {
      const ctx = await freshRun('__mtest__ repair-route-cross-proj', {
        failSurface: 'thread_item',
      });
      const otherProject = await request(ctx.app)
        .post(`/api/companies/${ctx.companyId}/projects`)
        .send({ name: 'Other Project Same Co' })
        .expect(201);

      const res = await request(ctx.app)
        .get(
          `/api/companies/${ctx.companyId}/projects/${otherProject.body.data.id}/mission-runs/${ctx.runId}/projection-repair`,
        )
        .expect(404);
      expect(res.body.code).toBe('RUN_NOT_FOUND');
    });

    it('cross-company 404 is indistinguishable from a random nonexistent ID', async () => {
      const ctx = await freshRun('__mtest__ repair-route-indist', {
        failSurface: 'thread_item',
      });
      const otherCompany = await request(ctx.app)
        .post('/api/companies')
        .send({ name: '__mtest__ indist', settings: { testFixture: true } })
        .expect(201);
      const otherProject = await request(ctx.app)
        .post(`/api/companies/${otherCompany.body.data.id}/projects`)
        .send({ name: 'Ind Project' })
        .expect(201);
      const fakeId = randomUUID();

      const crossRes = await request(ctx.app)
        .get(
          `/api/companies/${otherCompany.body.data.id}/projects/${otherProject.body.data.id}/mission-runs/${ctx.runId}/projection-repair`,
        )
        .expect(404);
      const fakeRes = await request(ctx.app)
        .get(
          `/api/companies/${otherCompany.body.data.id}/projects/${otherProject.body.data.id}/mission-runs/${fakeId}/projection-repair`,
        )
        .expect(404);

      expect(crossRes.status).toBe(fakeRes.status);
      expect(crossRes.body.code).toBe(fakeRes.body.code);
      expect(crossRes.body.message).toBe(fakeRes.body.message);
    });
  });

  // -------------------------------------------------------------------------
  // Read permission and flag-independence
  // -------------------------------------------------------------------------
  describe('read permission and flag independence', () => {
    it('viewer can read projection-repair status', async () => {
      const ctx = await freshRun('__mtest__ repair-route-viewer', {
        failSurface: 'thread_item',
      });

      const res = await request(ctx.app)
        .get(`${ctx.base}/${ctx.runId}/projection-repair`)
        .set({ 'X-Eidolon-Test-Org-Role': 'viewer' })
        .expect(200);
      expect(
        res.body.data.projectionLinks.some(
          (l: { surface: string; status: string }) =>
            l.surface === 'thread_item' && l.status === 'failed',
        ),
      ).toBe(true);
    });

    it('projection-repair is readable when the mission flag is disabled', async () => {
      const ctx = await freshRun('__mtest__ repair-route-no-flag', {
        failSurface: 'thread_item',
      });
      // Disable the flag — reads should remain available (VAL-RUN-102).
      vi.stubEnv('EIDOLON_FEATURE_FLAGS', JSON.stringify({}));

      const res = await request(ctx.app)
        .get(`${ctx.base}/${ctx.runId}/projection-repair`)
        .expect(200);
      expect(
        res.body.data.projectionLinks.some(
          (l: { surface: string; status: string }) => l.surface === 'thread_item',
        ),
      ).toBe(true);
    });

    it('unauthenticated projection-repair read returns 401', async () => {
      const ctx = await freshRun('__mtest__ repair-route-unauth', {
        failSurface: 'thread_item',
      });
      const authApp = await createTestServer(ctx.db, 'authenticated');

      const res = await request(authApp)
        .get(`${ctx.base}/${ctx.runId}/projection-repair`)
        .expect(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });
  });

  // -------------------------------------------------------------------------
  // Post-terminal repair does not append to the closed run journal
  // (observable via the route: repair event absent from run journal, but
  // the link is repaired and repair activity is present)
  // -------------------------------------------------------------------------
  describe('post-terminal repair observability', () => {
    it('a post-terminal repair updates the link and activity but adds no run journal event', async () => {
      const ctx = await freshRun('__mtest__ repair-route-terminal', {
        failSurface: 'thread_item',
      });

      // Terminalize the run manually.
      await ctx.db.drizzle.execute(sql`
        UPDATE mission_runs SET status = 'completed', terminal_at = now(),
          state_version = state_version + 1, updated_at = now()
        WHERE id = ${ctx.runId}
      `);

      const projectionService = new MissionProjectionService(ctx.db);
      await projectionService.repair({
        companyId: ctx.companyId,
        projectId: ctx.projectId,
        runId: ctx.runId,
        surface: 'thread_item',
        traceId: 'trace-route-terminal-repair',
      });

      const res = await request(ctx.app)
        .get(`${ctx.base}/${ctx.runId}/projection-repair`)
        .expect(200);

      // The link is repaired.
      const repairedLink = res.body.data.projectionLinks.find(
        (l: { surface: string; status: string }) =>
          l.surface === 'thread_item' && l.status === 'repaired',
      );
      expect(repairedLink).toBeDefined();

      // No projection.repaired event in the run journal (only failed).
      const repairedEvents = res.body.data.repairEvents.filter(
        (e: { type: string }) => e.type === 'projection.repaired',
      );
      expect(repairedEvents).toHaveLength(0);

      // But the repair activity entry IS present (separate from run journal).
      const repairActivity = res.body.data.repairActivity.find(
        (a: { action: string }) => a.action === 'mission.projection.repaired',
      );
      expect(repairActivity).toBeDefined();
      expect(repairActivity.entityId).toBe(ctx.runId);
    });
  });
});
