import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, createTestServer } from '../test-utils.js';
import { validateIdempotencyKey } from '../services/mission/idempotency.js';

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

// ---------------------------------------------------------------------------
// VAL-RUN-012: Malformed JSON body returns 400 VALIDATION_ERROR, not 500
// ---------------------------------------------------------------------------

describe('Mission malformed JSON body (VAL-RUN-012)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let base: string;

  beforeAll(async () => {
    enableMissionFlag();
    db = await createTestDb();
    app = await createTestServer(db);
    const scope = await seedScope(db, '__mtest__ malformed-json');
    companyId = scope.companyId;
    projectId = scope.projectId;
    base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
  });
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  it('rejects a malformed JSON body with 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .post(base)
      .set('Content-Type', 'application/json')
      .set('Idempotency-Key', `malformed-${randomUUID()}`)
      .send('{invalid json}');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('does not expose raw V8 JSON.parse error details', async () => {
    const res = await request(app)
      .post(base)
      .set('Content-Type', 'application/json')
      .set('Idempotency-Key', `malformed-${randomUUID()}`)
      .send('{invalid json}');
    expect(res.body.code).toBe('VALIDATION_ERROR');
    const bodyStr = JSON.stringify(res.body);
    // Raw V8 JSON.parse error messages contain these phrases; they must
    // never appear in the API response.
    expect(bodyStr).not.toContain('Unexpected token');
    expect(bodyStr).not.toContain('JSON at position');
    expect(bodyStr).not.toContain('Unexpected end');
  });

  it('creates no partial run on malformed JSON', async () => {
    const before = await countRuns(db, companyId, projectId);
    await request(app)
      .post(base)
      .set('Content-Type', 'application/json')
      .set('Idempotency-Key', `malformed-${randomUUID()}`)
      .send('{invalid json}')
      .expect(400);
    const after = await countRuns(db, companyId, projectId);
    expect(after).toBe(before);
  });

  it('rejects malformed JSON on the canonical command route with 400', async () => {
    // Use a random runId — the JSON parse error fires before any DB lookup.
    const res = await request(app)
      .post(`${base}/${randomUUID()}/commands`)
      .set('Content-Type', 'application/json')
      .set('Idempotency-Key', `malformed-cmd-${randomUUID()}`)
      .send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('still accepts a valid JSON body after a malformed one', async () => {
    // The server must remain healthy after a malformed request.
    const threadId = randomUUID();
    const now = new Date();
    await db.drizzle.execute(sql`
      INSERT INTO "project_threads" ("id", "company_id", "project_id", "title", "type", "status", "created_at", "updated_at")
      VALUES (${threadId}, ${companyId}, ${projectId}, 'T2', 'conversation', 'active', ${now}, ${now})
    `);
    const res = await request(app)
      .post(base)
      .set('Idempotency-Key', `valid-after-malformed-${randomUUID()}`)
      .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'Do work' } });
    expect(res.status).toBe(202);
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-114: Idempotency keys enforce syntax and length (whitespace focus)
// ---------------------------------------------------------------------------

describe('Mission idempotency key whitespace rejection (VAL-RUN-114)', () => {
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  // The validator is the seam for boundary cases that HTTP cannot transport:
  // leading/trailing whitespace is stripped by the HTTP header parser per
  // RFC 7230 before Express sees the value, so the contract is proven at the
  // validator level. The route-level tests below verify that HTTP-stripped
  // keys are still accepted (correct behavior) and that non-whitespace
  // invalid keys are rejected at the route level.

  describe('validateIdempotencyKey rejects whitespace keys', () => {
    const cases: Array<[string, string]> = [
      [' key', 'leading space'],
      ['key ', 'trailing space'],
      ['\tkey', 'leading tab'],
      ['key\t', 'trailing tab'],
      ['\nkey', 'leading newline'],
      [' key ', 'surrounding spaces'],
      ['\tkey\t', 'surrounding tabs'],
    ];

    for (const [key, label] of cases) {
      it(`rejects ${label} with 400 VALIDATION_ERROR`, () => {
        expect(() => validateIdempotencyKey(key)).toThrow();
        try {
          validateIdempotencyKey(key);
        } catch (err) {
          expect((err as { code: string }).code).toBe('VALIDATION_ERROR');
          expect((err as { status: number }).status).toBe(400);
        }
      });
    }

    it('accepts a key with internal whitespace (not leading/trailing)', () => {
      expect(validateIdempotencyKey('key with spaces')).toBe('key with spaces');
    });

    it('does not trim the key before returning it', () => {
      // A valid key without leading/trailing whitespace is returned as-is.
      const key = 'abc-123';
      expect(validateIdempotencyKey(key)).toBe(key);
    });
  });

  describe('route-level: valid keys without whitespace are accepted', () => {
    let db: AnyDb;
    let app: Awaited<ReturnType<typeof createTestServer>>;
    let companyId: string;
    let projectId: string;
    let threadId: string;
    let base: string;

    beforeAll(async () => {
      enableMissionFlag();
      db = await createTestDb();
      app = await createTestServer(db);
      const scope = await seedScope(db, '__mtest__ ws-key-route');
      companyId = scope.companyId;
      projectId = scope.projectId;
      threadId = scope.threadId;
      base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    });
    beforeEach(() => enableMissionFlag());
    afterEach(() => vi.unstubAllEnvs());

    it('accepts a 1-char key with 202', async () => {
      const res = await request(app)
        .post(base)
        .set('Idempotency-Key', 'a')
        .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'len1' } });
      expect(res.status).toBe(202);
    });

    it('accepts a 128-char key with 202', async () => {
      const res = await request(app)
        .post(base)
        .set('Idempotency-Key', 'x'.repeat(128))
        .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'len128' } });
      expect(res.status).toBe(202);
    });

    it('rejects an empty key with 400 VALIDATION_ERROR', async () => {
      const before = await countRuns(db, companyId, projectId);
      const res = await request(app)
        .post(base)
        .set('Idempotency-Key', '')
        .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'empty' } })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(await countRuns(db, companyId, projectId)).toBe(before);
    });

    it('rejects an over-128 key with 400 VALIDATION_ERROR', async () => {
      const before = await countRuns(db, companyId, projectId);
      const res = await request(app)
        .post(base)
        .set('Idempotency-Key', 'x'.repeat(129))
        .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'over128' } })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(await countRuns(db, companyId, projectId)).toBe(before);
    });
  });
});
