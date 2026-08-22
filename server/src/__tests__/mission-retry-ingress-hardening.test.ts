import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, createTestServer } from '../test-utils.js';
import { decryptEnvelope } from '../services/mission/ingress.js';

/**
 * Retry ingress hardening (VAL-RUN-133, VAL-RUN-134, Normative Boundary 3).
 *
 * The run.retry branch in MissionCommandService.applyRetry must route through
 * validateAndEncryptIngress so retry successors get the same reference
 * isolation, structural bounds, NFC-normalized safe summary, and
 * encryption-at-rest as MissionStartService.start.
 */

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

async function seedArtifact(
  db: AnyDb,
  companyId: string,
  projectId: string,
  title: string,
  status = 'active',
) {
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "artifacts" ("id", "company_id", "project_id", "type", "title", "content", "content_schema_version", "status", "version", "created_at", "updated_at")
    VALUES (${id}, ${companyId}, ${projectId}, 'document', ${title}, '{}'::jsonb, 1, ${status}, 1, ${now}, ${now})
  `);
  return id;
}

function enableMissionFlag() {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify({ missionAgentIntelligence: { enabled: true } }),
  );
}

/** Start a run, then force it to `failed` so retry is legal. Returns the
 *  run id, the current state_version (for If-Match), and API helpers. */
async function freshFailedRun(
  app: ReturnType<typeof createTestServer> extends Promise<infer T> ? T : never,
  db: AnyDb,
  companyId: string,
  projectId: string,
  threadId: string,
  text = 'Original request text.',
): Promise<{ runId: string; stateVersion: number; base: string }> {
  const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
  const start = await request(app)
    .post(base)
    .set('Idempotency-Key', `retry-ingress-start-${randomUUID()}`)
    .send({ projectThreadId: threadId, mode: 'fast', request: { text } })
    .expect(202);
  const runId = start.body.data.run.id as string;

  // Force the run to failed so retry is legal.
  await db.drizzle.execute(sql`
    UPDATE "mission_runs"
    SET "status" = 'failed', "terminal_at" = NOW(), "state_version" = "state_version" + 1
    WHERE "id" = ${runId}
  `);

  // Read the current state_version for If-Match.
  const rows = await execRows<{ sv: number }>(
    db,
    sql`SELECT state_version AS sv FROM "mission_runs" WHERE id = ${runId}`,
  );
  return { runId, stateVersion: rows[0].sv, base };
}

describe('Mission retry ingress hardening (VAL-RUN-133/134, Normative Boundary 3)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;
  let otherCompanyId: string;
  let otherProjectId: string;

  beforeAll(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    companyId = await seedCompany(db, '__mtest__ retry-ingress');
    projectId = await seedProject(db, companyId, 'P');
    threadId = await seedThread(db, companyId, projectId, 'T');
    otherCompanyId = await seedCompany(db, '__mtest__ retry-ingress-other');
    otherProjectId = await seedProject(db, otherCompanyId, 'OP');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // -------------------------------------------------------------------------
  // VAL-RUN-134: Structural bounds on retry with new request
  // -------------------------------------------------------------------------

  it('rejects retry with text exceeding 20,000 code points (VAL-RUN-134)', async () => {
    const ctx = await freshFailedRun(app, db, companyId, projectId, threadId);
    const overText = 'a'.repeat(20_001);
    const res = await request(app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', `retry-over-text-${randomUUID()}`)
      .set('If-Match', `"${ctx.stateVersion}"`)
      .send({ request: { text: overText } })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects retry with more than 20 total references (VAL-RUN-134)', async () => {
    const ctx = await freshFailedRun(app, db, companyId, projectId, threadId);
    const attachments = Array.from({ length: 21 }, () => randomUUID());
    const res = await request(app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', `retry-over-refs-${randomUUID()}`)
      .set('If-Match', `"${ctx.stateVersion}"`)
      .send({ request: { text: 'Retry text', attachments } })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects retry with metadata field over 500 code points (VAL-RUN-134)', async () => {
    const ctx = await freshFailedRun(app, db, companyId, projectId, threadId);
    const res = await request(app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', `retry-over-meta-${randomUUID()}`)
      .set('If-Match', `"${ctx.stateVersion}"`)
      .send({ request: { text: 'Retry', context: { label: 'x'.repeat(501) } } })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  // -------------------------------------------------------------------------
  // VAL-RUN-133: Reference isolation on retry with new request
  // -------------------------------------------------------------------------

  it('rejects retry with foreign-company artifact references (VAL-RUN-133)', async () => {
    const ctx = await freshFailedRun(app, db, companyId, projectId, threadId);
    const foreignArtifact = await seedArtifact(db, otherCompanyId, otherProjectId, 'Foreign');
    const res = await request(app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', `retry-foreign-ref-${randomUUID()}`)
      .set('If-Match', `"${ctx.stateVersion}"`)
      .send({ request: { text: 'Retry with foreign ref', attachments: [foreignArtifact] } })
      .expect(404);
    expect(res.body.code).toBe('REFERENCE_NOT_FOUND');
  });

  it('rejects retry with deleted artifact references (VAL-RUN-133)', async () => {
    const ctx = await freshFailedRun(app, db, companyId, projectId, threadId);
    const deletedArtifact = await seedArtifact(db, companyId, projectId, 'Deleted', 'deleted');
    const res = await request(app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', `retry-deleted-ref-${randomUUID()}`)
      .set('If-Match', `"${ctx.stateVersion}"`)
      .send({ request: { text: 'Retry with deleted ref', attachments: [deletedArtifact] } })
      .expect(404);
    expect(res.body.code).toBe('REFERENCE_NOT_FOUND');
  });

  it('rejects retry with wrong-project artifact references (VAL-RUN-133)', async () => {
    const ctx = await freshFailedRun(app, db, companyId, projectId, threadId);
    const otherProj = await seedProject(db, companyId, 'P2');
    const wrongProjectArtifact = await seedArtifact(db, companyId, otherProj, 'WrongProject');
    const res = await request(app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', `retry-wrong-proj-${randomUUID()}`)
      .set('If-Match', `"${ctx.stateVersion}"`)
      .send({
        request: { text: 'Retry with wrong-project ref', attachments: [wrongProjectArtifact] },
      })
      .expect(404);
    expect(res.body.code).toBe('REFERENCE_NOT_FOUND');
  });

  it('accepts retry with valid same-company same-project references (VAL-RUN-133)', async () => {
    const ctx = await freshFailedRun(app, db, companyId, projectId, threadId);
    const validArtifact = await seedArtifact(db, companyId, projectId, 'Valid');
    const res = await request(app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', `retry-valid-ref-${randomUUID()}`)
      .set('If-Match', `"${ctx.stateVersion}"`)
      .send({ request: { text: 'Retry with valid ref', attachments: [validArtifact] } })
      .expect(202);
    expect(res.body.data.run.id).not.toBe(ctx.runId);
  });

  // -------------------------------------------------------------------------
  // VAL-RUN-134: Safe summary on retry successor
  // -------------------------------------------------------------------------

  it('sets request_safe_summary on the successor run when retry provides a new request', async () => {
    const ctx = await freshFailedRun(app, db, companyId, projectId, threadId);
    const res = await request(app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', `retry-summary-new-${randomUUID()}`)
      .set('If-Match', `"${ctx.stateVersion}"`)
      .send({ request: { text: 'Retry with a fresh request summary.' } })
      .expect(202);
    const successorId = res.body.data.run.id;
    const rows = await execRows<{ request_safe_summary: string | null }>(
      db,
      sql`SELECT request_safe_summary FROM "mission_runs" WHERE id = ${successorId}`,
    );
    expect(rows[0].request_safe_summary).not.toBeNull();
    expect(rows[0].request_safe_summary).toContain('Retry with a fresh request summary');
  });

  it('sets request_safe_summary on the successor run when retry copies the original request', async () => {
    const ctx = await freshFailedRun(
      app,
      db,
      companyId,
      projectId,
      threadId,
      'Original text for copy-retry summary.',
    );
    const res = await request(app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', `retry-summary-copy-${randomUUID()}`)
      .set('If-Match', `"${ctx.stateVersion}"`)
      .send({})
      .expect(202);
    const successorId = res.body.data.run.id;
    const rows = await execRows<{ request_safe_summary: string | null }>(
      db,
      sql`SELECT request_safe_summary FROM "mission_runs" WHERE id = ${successorId}`,
    );
    expect(rows[0].request_safe_summary).not.toBeNull();
    expect(rows[0].request_safe_summary).toContain('Original text for copy-retry summary');
  });

  // -------------------------------------------------------------------------
  // VAL-RUN-135: Encryption at rest on retry successor
  // -------------------------------------------------------------------------

  it('encrypts the retry successor request envelope at rest', async () => {
    const ctx = await freshFailedRun(app, db, companyId, projectId, threadId);
    const canary = 'RETRY_INGRESS_CANARY_' + randomUUID();
    const res = await request(app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', `retry-encrypt-${randomUUID()}`)
      .set('If-Match', `"${ctx.stateVersion}"`)
      .send({ request: { text: canary } })
      .expect(202);
    const successorId = res.body.data.run.id;
    const rows = await execRows<{ request_envelope: string }>(
      db,
      sql`SELECT request_envelope FROM "mission_runs" WHERE id = ${successorId}`,
    );
    expect(rows[0].request_envelope).not.toContain(canary);
    // Authorized decryption should work.
    const envelope = decryptEnvelope(rows[0].request_envelope);
    expect(envelope.text).toBe(canary);
  });

  // -------------------------------------------------------------------------
  // VAL-RUN-133/134: Rejection creates no successor or side effects
  // -------------------------------------------------------------------------

  it('rejects retry with foreign reference atomically (no successor created)', async () => {
    const ctx = await freshFailedRun(app, db, companyId, projectId, threadId);
    const runsBefore = await execRows<{ c: number }>(
      db,
      sql`SELECT count(*)::int AS c FROM "mission_runs" WHERE company_id = ${companyId} AND project_id = ${projectId}`,
    );
    const foreignArtifact = await seedArtifact(db, otherCompanyId, otherProjectId, 'Foreign2');
    await request(app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', `retry-atomic-foreign-${randomUUID()}`)
      .set('If-Match', `"${ctx.stateVersion}"`)
      .send({ request: { text: 'Retry with foreign ref', attachments: [foreignArtifact] } })
      .expect(404);
    const runsAfter = await execRows<{ c: number }>(
      db,
      sql`SELECT count(*)::int AS c FROM "mission_runs" WHERE company_id = ${companyId} AND project_id = ${projectId}`,
    );
    expect(runsAfter[0].c).toBe(runsBefore[0].c);
  });

  it('rejects retry with oversized text atomically (no successor created)', async () => {
    const ctx = await freshFailedRun(app, db, companyId, projectId, threadId);
    const runsBefore = await execRows<{ c: number }>(
      db,
      sql`SELECT count(*)::int AS c FROM "mission_runs" WHERE company_id = ${companyId} AND project_id = ${projectId}`,
    );
    await request(app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', `retry-atomic-over-${randomUUID()}`)
      .set('If-Match', `"${ctx.stateVersion}"`)
      .send({ request: { text: 'a'.repeat(20_001) } })
      .expect(400);
    const runsAfter = await execRows<{ c: number }>(
      db,
      sql`SELECT count(*)::int AS c FROM "mission_runs" WHERE company_id = ${companyId} AND project_id = ${projectId}`,
    );
    expect(runsAfter[0].c).toBe(runsBefore[0].c);
  });
});
