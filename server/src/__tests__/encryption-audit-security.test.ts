import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq, and } from 'drizzle-orm';
import { createTestServer, createTestDb } from '../test-utils.js';
import { encrypt, decrypt, __resetKeyRegistryForTest } from '../services/crypto.js';
import { isContentEncrypted } from '../services/content-encryption.js';
import type { DbInstance } from '../types.js';

// ---------------------------------------------------------------------------
// Encryption-at-rest + audit logging + rate limiting + RBAC 403 (M8 security)
// ---------------------------------------------------------------------------
//
// Covers:
//   VAL-SEC-004 — artifact content encrypted at rest (ciphertext in DB)
//   VAL-SEC-005 — secrets vault values encrypted at rest
//   VAL-SEC-006 — RBAC denial returns a graceful 403, not 500
//   VAL-SEC-007 — audit log records security-relevant actions
//   VAL-SEC-009 — rate limiting on auth-sensitive endpoints (429)
//   VAL-SEC-010 — encryption key rotation re-encrypts without data loss
// ---------------------------------------------------------------------------

const DOC_CONTENT = { format: 'markdown', body: '# Secret Plan' };
const SHEET_CONTENT = {
  columns: [{ id: 'c1', key: 'name' }],
  rows: [{ id: 'r1', cells: { name: { value: 'Alice' } } }],
};

