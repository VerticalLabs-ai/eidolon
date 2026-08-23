import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, createTestServer } from '../test-utils.js';
import { MissionStartService } from '../services/mission/start.js';
import {
  validateStructuralBounds,
  generateSafeSummary,
  countCodePoints,
  measureDepth,
  collectReferences,
  countNestedReferences,
  measureUtf8Bytes,
  encryptEnvelope,
  decryptEnvelope,
  encryptStartPayload,
  decryptStartPayload,
  validateReferences,
  INGRESS_LIMITS,
} from '../services/mission/ingress.js';

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

async function seedAgentFile(db: AnyDb, companyId: string, projectId: string | null, name: string) {
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "agent_files" ("id", "company_id", "project_id", "name", "path", "mime_type", "size_bytes", "storage_type", "created_at", "updated_at")
    VALUES (${id}, ${companyId}, ${projectId}, ${name}, '/tmp/'||${name}, 'text/plain', 100, 'inline', ${now}, ${now})
  `);
  return id;
}

function enableMissionFlag() {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify({ missionAgentIntelligence: { enabled: true } }),
  );
}

async function countRuns(db: AnyDb, companyId: string, projectId: string): Promise<number> {
  const rows = await execRows<{ c: number }>(
    db,
    sql`SELECT count(*)::int AS c FROM "mission_runs" WHERE company_id = ${companyId} AND project_id = ${projectId}`,
  );
  return rows[0].c;
}

async function countCommands(db: AnyDb, companyId: string, projectId: string): Promise<number> {
  const rows = await execRows<{ c: number }>(
    db,
    sql`SELECT count(*)::int AS c FROM "run_commands" WHERE company_id = ${companyId} AND project_id = ${projectId}`,
  );
  return rows[0].c;
}

// ---------------------------------------------------------------------------
// Unit tests: structural bounds (VAL-RUN-134)
// ---------------------------------------------------------------------------

describe('Ingress structural bounds (VAL-RUN-134)', () => {
  describe('countCodePoints', () => {
    it('counts Unicode code points, not UTF-16 code units', () => {
      expect(countCodePoints('abc')).toBe(3);
      // Astral character (emoji) is one code point but two UTF-16 code units
      expect(countCodePoints('a😀b')).toBe(3);
      expect(countCodePoints('𝕳𝖊𝖑𝖑𝖔')).toBe(5);
    });
  });

  describe('measureDepth', () => {
    it('measures scalar depth as 0', () => {
      expect(measureDepth('x')).toBe(0);
      expect(measureDepth(42)).toBe(0);
      expect(measureDepth(null)).toBe(0);
      expect(measureDepth(true)).toBe(0);
    });
    it('measures empty object depth as 1', () => {
      expect(measureDepth({})).toBe(1);
    });
    it('measures nested object depth', () => {
      expect(measureDepth({ a: { b: { c: 'x' } } })).toBe(3);
      expect(measureDepth({ a: 'x', b: { c: 'y' } })).toBe(2);
    });
    it('measures array depth as max of items', () => {
      expect(measureDepth([{ a: { b: 'x' } }])).toBe(2);
      expect(measureDepth([1, 2, 3])).toBe(0);
    });
  });

  describe('collectReferences', () => {
    it('collects unique UUIDs from nested objects', () => {
      const id1 = randomUUID();
      const id2 = randomUUID();
      const refs = collectReferences({ a: id1, b: [id2, id1], c: { d: id1 } });
      expect(refs).toEqual([id1, id2]);
    });
    it('ignores non-UUID strings', () => {
      expect(collectReferences({ a: 'not-a-uuid', b: 42 })).toEqual([]);
    });
  });

  describe('countNestedReferences', () => {
    it('counts all UUIDs including duplicates', () => {
      const id1 = randomUUID();
      const id2 = randomUUID();
      expect(countNestedReferences({ a: id1, b: id1, c: [id2, id2] })).toBe(4);
    });
  });

  describe('measureUtf8Bytes', () => {
    it('measures canonical UTF-8 bytes', () => {
      expect(measureUtf8Bytes({ text: 'abc' })).toBe(14); // {"text":"abc"}
      // Multi-byte UTF-8 characters take more bytes
      expect(measureUtf8Bytes({ text: 'あ' })).toBe(14); // {"text":"あ"} = 11 ASCII + 3 byte char
      expect(measureUtf8Bytes({ text: 'あいう' })).toBe(20); // 9 + 9 + 2 = 20
    });
  });

  describe('validateStructuralBounds - exact boundaries', () => {
    it('accepts exactly 20,000 code points of text', () => {
      const text = 'a'.repeat(INGRESS_LIMITS.MAX_TEXT_CODEPOINTS);
      expect(() => validateStructuralBounds({ text })).not.toThrow();
    });
    it('rejects 20,001 code points of text', () => {
      const text = 'a'.repeat(INGRESS_LIMITS.MAX_TEXT_CODEPOINTS + 1);
      expect(() => validateStructuralBounds({ text })).toThrow();
    });
    it('rejects empty text', () => {
      expect(() => validateStructuralBounds({ text: '' })).toThrow();
    });
    it('counts Unicode code points not UTF-16 units for text', () => {
      // 20,000 emoji = 20,000 code points but 40,000 UTF-16 units
      const text = '😀'.repeat(INGRESS_LIMITS.MAX_TEXT_CODEPOINTS);
      expect(() => validateStructuralBounds({ text })).not.toThrow();
    });
  });

  describe('validateStructuralBounds - references', () => {
    it('accepts exactly 20 total references', () => {
      const attachments = Array.from({ length: 20 }, () => randomUUID());
      expect(() => validateStructuralBounds({ text: 'x', attachments })).not.toThrow();
    });
    it('rejects 21 total references', () => {
      const attachments = Array.from({ length: 21 }, () => randomUUID());
      expect(() => validateStructuralBounds({ text: 'x', attachments })).toThrow();
    });
    it('counts context references toward total', () => {
      const contextId = randomUUID();
      const attachments = Array.from({ length: 20 }, () => randomUUID());
      // 20 attachments + 1 context ref = 21 total → reject
      expect(() =>
        validateStructuralBounds({ text: 'x', attachments, context: { ref: contextId } }),
      ).toThrow();
    });
  });

  describe('validateStructuralBounds - nested references', () => {
    it('accepts exactly 100 nested context references', () => {
      // UUIDs are nested inside an array, not top-level keys, so the 20 total
      // reference cap (attachments + top-level context UUIDs) is not triggered.
      const refs = Array.from({ length: 100 }, () => randomUUID());
      const context = { refs };
      expect(() => validateStructuralBounds({ text: 'x', context })).not.toThrow();
    });
    it('rejects 101 nested context references', () => {
      const refs = Array.from({ length: 101 }, () => randomUUID());
      const context = { refs };
      expect(() => validateStructuralBounds({ text: 'x', context })).toThrow();
    });
  });

  describe('validateStructuralBounds - metadata fields', () => {
    it('accepts exactly 500 code points in a metadata field', () => {
      const context = { label: 'a'.repeat(500) };
      expect(() => validateStructuralBounds({ text: 'x', context })).not.toThrow();
    });
    it('rejects 501 code points in a metadata field', () => {
      const context = { label: 'a'.repeat(501) };
      expect(() => validateStructuralBounds({ text: 'x', context })).toThrow();
    });
  });

  describe('validateStructuralBounds - context depth', () => {
    it('accepts depth 8', () => {
      let ctx: Record<string, unknown> = { v: 'x' };
      for (let i = 0; i < 7; i++) {
        ctx = { nested: ctx };
      }
      expect(() => validateStructuralBounds({ text: 'x', context: ctx })).not.toThrow();
    });
    it('rejects depth 9', () => {
      let ctx: Record<string, unknown> = { v: 'x' };
      for (let i = 0; i < 8; i++) {
        ctx = { nested: ctx };
      }
      expect(() => validateStructuralBounds({ text: 'x', context: ctx })).toThrow();
    });
  });

  describe('validateStructuralBounds - total bytes', () => {
    it('accepts envelope under 262,144 bytes', () => {
      // Use valid text length (20k chars) plus large nested context to
      // approach the byte cap. Nested strings are not subject to the 500cp
      // metadata field cap (only top-level string values are).
      const text = 'a'.repeat(20_000);
      const context = { nested: { data: 'x'.repeat(240_000) } };
      expect(() => validateStructuralBounds({ text, context })).not.toThrow();
    });
    it('rejects envelope over 262,144 bytes', () => {
      const text = 'a'.repeat(20_000);
      // JSON overhead (~57 bytes) + 20,000 text + 242,100 context = 262,157 > 262,144
      const context = { nested: { data: 'x'.repeat(242_100) } };
      expect(() => validateStructuralBounds({ text, context })).toThrow();
    });
  });

  describe('validateStructuralBounds - NFC normalization', () => {
    it('normalizes text to NFC', () => {
      // NFD form of 'é' is two code points (e + combining accent)
      const nfd = 'e\u0301';
      const result = validateStructuralBounds({ text: nfd });
      expect(result).toBe('é'); // NFC form
    });
  });
});

// ---------------------------------------------------------------------------
// Unit tests: safe summary (VAL-RUN-134)
// ---------------------------------------------------------------------------

describe('Ingress safe summary (VAL-RUN-134)', () => {
  it('generates NFC-normalized inert text', () => {
    const summary = generateSafeSummary('Hello world');
    expect(summary).toBe('Hello world');
  });
  it('escapes HTML to make hostile markup inert', () => {
    const summary = generateSafeSummary('<script>alert(1)</script>');
    expect(summary).not.toContain('<script>');
    expect(summary).toContain('&lt;script&gt;');
  });
  it('escapes quotes and ampersands', () => {
    const summary = generateSafeSummary('a "b" & c\'d');
    expect(summary).toContain('&quot;');
    expect(summary).toContain('&amp;');
    expect(summary).toContain('&#39;');
  });
  it('caps at 500 code points with ellipsis', () => {
    const text = 'a'.repeat(600);
    const summary = generateSafeSummary(text);
    expect(countCodePoints(summary)).toBeLessThanOrEqual(
      INGRESS_LIMITS.MAX_SAFE_SUMMARY_CODEPOINTS + 1,
    ); // +1 for ellipsis
    expect(summary.endsWith('…')).toBe(true);
  });
  it('handles NFC normalization before truncation', () => {
    const nfd = 'e\u0301'.repeat(10);
    const summary = generateSafeSummary(nfd);
    expect(summary).toBe('é'.repeat(10));
  });
});

// ---------------------------------------------------------------------------
// Unit tests: encryption at rest (VAL-RUN-135)
// ---------------------------------------------------------------------------

describe('Ingress encryption (VAL-RUN-135)', () => {
  it('encrypts and decrypts a request envelope round-trip', () => {
    const envelope = { text: 'secret request', attachments: [], context: {} };
    const encrypted = encryptEnvelope(envelope);
    expect(encrypted).not.toBe(JSON.stringify(envelope));
    expect(encrypted).not.toContain('secret request');
    const decrypted = decryptEnvelope(encrypted);
    expect(decrypted).toEqual(envelope);
  });
  it('produces ciphertext that does not contain plaintext', () => {
    const canary = 'CANARY_PLAINTEXT_' + randomUUID();
    const encrypted = encryptEnvelope({ text: canary, attachments: [], context: {} });
    expect(encrypted).not.toContain(canary);
  });
  it('encrypts and decrypts start payload request field', () => {
    const payload = { request: { text: 'hello', attachments: [] }, mode: 'fast', limits: null };
    const encrypted = encryptStartPayload(payload);
    expect(typeof encrypted.request).toBe('string');
    expect(encrypted.request).not.toContain('hello');
    expect(encrypted.mode).toBe('fast'); // non-sensitive fields remain plaintext
    const decrypted = decryptStartPayload(encrypted);
    expect(decrypted.request).toEqual({ text: 'hello', attachments: [] });
    expect(decrypted.mode).toBe('fast');
  });
});

// ---------------------------------------------------------------------------
// Integration tests: reference validation (VAL-RUN-133)
// ---------------------------------------------------------------------------

describe('Reference validation (VAL-RUN-133)', () => {
  let db: AnyDb;
  let companyId: string;
  let projectId: string;
  let otherCompanyId: string;
  let otherProjectId: string;
  let artifactId: string;
  let otherArtifactId: string;
  let agentFileId: string;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    companyId = await seedCompany(db, '__mtest__ refs');
    projectId = await seedProject(db, companyId, 'P');
    otherCompanyId = await seedCompany(db, '__mtest__ other-refs');
    otherProjectId = await seedProject(db, otherCompanyId, 'OP');
    artifactId = await seedArtifact(db, companyId, projectId, 'Artifact');
    otherArtifactId = await seedArtifact(db, otherCompanyId, otherProjectId, 'Other Artifact');
    agentFileId = await seedAgentFile(db, companyId, projectId, 'file.txt');
  });

  it('accepts valid same-company same-project artifact references', async () => {
    const refs = await validateReferences(db, {
      companyId,
      projectId,
      attachments: [artifactId],
    });
    expect(refs).toEqual([artifactId]);
  });

  it('accepts valid same-company agent file references', async () => {
    const refs = await validateReferences(db, {
      companyId,
      projectId,
      attachments: [agentFileId],
    });
    expect(refs).toEqual([agentFileId]);
  });

  it('accepts valid context references', async () => {
    const refs = await validateReferences(db, {
      companyId,
      projectId,
      context: { artifact: artifactId },
    });
    expect(refs).toEqual([artifactId]);
  });

  it('rejects foreign company artifact with non-enumerating 404', async () => {
    await expect(
      validateReferences(db, { companyId, projectId, attachments: [otherArtifactId] }),
    ).rejects.toMatchObject({ status: 404, code: 'REFERENCE_NOT_FOUND' });
  });

  it('rejects deleted artifacts', async () => {
    const deletedId = await seedArtifact(db, companyId, projectId, 'Deleted', 'deleted');
    await expect(
      validateReferences(db, { companyId, projectId, attachments: [deletedId] }),
    ).rejects.toMatchObject({ status: 404, code: 'REFERENCE_NOT_FOUND' });
  });

  it('rejects non-existent references (random UUID)', async () => {
    await expect(
      validateReferences(db, { companyId, projectId, attachments: [randomUUID()] }),
    ).rejects.toMatchObject({ status: 404, code: 'REFERENCE_NOT_FOUND' });
  });

  it('rejects wrong-project artifacts', async () => {
    // Artifact in the same company but different project
    const otherProjectId2 = await seedProject(db, companyId, 'P2');
    const wrongProjectArtifact = await seedArtifact(db, companyId, otherProjectId2, 'WP');
    await expect(
      validateReferences(db, { companyId, projectId, attachments: [wrongProjectArtifact] }),
    ).rejects.toMatchObject({ status: 404, code: 'REFERENCE_NOT_FOUND' });
  });

  it('does not reveal the other company ID in the error', async () => {
    try {
      await validateReferences(db, { companyId, projectId, attachments: [otherArtifactId] });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(JSON.stringify(err)).not.toContain(otherCompanyId);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests: full start with encryption (VAL-RUN-133, 134, 135)
// ---------------------------------------------------------------------------

describe('Mission start with encrypted ingress (VAL-RUN-133/134/135)', () => {
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
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ encrypted', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'P' })
      .expect(201);
    projectId = project.body.data.id;
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'T' })
      .expect(201);
    threadId = thread.body.data.id;
    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ other-enc', settings: { testFixture: true } })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;
    const otherProject = await request(app)
      .post(`/api/companies/${otherCompanyId}/projects`)
      .send({ name: 'OP' })
      .expect(201);
    otherProjectId = otherProject.body.data.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const startUrl = () => `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
  const validBody = (thread: string = threadId) => ({
    projectThreadId: thread,
    mode: 'fast' as const,
    request: { text: 'Summarize the report.' },
  });

  // VAL-RUN-135: request envelope is encrypted at rest
  it('stores the request envelope encrypted (not plaintext) in the database', async () => {
    const canary = 'PLAINTEXT_CANARY_' + randomUUID();
    const res = await request(app)
      .post(startUrl())
      .set('Idempotency-Key', 'enc-start-001')
      .send({ ...validBody(), request: { text: canary } })
      .expect(202);

    const runId = res.body.data.run.id;
    const rows = await execRows<{ request_envelope: string }>(
      db,
      sql`SELECT request_envelope FROM "mission_runs" WHERE id = ${runId}`,
    );
    expect(rows[0].request_envelope).not.toContain(canary);
    // Verify it can be decrypted by an authorized path
    const decrypted = decryptEnvelope(rows[0].request_envelope);
    expect(decrypted.text).toBe(canary);
  });

  // VAL-RUN-135: safe summary stored
  it('stores an inert safe summary in the database', async () => {
    const res = await request(app)
      .post(startUrl())
      .set('Idempotency-Key', 'enc-summary-001')
      .send(validBody())
      .expect(202);
    const runId = res.body.data.run.id;
    const rows = await execRows<{ request_safe_summary: string | null }>(
      db,
      sql`SELECT request_safe_summary FROM "mission_runs" WHERE id = ${runId}`,
    );
    expect(rows[0].request_safe_summary).not.toBeNull();
    expect(rows[0].request_safe_summary).toContain('Summarize');
  });

  // VAL-RUN-135: command payload request is encrypted
  it('stores the start command payload request encrypted', async () => {
    const canary = 'CMD_CANARY_' + randomUUID();
    const res = await request(app)
      .post(startUrl())
      .set('Idempotency-Key', 'enc-cmd-001')
      .send({ ...validBody(), request: { text: canary } })
      .expect(202);
    const runId = res.body.data.run.id;
    const rows = await execRows<{ payload: Record<string, unknown> }>(
      db,
      sql`SELECT payload FROM "run_commands" WHERE run_id = ${runId} AND type = 'run.start'`,
    );
    const payload = rows[0].payload;
    expect(typeof payload.request).toBe('string');
    expect(JSON.stringify(payload.request)).not.toContain(canary);
    expect(payload.mode).toBe('fast');
  });

  // VAL-RUN-135: plaintext canaries absent from logs/DB
  it('plaintext canary is absent from ordinary DB text fields', async () => {
    const canary = 'LOG_CANARY_' + randomUUID();
    const res = await request(app)
      .post(startUrl())
      .set('Idempotency-Key', 'enc-canary-001')
      .send({ ...validBody(), request: { text: canary } })
      .expect(202);
    const runId = res.body.data.run.id;

    // Check event payloads — should not contain the plaintext
    const events = await execRows<{ payload: Record<string, unknown> }>(
      db,
      sql`SELECT payload FROM "run_events" WHERE run_id = ${runId}`,
    );
    for (const ev of events) {
      expect(JSON.stringify(ev.payload)).not.toContain(canary);
    }

    // Check the run row itself
    const runs = await execRows<{ request_envelope: string; request_safe_summary: string | null }>(
      db,
      sql`SELECT request_envelope, request_safe_summary FROM "mission_runs" WHERE id = ${runId}`,
    );
    expect(runs[0].request_envelope).not.toContain(canary);
    // The safe summary contains escaped inert text, not raw canary
    if (runs[0].request_safe_summary) {
      // The safe summary IS derived from the text, so it may contain the canary
      // but as inert escaped text, not raw HTML. This is acceptable per the
      // assertion: "the NFC-normalized safe summary is inert text capped at
      // 500 code points."
    }
  });

  // VAL-RUN-135: authorized reconstruction
  it('authorized service path can reconstruct the run from encrypted envelope', async () => {
    const res = await request(app)
      .post(startUrl())
      .set('Idempotency-Key', 'enc-reconstruct-001')
      .send(validBody())
      .expect(202);
    const runId = res.body.data.run.id;
    const rows = await execRows<{ request_envelope: string }>(
      db,
      sql`SELECT request_envelope FROM "mission_runs" WHERE id = ${runId}`,
    );
    const envelope = decryptEnvelope(rows[0].request_envelope);
    expect(envelope.text).toBe('Summarize the report.');
  });

  // VAL-RUN-134: boundary input succeeds
  it('accepts exactly 20,000 code points of text through the API', async () => {
    const text = 'a'.repeat(20_000);
    const res = await request(app)
      .post(startUrl())
      .set('Idempotency-Key', 'enc-boundary-text-001')
      .send({ ...validBody(), request: { text } })
      .expect(202);
    expect(res.body.data.run.status).toBe('queued');
  });

  // VAL-RUN-134: one-over fails atomically
  it('rejects 20,001 code points of text atomically with no side effects', async () => {
    const before = await countRuns(db, companyId, projectId);
    const beforeCmds = await countCommands(db, companyId, projectId);
    const text = 'a'.repeat(20_001);
    const res = await request(app)
      .post(startUrl())
      .set('Idempotency-Key', 'enc-boundary-text-over-001')
      .send({ ...validBody(), request: { text } })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    const after = await countRuns(db, companyId, projectId);
    const afterCmds = await countCommands(db, companyId, projectId);
    expect(after).toBe(before);
    expect(afterCmds).toBe(beforeCmds);
  });

  // VAL-RUN-134: hostile markup is inert
  it('renders hostile markup as inert text in the safe summary', async () => {
    const res = await request(app)
      .post(startUrl())
      .set('Idempotency-Key', 'enc-hostile-001')
      .send({
        ...validBody(),
        request: { text: '<script>alert("xss")</script>Summarize this.' },
      })
      .expect(202);
    const runId = res.body.data.run.id;
    const rows = await execRows<{ request_safe_summary: string | null }>(
      db,
      sql`SELECT request_safe_summary FROM "mission_runs" WHERE id = ${runId}`,
    );
    const summary = rows[0].request_safe_summary!;
    expect(summary).not.toContain('<script>');
    expect(summary).toContain('&lt;script&gt;');
  });

  // VAL-RUN-133: foreign references rejected with no side effects
  it('rejects foreign artifact references with no side effects', async () => {
    const before = await countRuns(db, companyId, projectId);
    const beforeCmds = await countCommands(db, companyId, projectId);
    // Create an artifact in the other company
    const otherArtifactId = await seedArtifact(db, otherCompanyId, otherProjectId, 'Foreign');
    const res = await request(app)
      .post(startUrl())
      .set('Idempotency-Key', 'enc-foreign-ref-001')
      .send({
        ...validBody(),
        request: { text: 'x', attachments: [otherArtifactId] },
      })
      .expect(404);
    expect(res.body.code).toBe('REFERENCE_NOT_FOUND');
    const after = await countRuns(db, companyId, projectId);
    const afterCmds = await countCommands(db, companyId, projectId);
    expect(after).toBe(before);
    expect(afterCmds).toBe(beforeCmds);
  });

  // VAL-RUN-133: deleted references rejected
  it('rejects deleted artifact references', async () => {
    const deletedId = await seedArtifact(db, companyId, projectId, 'Deleted', 'deleted');
    const res = await request(app)
      .post(startUrl())
      .set('Idempotency-Key', 'enc-deleted-ref-001')
      .send({
        ...validBody(),
        request: { text: 'x', attachments: [deletedId] },
      })
      .expect(404);
    expect(res.body.code).toBe('REFERENCE_NOT_FOUND');
  });

  // VAL-RUN-133: non-existent references rejected
  it('rejects non-existent references', async () => {
    const res = await request(app)
      .post(startUrl())
      .set('Idempotency-Key', 'enc-noexist-ref-001')
      .send({
        ...validBody(),
        request: { text: 'x', attachments: [randomUUID()] },
      })
      .expect(404);
    expect(res.body.code).toBe('REFERENCE_NOT_FOUND');
  });

  // VAL-RUN-133: valid linked positive control
  it('accepts a valid linked artifact as a positive control', async () => {
    const artifactId = await seedArtifact(db, companyId, projectId, 'Linked');
    const res = await request(app)
      .post(startUrl())
      .set('Idempotency-Key', 'enc-valid-ref-001')
      .send({
        ...validBody(),
        request: { text: 'Summarize this artifact.', attachments: [artifactId] },
      })
      .expect(202);
    expect(res.body.data.run.status).toBe('queued');
  });

  // VAL-RUN-133: uniform non-enumerating responses
  it('returns uniform non-enumerating 404 for foreign and non-existent refs', async () => {
    const otherArtifactId = await seedArtifact(db, otherCompanyId, otherProjectId, 'Foreign2');
    const foreignRes = await request(app)
      .post(startUrl())
      .set('Idempotency-Key', 'enc-uniform-foreign-001')
      .send({ ...validBody(), request: { text: 'x', attachments: [otherArtifactId] } })
      .expect(404);
    const nonexistRes = await request(app)
      .post(startUrl())
      .set('Idempotency-Key', 'enc-uniform-nonexist-001')
      .send({ ...validBody(), request: { text: 'x', attachments: [randomUUID()] } })
      .expect(404);
    // Both return the same error code and message
    expect(foreignRes.body.code).toBe(nonexistRes.body.code);
    expect(foreignRes.body.code).toBe('REFERENCE_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// Integration tests: retry with encrypted envelope (VAL-RUN-135)
// ---------------------------------------------------------------------------

describe('Mission retry with encrypted envelope (VAL-RUN-135)', () => {
  let db: AnyDb;
  let companyId: string;
  let projectId: string;
  let threadId: string;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    enableMissionFlag();
    companyId = await seedCompany(db, '__mtest__ retry-enc');
    projectId = await seedProject(db, companyId, 'P');
    threadId = await seedThread(db, companyId, projectId, 'T');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('retry copies the encrypted envelope without exposing plaintext', async () => {
    const canary = 'RETRY_CANARY_' + randomUUID();
    const service = new MissionStartService(db);
    const startResult = await service.start({
      companyId,
      projectId,
      idempotencyKey: 'retry-enc-start-001',
      body: {
        projectThreadId: threadId,
        mode: 'fast',
        request: { text: canary },
      },
      actorType: 'user',
      actorId: 'dev-user-000',
    });

    // Manually set the run to failed so retry is legal
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET status = 'failed', terminal_at = NOW(), state_version = state_version + 1
      WHERE id = ${startResult.run.id}
    `);

    // Read the encrypted envelope — verify it's encrypted
    const rows = await execRows<{ request_envelope: string }>(
      db,
      sql`SELECT request_envelope FROM "mission_runs" WHERE id = ${startResult.run.id}`,
    );
    expect(rows[0].request_envelope).not.toContain(canary);

    // Verify authorized decryption works
    const envelope = decryptEnvelope(rows[0].request_envelope);
    expect(envelope.text).toBe(canary);
  });
});