describe('Encryption-at-rest + audit + rate-limit + RBAC 403 (M8 security)', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;
  let projectId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Encryption Corp' })
      .expect(201);
    companyId = company.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Enc Proj', status: 'active' })
      .expect(201);
    projectId = project.body.data.id;
  });

  // -------------------------------------------------------------------------
  // VAL-SEC-004: artifact content encrypted at rest
  // -------------------------------------------------------------------------

  describe('VAL-SEC-004 — artifact content encrypted at rest', () => {
    it('stored content is a ciphertext envelope (not plaintext) in the DB', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({ type: 'document', title: '__mtest__ Enc Doc', content: DOC_CONTENT, projectId })
        .expect(201);
      const artifactId = res.body.data.id;

      // API returns decrypted, readable content.
      expect(res.body.data.content).toEqual(DOC_CONTENT);

      // Direct DB read shows the encryption envelope (ciphertext), not plaintext.
      const [row] = await db.drizzle
        .select()
        .from(db.schema.artifacts)
        .where(eq(db.schema.artifacts.id, artifactId));
      expect(isContentEncrypted(row.content)).toBe(true);
      expect((row.content as Record<string, unknown>).__encrypted).toBe(true);
      expect((row.content as Record<string, unknown>).data).toEqual(expect.any(String));
      // The cleartext body must NOT appear in the stored content.
      expect(JSON.stringify(row.content)).not.toContain('Secret Plan');
    });

    it('revisions are also encrypted at rest; API returns decrypted revisions', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({ type: 'sheet', title: '__mtest__ Enc Sheet', content: SHEET_CONTENT, projectId })
        .expect(201);
      const artifactId = res.body.data.id;

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${artifactId}/revisions`)
        .expect(200);
      expect(revs.body.data[0].content).toEqual(SHEET_CONTENT);

      // Direct DB read of the revision shows ciphertext.
      const [rev] = await db.drizzle
        .select()
        .from(db.schema.artifactRevisions)
        .where(eq(db.schema.artifactRevisions.artifactId, artifactId));
      expect(isContentEncrypted(rev.content)).toBe(true);
      expect(JSON.stringify(rev.content)).not.toContain('Alice');
    });

    it('GET artifact returns decrypted content to an authorized client', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({ type: 'document', title: '__mtest__ Get Doc', content: DOC_CONTENT, projectId })
        .expect(201);

      const got = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${res.body.data.id}`)
        .expect(200);
      expect(got.body.data.content).toEqual(DOC_CONTENT);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-SEC-005: secrets vault values encrypted at rest
  // -------------------------------------------------------------------------

  describe('VAL-SEC-005 — secrets vault encrypted at rest', () => {
    it('stored secret value is ciphertext; API never returns cleartext', async () => {
      const secretValue = 'super-secret-api-key-12345';
      const res = await request(app)
        .post(`/api/companies/${companyId}/secrets`)
        .send({ name: '__mtest__ vault key', value: secretValue, provider: 'local' })
        .expect(201);

      // Response has no cleartext value field.
      expect(res.body.data).not.toHaveProperty('value');
      expect(JSON.stringify(res.body.data)).not.toContain(secretValue);

      // Direct DB read shows ciphertext.
      const [row] = await db.drizzle
        .select()
        .from(db.schema.secrets)
        .where(eq(db.schema.secrets.id, res.body.data.id));
      expect(row.valueEncrypted).not.toBe(secretValue);
      expect(row.valueEncrypted.split(':').length).toBe(4); // keyId:iv:tag:ct
      // Decrypt round-trips to the cleartext (proves it is real ciphertext).
      expect(decrypt(row.valueEncrypted)).toBe(secretValue);

      // List also never exposes cleartext.
      const list = await request(app)
        .get(`/api/companies/${companyId}/secrets`)
        .expect(200);
      expect(JSON.stringify(list.body.data)).not.toContain(secretValue);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-SEC-006: RBAC denial returns graceful 403, not 500
  // -------------------------------------------------------------------------

  describe('VAL-SEC-006 — RBAC denial returns 403, not 500', () => {
    it('viewer attempting an admin-only route gets a structured 403', async () => {
      // Secrets require admin role. Impersonate a viewer.
      const res = await request(app)
        .get(`/api/companies/${companyId}/secrets`)
        .set('X-Eidolon-Test-Org-Role', 'viewer')
        .expect(403);

      expect(res.body.status).toBe(403);
      expect(res.body.code).toBeTruthy();
      expect(res.body.message).toBeTruthy();
      // No 5xx — the body is a structured error, not a stack trace.
      expect(res.body.code).not.toBe('INTERNAL_SERVER_ERROR');
    });

    it('member attempting an admin-only route gets 403', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/secrets`)
        .set('X-Eidolon-Test-Org-Role', 'member')
        .send({ name: '__mtest__ blocked', value: 'x', provider: 'local' })
        .expect(403);

      expect(res.body.status).toBe(403);
    });

    it('permission-denied (restricted resource, no grant) returns 403', async () => {
      // Create an artifact as owner, restrict it via a permission grant to a
      // different user, then access as a viewer (no grant) → 403.
      const art = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({ type: 'document', title: '__mtest__ restricted', content: DOC_CONTENT, projectId })
        .expect(201);
      const artifactId = art.body.data.id;

      // Grant manage to a specific team (restricts the artifact).
      const team = await request(app)
        .post(`/api/companies/${companyId}/teams`)
        .send({ name: '__mtest__ restr-team' })
        .expect(201);
      await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .send({
          resourceType: 'artifact',
          resourceId: artifactId,
          granteeType: 'team',
          granteeId: team.body.data.id,
          accessLevel: 'manage',
        })
        .expect(201);

      // A viewer with no grant on the restricted artifact → 403 on GET.
      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${artifactId}`)
        .set('X-Eidolon-Test-Org-Role', 'viewer')
        .set('X-Eidolon-Test-User-Id', 'nobody-no-grant')
        .expect(403);

      expect(res.body.status).toBe(403);
      expect(res.body.code).not.toBe('INTERNAL_SERVER_ERROR');
    });
  });

  // -------------------------------------------------------------------------
  // VAL-SEC-007: audit log records security-relevant actions
  // -------------------------------------------------------------------------

  describe('VAL-SEC-007 — audit log records security actions', () => {
    it('permission grant is recorded with actor/action/entity/timestamp', async () => {
      const art = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({ type: 'document', title: '__mtest__ audit doc', content: DOC_CONTENT, projectId })
        .expect(201);
      const artifactId = art.body.data.id;

      const team = await request(app)
        .post(`/api/companies/${companyId}/teams`)
        .send({ name: '__mtest__ audit-team' })
        .expect(201);

      await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .send({
          resourceType: 'artifact',
          resourceId: artifactId,
          granteeType: 'team',
          granteeId: team.body.data.id,
          accessLevel: 'edit',
        })
        .expect(201);

      const entries = await db.drizzle
        .select()
        .from(db.schema.activityLog)
        .where(and(
          eq(db.schema.activityLog.companyId, companyId),
          eq(db.schema.activityLog.action, 'permission.granted'),
        ));
      expect(entries.length).toBeGreaterThanOrEqual(1);
      const entry = entries[0];
      expect(entry.actorType).toBe('user');
      expect(entry.actorId).toBeTruthy();
      expect(entry.action).toBe('permission.granted');
      expect(entry.entityType).toBe('permission');
      expect(entry.entityId).toBe(artifactId);
      expect(entry.createdAt).toBeTruthy();
    });

    it('permission revoke is recorded with the acting user', async () => {
      const art = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({ type: 'document', title: '__mtest__ revoke doc', content: DOC_CONTENT, projectId })
        .expect(201);
      const artifactId = art.body.data.id;

      const team = await request(app)
        .post(`/api/companies/${companyId}/teams`)
        .send({ name: '__mtest__ revoke-team' })
        .expect(201);

      await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .send({
          resourceType: 'artifact', resourceId: artifactId,
          granteeType: 'team', granteeId: team.body.data.id, accessLevel: 'view',
        })
        .expect(201);

      await request(app)
        .delete(`/api/companies/${companyId}/permissions`)
        .send({
          resourceType: 'artifact', resourceId: artifactId,
          granteeType: 'team', granteeId: team.body.data.id, accessLevel: 'view',
        })
        .expect(204);

      const entries = await db.drizzle
        .select()
        .from(db.schema.activityLog)
        .where(and(
          eq(db.schema.activityLog.companyId, companyId),
          eq(db.schema.activityLog.action, 'permission.revoked'),
        ));
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries[0].actorType).toBe('user');
      expect(entries[0].actorId).toBeTruthy();
    });

    it('artifact soft-delete is recorded with the acting user', async () => {
      const art = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({ type: 'document', title: '__mtest__ del doc', content: DOC_CONTENT, projectId })
        .expect(201);
      const artifactId = art.body.data.id;

      await request(app)
        .delete(`/api/companies/${companyId}/artifacts/${artifactId}`)
        .expect(200);

      const entries = await db.drizzle
        .select()
        .from(db.schema.activityLog)
        .where(and(
          eq(db.schema.activityLog.companyId, companyId),
          eq(db.schema.activityLog.action, 'artifact.deleted'),
          eq(db.schema.activityLog.entityId, artifactId),
        ));
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries[0].actorType).toBe('user');
      expect(entries[0].actorId).toBeTruthy();
      expect(entries[0].entityType).toBe('artifact');
    });

    it('MFA enrollment is recorded in the audit log', async () => {
      await request(app)
        .post('/api/auth/mfa/enroll')
        .send({ label: 'Audit MFA', companyId })
        .expect(201);

      const entries = await db.drizzle
        .select()
        .from(db.schema.activityLog)
        .where(and(
          eq(db.schema.activityLog.companyId, companyId),
          eq(db.schema.activityLog.action, 'mfa.enroll'),
        ));
      expect(entries.length).toBe(1);
      expect(entries[0].actorType).toBe('user');
      expect(entries[0].entityType).toBe('user_mfa_factor');
    });

    it('company permanent deletion is recorded with the acting user', async () => {
      // Enroll MFA + step-up so we can perform the hard delete.
      await request(app).post('/api/auth/mfa/enroll').send({ label: 'Co Del', companyId }).expect(201);
      const codeRes = await request(app).post('/api/auth/mfa/generate-valid-code').expect(200);
      const stepUp = await request(app)
        .post('/api/auth/step-up')
        .send({ code: codeRes.body.data.code, scope: 'company_delete', companyId })
        .expect(201);

      await request(app)
        .delete(`/api/companies/${companyId}?hard=true`)
        .set('X-Eidolon-Step-Up-Token', stepUp.body.data.stepUpToken)
        .expect(204);

      // The audit row was inserted before the cascade. Query without company
      // scoping (the company is gone) by action + entityId.
      const entries = await db.drizzle
        .select()
        .from(db.schema.activityLog)
        .where(and(
          eq(db.schema.activityLog.action, 'company.delete_permanent'),
          eq(db.schema.activityLog.entityId, companyId),
        ));
      expect(entries.length).toBe(1);
      expect(entries[0].actorType).toBe('user');
      expect(entries[0].actorId).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // VAL-SEC-009: rate limiting on auth-sensitive endpoints (429)
  // -------------------------------------------------------------------------

  describe('VAL-SEC-009 — rate limiting on auth-sensitive endpoints', () => {
    const savedBypass = process.env.EIDOLON_RATE_LIMIT_TEST_BYPASS;
    const savedMax = process.env.RATE_LIMIT_AUTH_SENSITIVE_MAX;

    afterEach(() => {
      // Restore the test bypass so other tests are not throttled.
      if (savedBypass === undefined) {
        delete process.env.EIDOLON_RATE_LIMIT_TEST_BYPASS;
      } else {
        process.env.EIDOLON_RATE_LIMIT_TEST_BYPASS = savedBypass;
      }
      if (savedMax === undefined) {
        delete process.env.RATE_LIMIT_AUTH_SENSITIVE_MAX;
      } else {
        process.env.RATE_LIMIT_AUTH_SENSITIVE_MAX = savedMax;
      }
    });

    it('MFA verify returns 429 beyond the configured limit', async () => {
      // Disable the test bypass + set a low limit so a short burst triggers 429.
      delete process.env.EIDOLON_RATE_LIMIT_TEST_BYPASS;
      process.env.RATE_LIMIT_AUTH_SENSITIVE_MAX = '3';

      // Enroll so verify has a factor to check against (codes may be invalid;
      // the limiter fires before the handler regardless of code validity).
      await request(app).post('/api/auth/mfa/enroll').send({ label: 'RL' }).expect(201);

      const codes = ['000000', '000001', '000002', '000003', '000004'];
      const statuses: number[] = [];
      for (const code of codes) {
        const res = await request(app).post('/api/auth/mfa/verify').send({ code });
        statuses.push(res.status);
      }
      // The first few are 401 (invalid code) or 200; after the limit, 429.
      expect(statuses).toContain(429);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-SEC-010: encryption key rotation re-encrypts without data loss
  // -------------------------------------------------------------------------

  describe('VAL-SEC-010 — key rotation re-encrypts without data loss', () => {
    afterEach(() => {
      // Reset the key registry back to the default so rotation doesn't leak
      // into other test files in the same worker.
      __resetKeyRegistryForTest();
    });

    it('rotating the key re-encrypts artifacts + secrets; decrypted content is identical', async () => {
      // Seed an artifact + a secret.
      const art = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({ type: 'document', title: '__mtest__ rotate doc', content: DOC_CONTENT, projectId })
        .expect(201);
      const artifactId = art.body.data.id;

      const secretValue = 'rotatable-secret-value';
      const secret = await request(app)
        .post(`/api/companies/${companyId}/secrets`)
        .send({ name: '__mtest__ rotate secret', value: secretValue, provider: 'local' })
        .expect(201);

      // Capture pre-rotation ciphertext from the DB.
      const [artBefore] = await db.drizzle
        .select()
        .from(db.schema.artifacts)
        .where(eq(db.schema.artifacts.id, artifactId));
      const cipherBefore = (artBefore.content as Record<string, unknown>).data as string;
      const keyIdBefore = (artBefore.content as Record<string, unknown>).keyId as string;

      const [secretBefore] = await db.drizzle
        .select()
        .from(db.schema.secrets)
        .where(eq(db.schema.secrets.id, secret.body.data.id));
      const secretCipherBefore = secretBefore.valueEncrypted;

      // Rotate + re-encrypt.
      const rotate = await request(app)
        .post('/api/admin/encryption/rotate')
        .expect(200);
      expect(rotate.body.data.newKeyId).not.toBe(keyIdBefore);
      expect(rotate.body.data.artifactsRotated).toBeGreaterThanOrEqual(1);
      expect(rotate.body.data.secretsRotated).toBeGreaterThanOrEqual(1);

      // Post-rotation DB ciphertext differs (re-encrypted under the new key).
      const [artAfter] = await db.drizzle
        .select()
        .from(db.schema.artifacts)
        .where(eq(db.schema.artifacts.id, artifactId));
      const cipherAfter = (artAfter.content as Record<string, unknown>).data as string;
      const keyIdAfter = (artAfter.content as Record<string, unknown>).keyId as string;
      expect(keyIdAfter).toBe(rotate.body.data.newKeyId);
      expect(cipherAfter).not.toBe(cipherBefore);

      const [secretAfter] = await db.drizzle
        .select()
        .from(db.schema.secrets)
        .where(eq(db.schema.secrets.id, secret.body.data.id));
      expect(secretAfter.valueEncrypted).not.toBe(secretCipherBefore);

      // The API still returns identical decrypted content (no data loss).
      const got = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${artifactId}`)
        .expect(200);
      expect(got.body.data.content).toEqual(DOC_CONTENT);

      // The secret value still decrypts to the original cleartext.
      expect(decrypt(secretAfter.valueEncrypted)).toBe(secretValue);
    });

    it('legacy 3-part ciphertext (pre-keyId) still decrypts after rotation', async () => {
      // Simulate a legacy 3-part ciphertext (pre-refactor) using the original
      // dev key directly via the crypto module, store it, then rotate and
      // confirm it can still be read.
      const legacy = encrypt('legacy-value');
      // Force a 3-part legacy shape by stripping the keyId prefix.
      const parts = legacy.split(':');
      const legacy3 = parts.slice(1).join(':'); // iv:tag:ct
      // Decrypt the legacy 3-part value directly.
      expect(decrypt(legacy3)).toBe('legacy-value');

      // Rotate and confirm the legacy value still decrypts (old key retained).
      const rotate = await request(app)
        .post('/api/admin/encryption/rotate')
        .expect(200);
      void rotate;
      expect(decrypt(legacy3)).toBe('legacy-value');
    });
  });
});
