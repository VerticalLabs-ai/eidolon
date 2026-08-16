import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { createTestDb, createTestServer } from '../test-utils.js';
import { hashAgentKey, AGENT_KEY_PREFIX } from '../middleware/agent-key-auth.js';
import type { DbInstance } from '../types.js';

/**
 * RBAC Agent API Key CRUD Tests
 *
 * Comprehensive tests for the agent API key management endpoints.
 * Covers VAL-KEY-001 through VAL-KEY-017, VAL-KEY-021, VAL-KEY-028,
 * VAL-CROSS-007, and VAL-CROSS-008.
 *
 * Endpoints:
 *   POST   /api/companies/:companyId/agent-api-keys
 *   GET    /api/companies/:companyId/agent-api-keys
 *   DELETE /api/companies/:companyId/agent-api-keys/:keyId
 */
describe('RBAC Agent API Key CRUD', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    // Create a company — auto-creates owner membership for dev-user-000
    const res = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ API Keys Test', settings: { testFixture: true } })
      .expect(201);
    companyId = res.body.data.id;
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function roleHeader(role: string): Record<string, string> {
    return { 'X-Eidolon-Test-Org-Role': role };
  }

  function userHeader(userId: string): Record<string, string> {
    return { 'X-Eidolon-Test-User-Id': userId };
  }

  function bearerHeader(rawKey: string): Record<string, string> {
    return { Authorization: `Bearer ${rawKey}` };
  }

  function url(path: string): string {
    return `/api/companies/${companyId}${path}`;
  }

  async function seedMember(userId: string, role: 'owner' | 'admin' | 'member' | 'viewer') {
    await db.drizzle
      .insert(db.schema.companyMembers)
      .values({ companyId, userId, role })
      .onConflictDoNothing();
  }

  async function seedOtherCompany(
    coId: string,
    userId: string,
    role: 'owner' | 'admin' | 'member' | 'viewer',
  ) {
    await db.drizzle
      .insert(db.schema.companies)
      .values({ id: coId, name: `__mtest__ ${coId}`, settings: { testFixture: true } })
      .onConflictDoNothing();
    await db.drizzle
      .insert(db.schema.companyMembers)
      .values({ companyId: coId, userId, role })
      .onConflictDoNothing();
  }

  async function seedAgent(agentId: string): Promise<void> {
    await db.drizzle
      .insert(db.schema.agents)
      .values({
        id: agentId,
        companyId,
        name: 'Test Agent',
        role: 'engineer',
      })
      .onConflictDoNothing();
  }

  async function getKeyRow(keyId: string) {
    const rows = await db.drizzle
      .select()
      .from(db.schema.agentApiKeys)
      .where(eq(db.schema.agentApiKeys.id, keyId))
      .limit(1);
    return rows[0] ?? null;
  }

  async function countKeys(): Promise<number> {
    const rows = await db.drizzle
      .select()
      .from(db.schema.agentApiKeys)
      .where(eq(db.schema.agentApiKeys.companyId, companyId));
    return rows.length;
  }

  /** Create a key via the API and return the response body. */
  async function createKey(
    opts: { name?: string; role?: string; agentId?: string; roleHeaderVal?: string } = {},
  ) {
    const body: Record<string, unknown> = { name: opts.name ?? 'Test Key' };
    if (opts.role) {
      body.role = opts.role;
    }
    if (opts.agentId) {
      body.agentId = opts.agentId;
    }
    const res = await request(app)
      .post(url('/agent-api-keys'))
      .set(roleHeader(opts.roleHeaderVal ?? 'owner'))
      .send(body)
      .expect(201);
    return res.body.data;
  }

  // =========================================================================
  // VAL-KEY-001: Owner can create an agent API key
  // =========================================================================

  describe('VAL-KEY-001: owner creates agent API key', () => {
    it('owner POST returns 201 with raw key + metadata; DB row exists', async () => {
      const res = await request(app)
        .post(url('/agent-api-keys'))
        .set(roleHeader('owner'))
        .send({ name: 'My Test Key' })
        .expect(201);

      expect(res.body.data.rawKey).toBeDefined();
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.name).toBe('My Test Key');
      expect(res.body.data.keyPrefix).toBeDefined();

      // DB row exists
      const row = await getKeyRow(res.body.data.id);
      expect(row).not.toBeNull();
      expect(row?.name).toBe('My Test Key');
    });
  });

  // =========================================================================
  // VAL-KEY-002: Admin can create an agent API key
  // =========================================================================

  describe('VAL-KEY-002: admin creates agent API key', () => {
    it('admin POST returns 201; createdByUserId is admin', async () => {
      // Seed an admin member
      await seedMember('admin-user-002', 'admin');

      const res = await request(app)
        .post(url('/agent-api-keys'))
        .set(userHeader('admin-user-002'))
        .send({ name: 'Admin Key' })
        .expect(201);

      expect(res.body.data.rawKey).toBeDefined();

      const row = await getKeyRow(res.body.data.id);
      expect(row).not.toBeNull();
      expect(row?.createdByUserId).toBe('admin-user-002');
    });
  });

  // =========================================================================
  // VAL-KEY-003: Member cannot create an agent API key
  // =========================================================================

  describe('VAL-KEY-003: member cannot create agent API key', () => {
    it('member gets 403 on POST; no key created', async () => {
      await seedMember('member-user-003', 'member');
      const countBefore = await countKeys();

      const res = await request(app)
        .post(url('/agent-api-keys'))
        .set(userHeader('member-user-003'))
        .send({ name: 'Member Key' })
        .expect(403);

      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      const countAfter = await countKeys();
      expect(countAfter).toBe(countBefore);
    });
  });

  // =========================================================================
  // VAL-KEY-004: Viewer cannot create an agent API key
  // =========================================================================

  describe('VAL-KEY-004: viewer cannot create agent API key', () => {
    it('viewer gets 403 on POST; no key created', async () => {
      await seedMember('viewer-user-004', 'viewer');
      const countBefore = await countKeys();

      const res = await request(app)
        .post(url('/agent-api-keys'))
        .set(userHeader('viewer-user-004'))
        .send({ name: 'Viewer Key' })
        .expect(403);

      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      const countAfter = await countKeys();
      expect(countAfter).toBe(countBefore);
    });
  });

  // =========================================================================
  // VAL-KEY-005: Creation returns the raw key and metadata once
  // =========================================================================

  describe('VAL-KEY-005: create returns raw key once; GET does not reveal it', () => {
    it('create body has rawKey + metadata; GET omits raw key', async () => {
      const res = await request(app)
        .post(url('/agent-api-keys'))
        .set(roleHeader('owner'))
        .send({ name: 'Raw Key Test' })
        .expect(201);

      const data = res.body.data;
      // Create response includes raw key + metadata
      expect(data.rawKey).toBeDefined();
      expect(typeof data.rawKey).toBe('string');
      expect(data.id).toBeDefined();
      expect(data.name).toBe('Raw Key Test');
      expect(data.role).toBeDefined();
      expect(data.keyPrefix).toBeDefined();

      // GET the collection — raw key must be absent
      const listRes = await request(app)
        .get(url('/agent-api-keys'))
        .set(roleHeader('owner'))
        .expect(200);

      const rawKey = data.rawKey;
      // The raw key must not appear anywhere in the list response
      const listJson = JSON.stringify(listRes.body);
      expect(listJson).not.toContain(rawKey);

      // The key's metadata should be present
      const listed = listRes.body.data.find((k: any) => k.id === data.id);
      expect(listed).toBeDefined();
      expect(listed.rawKey).toBeUndefined();
    });
  });

  // =========================================================================
  // VAL-KEY-006: Raw key uses the live format
  // =========================================================================

  describe('VAL-KEY-006: raw key uses eid_live_ format', () => {
    it('two keys start with eid_live_ and differ', async () => {
      const key1 = await createKey({ name: 'Key A' });
      const key2 = await createKey({ name: 'Key B' });

      expect(key1.rawKey).toMatch(/^eid_live_[A-Za-z0-9_-]+$/);
      expect(key2.rawKey).toMatch(/^eid_live_[A-Za-z0-9_-]+$/);
      expect(key1.rawKey).not.toBe(key2.rawKey);
    });
  });

  // =========================================================================
  // VAL-KEY-007: Role defaults to member
  // =========================================================================

  describe('VAL-KEY-007: role defaults to member', () => {
    it('POST without role → role=member in response and DB', async () => {
      const res = await request(app)
        .post(url('/agent-api-keys'))
        .set(roleHeader('owner'))
        .send({ name: 'Default Role Key' })
        .expect(201);

      expect(res.body.data.role).toBe('member');

      const row = await getKeyRow(res.body.data.id);
      expect(row?.role).toBe('member');
    });
  });

  // =========================================================================
  // VAL-KEY-008: Role is configurable
  // =========================================================================

  describe('VAL-KEY-008: role is configurable (viewer, member, admin)', () => {
    it('can create with viewer role', async () => {
      const res = await request(app)
        .post(url('/agent-api-keys'))
        .set(roleHeader('owner'))
        .send({ name: 'Viewer Key', role: 'viewer' })
        .expect(201);
      expect(res.body.data.role).toBe('viewer');
      const row = await getKeyRow(res.body.data.id);
      expect(row?.role).toBe('viewer');
    });

    it('can create with member role', async () => {
      const res = await request(app)
        .post(url('/agent-api-keys'))
        .set(roleHeader('owner'))
        .send({ name: 'Member Key', role: 'member' })
        .expect(201);
      expect(res.body.data.role).toBe('member');
    });

    it('can create with admin role', async () => {
      const res = await request(app)
        .post(url('/agent-api-keys'))
        .set(roleHeader('owner'))
        .send({ name: 'Admin Key', role: 'admin' })
        .expect(201);
      expect(res.body.data.role).toBe('admin');
      const row = await getKeyRow(res.body.data.id);
      expect(row?.role).toBe('admin');
    });

    it('owner role is rejected with 4xx', async () => {
      const res = await request(app)
        .post(url('/agent-api-keys'))
        .set(roleHeader('owner'))
        .send({ name: 'Owner Key', role: 'owner' })
        .expect(400);

      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('invalid role value is rejected with 4xx', async () => {
      const res = await request(app)
        .post(url('/agent-api-keys'))
        .set(roleHeader('owner'))
        .send({ name: 'Bad Key', role: 'superuser' })
        .expect(400);

      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  // =========================================================================
  // VAL-KEY-009: Optional agentId binding works
  // =========================================================================

  describe('VAL-KEY-009: optional agentId binding', () => {
    it('creating with agentId binds the key to that agent', async () => {
      const agentId = 'agent-bind-009';
      await seedAgent(agentId);

      const res = await request(app)
        .post(url('/agent-api-keys'))
        .set(roleHeader('owner'))
        .send({ name: 'Bound Key', agentId })
        .expect(201);

      expect(res.body.data.agentId).toBe(agentId);

      const row = await getKeyRow(res.body.data.id);
      expect(row?.agentId).toBe(agentId);
    });

    it('creating without agentId creates an unbound key', async () => {
      const res = await request(app)
        .post(url('/agent-api-keys'))
        .set(roleHeader('owner'))
        .send({ name: 'Unbound Key' })
        .expect(201);

      expect(res.body.data.agentId).toBeNull();

      const row = await getKeyRow(res.body.data.id);
      expect(row?.agentId).toBeNull();
    });
  });

  // =========================================================================
  // VAL-KEY-010: Key hash is SHA-256 and never raw key
  // =========================================================================

  describe('VAL-KEY-010: keyHash is SHA-256 of raw key', () => {
    it('persisted keyHash equals SHA-256(rawKey), not raw key', async () => {
      const data = await createKey({ name: 'Hash Test' });
      const rawKey = data.rawKey;

      // Compute SHA-256 independently
      const expectedHash = createHash('sha256').update(rawKey, 'utf8').digest('hex');

      const row = await getKeyRow(data.id);
      expect(row?.keyHash).toBe(expectedHash);
      expect(row?.keyHash).not.toBe(rawKey);

      // No persisted field contains the complete raw key
      const rowJson = JSON.stringify(row);
      expect(rowJson).not.toContain(rawKey);
    });
  });

  // =========================================================================
  // VAL-KEY-011: Key prefix is stored for display
  // =========================================================================

  describe('VAL-KEY-011: keyPrefix is stored for display', () => {
    it('keyPrefix is first 10 chars, shorter than raw key, not complete key', async () => {
      const data = await createKey({ name: 'Prefix Test' });
      const rawKey = data.rawKey;

      const row = await getKeyRow(data.id);
      expect(row?.keyPrefix).toBe(rawKey.slice(0, 10));
      expect(row!.keyPrefix.length).toBeLessThan(rawKey.length);
      expect(row?.keyPrefix).not.toBe(rawKey);
    });
  });

  // =========================================================================
  // VAL-KEY-012: Listing returns metadata only
  // =========================================================================

  describe('VAL-KEY-012: listing returns metadata only (no raw keys)', () => {
    it('GET response has no rawKey or keyHash fields; raw key absent from body', async () => {
      const data = await createKey({ name: 'List Test' });

      const res = await request(app)
        .get(url('/agent-api-keys'))
        .set(roleHeader('owner'))
        .expect(200);

      expect(Array.isArray(res.body.data)).toBe(true);
      const listed = res.body.data.find((k: any) => k.id === data.id);
      expect(listed).toBeDefined();
      expect(listed.rawKey).toBeUndefined();
      expect(listed.keyHash).toBeUndefined();

      // Raw key must not appear anywhere in the response
      const json = JSON.stringify(res.body);
      expect(json).not.toContain(data.rawKey);
    });
  });

  // =========================================================================
  // VAL-KEY-013: Listing includes required metadata
  // =========================================================================

  describe('VAL-KEY-013: listing includes required metadata fields', () => {
    it('each item has name, keyPrefix, role, lastUsedAt, createdAt, revokedAt', async () => {
      await createKey({ name: 'Metadata Key' });

      const res = await request(app)
        .get(url('/agent-api-keys'))
        .set(roleHeader('owner'))
        .expect(200);

      const keys = res.body.data;
      expect(keys.length).toBeGreaterThanOrEqual(1);

      for (const key of keys) {
        expect(key.name).toBeDefined();
        expect(key.keyPrefix).toBeDefined();
        expect(key.role).toBeDefined();
        expect(key.lastUsedAt).toBeDefined(); // can be null
        expect(key.createdAt).toBeDefined();
        expect(key.revokedAt).toBeDefined(); // can be null
      }
    });
  });

  // =========================================================================
  // VAL-KEY-014: Revoked keys are represented safely
  // =========================================================================

  describe('VAL-KEY-014: revoked keys are represented safely in list', () => {
    it('revoked key appears in list with revokedAt set', async () => {
      const data = await createKey({ name: 'Revoke List Test' });

      // Revoke the key
      await request(app)
        .delete(url(`/agent-api-keys/${data.id}`))
        .set(roleHeader('owner'))
        .expect(200);

      // List and verify the revoked key
      const res = await request(app)
        .get(url('/agent-api-keys'))
        .set(roleHeader('owner'))
        .expect(200);

      const listed = res.body.data.find((k: any) => k.id === data.id);
      expect(listed).toBeDefined();
      expect(listed.revokedAt).not.toBeNull();
    });
  });

  // =========================================================================
  // VAL-KEY-015: Owner and admin can revoke
  // =========================================================================

  describe('VAL-KEY-015: owner and admin can revoke', () => {
    it('owner can DELETE a key (revokedAt set in DB)', async () => {
      const data = await createKey({ name: 'Owner Revoke Test' });

      const res = await request(app)
        .delete(url(`/agent-api-keys/${data.id}`))
        .set(roleHeader('owner'))
        .expect(200);

      expect(res.body.data.id).toBe(data.id);
      expect(res.body.data.revokedAt).toBeDefined();

      const row = await getKeyRow(data.id);
      expect(row?.revokedAt).not.toBeNull();
    });

    it('admin can DELETE a key (revokedAt set in DB)', async () => {
      await seedMember('admin-user-015', 'admin');
      const data = await createKey({ name: 'Admin Revoke Test' });

      const res = await request(app)
        .delete(url(`/agent-api-keys/${data.id}`))
        .set(userHeader('admin-user-015'))
        .expect(200);

      expect(res.body.data.revokedAt).toBeDefined();

      const row = await getKeyRow(data.id);
      expect(row?.revokedAt).not.toBeNull();
    });

    it('revoking an already-revoked key is idempotent (200)', async () => {
      const data = await createKey({ name: 'Idempotent Revoke' });

      // First revoke
      await request(app)
        .delete(url(`/agent-api-keys/${data.id}`))
        .set(roleHeader('owner'))
        .expect(200);

      // Second revoke — should succeed (idempotent)
      const res = await request(app)
        .delete(url(`/agent-api-keys/${data.id}`))
        .set(roleHeader('owner'))
        .expect(200);

      expect(res.body.data.id).toBe(data.id);
      expect(res.body.data.revokedAt).toBeDefined();
    });
  });

  // =========================================================================
  // VAL-KEY-016: Revocation immediately invalidates authentication
  // =========================================================================

  describe('VAL-KEY-016: revoked key immediately fails authentication', () => {
    it('key works before revocation, fails after', async () => {
      const data = await createKey({ name: 'Auth Revoke Test', role: 'member' });
      const rawKey = data.rawKey;

      // Key works before revocation — use it to access a company endpoint
      const beforeRes = await request(app)
        .get(url('/agents'))
        .set(bearerHeader(rawKey))
        .expect(200);
      expect(beforeRes.status).toBe(200);

      // Revoke the key
      await request(app)
        .delete(url(`/agent-api-keys/${data.id}`))
        .set(roleHeader('owner'))
        .expect(200);

      // Key fails after revocation
      const afterRes = await request(app).get(url('/agents')).set(bearerHeader(rawKey)).expect(401);
      expect(afterRes.body.code).toBe('UNAUTHORIZED');
    });
  });

  // =========================================================================
  // VAL-KEY-017: Member and viewer cannot revoke
  // =========================================================================

  describe('VAL-KEY-017: member and viewer cannot revoke', () => {
    it('member gets 403 on DELETE; revokedAt remains null', async () => {
      await seedMember('member-user-017', 'member');
      const data = await createKey({ name: 'Member Revoke Deny' });

      const res = await request(app)
        .delete(url(`/agent-api-keys/${data.id}`))
        .set(userHeader('member-user-017'))
        .expect(403);

      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      const row = await getKeyRow(data.id);
      expect(row?.revokedAt).toBeNull();
    });

    it('viewer gets 403 on DELETE; revokedAt remains null', async () => {
      await seedMember('viewer-user-017', 'viewer');
      const data = await createKey({ name: 'Viewer Revoke Deny' });

      const res = await request(app)
        .delete(url(`/agent-api-keys/${data.id}`))
        .set(userHeader('viewer-user-017'))
        .expect(403);

      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      const row = await getKeyRow(data.id);
      expect(row?.revokedAt).toBeNull();
    });
  });

  // =========================================================================
  // VAL-KEY-028: Non-members cannot operate on API keys
  // =========================================================================

  describe('VAL-KEY-028: non-members get 403 on all operations', () => {
    it('non-member gets 403 on POST', async () => {
      await seedOtherCompany('co-other-028', 'cross-user-028', 'owner');
      const countBefore = await countKeys();

      const res = await request(app)
        .post(url('/agent-api-keys'))
        .set(userHeader('cross-user-028'))
        .send({ name: 'Non-Member Key' })
        .expect(403);

      expect(res.body).not.toHaveProperty('data');

      const countAfter = await countKeys();
      expect(countAfter).toBe(countBefore);
    });

    it('non-member gets 403 on GET', async () => {
      await createKey({ name: 'Existing Key' });
      await seedOtherCompany('co-other-028b', 'cross-user-028b', 'owner');

      const res = await request(app)
        .get(url('/agent-api-keys'))
        .set(userHeader('cross-user-028b'))
        .expect(403);

      expect(res.body).not.toHaveProperty('data');
    });

    it('non-member gets 403 on DELETE', async () => {
      const data = await createKey({ name: 'Delete Target' });
      await seedOtherCompany('co-other-028c', 'cross-user-028c', 'owner');

      const res = await request(app)
        .delete(url(`/agent-api-keys/${data.id}`))
        .set(userHeader('cross-user-028c'))
        .expect(403);

      expect(res.body).not.toHaveProperty('data');

      const row = await getKeyRow(data.id);
      expect(row?.revokedAt).toBeNull();
    });
  });

  // =========================================================================
  // VAL-KEY-021: Admin key reaches admin endpoints
  // =========================================================================

  describe('VAL-KEY-021: admin key can access admin endpoints including API key CRUD', () => {
    it('admin key can GET the API keys list via bearer auth', async () => {
      const data = await createKey({ name: 'Admin Bearer Key', role: 'admin' });
      const rawKey = data.rawKey;

      // Use the admin key to list API keys — should succeed
      const res = await request(app)
        .get(url('/agent-api-keys'))
        .set(bearerHeader(rawKey))
        .expect(200);

      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('admin key can POST a new API key via bearer auth', async () => {
      const data = await createKey({ name: 'Admin Bearer Key 2', role: 'admin' });
      const rawKey = data.rawKey;

      const res = await request(app)
        .post(url('/agent-api-keys'))
        .set(bearerHeader(rawKey))
        .send({ name: 'Key Created By Admin Key' })
        .expect(201);

      expect(res.body.data.rawKey).toBeDefined();
      expect(res.body.data.name).toBe('Key Created By Admin Key');
    });
  });

  // =========================================================================
  // VAL-CROSS-007: Agent key inherits member permissions
  // =========================================================================

  describe('VAL-CROSS-007: member agent key inherits member permissions', () => {
    it('member key can access member-level endpoints via bearer auth', async () => {
      const data = await createKey({ name: 'Member Bearer Key', role: 'member' });
      const rawKey = data.rawKey;

      // Member-level endpoint: GET /agents → 200
      const res = await request(app).get(url('/agents')).set(bearerHeader(rawKey)).expect(200);

      expect(res.status).toBe(200);
    });
  });

  // =========================================================================
  // VAL-CROSS-008: Agent key cannot escalate and revocation is immediate
  // =========================================================================

  describe('VAL-CROSS-008: member key cannot escalate; revocation is immediate', () => {
    it('member key gets 403 on admin-only endpoint', async () => {
      const data = await createKey({ name: 'Member Escalation Test', role: 'member' });
      const rawKey = data.rawKey;

      // Admin-only endpoint: GET /integrations → 403
      const res = await request(app)
        .get(url('/integrations'))
        .set(bearerHeader(rawKey))
        .expect(403);

      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('after revocation, member key fails; other credentials remain valid', async () => {
      const memberData = await createKey({ name: 'Member Revocation Test', role: 'member' });
      const memberRawKey = memberData.rawKey;

      // Create a second key (admin role) that should remain valid
      const adminData = await createKey({ name: 'Admin Control Key', role: 'admin' });
      const adminRawKey = adminData.rawKey;

      // Revoke the member key
      await request(app)
        .delete(url(`/agent-api-keys/${memberData.id}`))
        .set(roleHeader('owner'))
        .expect(200);

      // Member key now fails
      const memberRes = await request(app)
        .get(url('/agents'))
        .set(bearerHeader(memberRawKey))
        .expect(401);
      expect(memberRes.body.code).toBe('UNAUTHORIZED');

      // Admin control key still works
      const adminRes = await request(app)
        .get(url('/agent-api-keys'))
        .set(bearerHeader(adminRawKey))
        .expect(200);
      expect(adminRes.status).toBe(200);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('revoking a non-existent key returns 404', async () => {
      const res = await request(app)
        .delete(url('/agent-api-keys/nonexistent-id'))
        .set(roleHeader('owner'))
        .expect(404);

      expect(res.body.code).toBe('API_KEY_NOT_FOUND');
    });

    it('revoking a key from another company returns 404', async () => {
      // Create a key in another company
      const companyB = 'co-edge-apikey';
      await seedOtherCompany(companyB, 'b-owner-edge', 'owner');

      const [keyB] = await db.drizzle
        .insert(db.schema.agentApiKeys)
        .values({
          companyId: companyB,
          name: 'Cross-company key',
          keyHash: hashAgentKey(`${AGENT_KEY_PREFIX}cross_company_edge`),
          keyPrefix: `${AGENT_KEY_PREFIX}c`,
          role: 'member',
          createdByUserId: 'b-owner-edge',
        })
        .returning();

      // Owner of company A tries to revoke company B's key
      const res = await request(app)
        .delete(url(`/agent-api-keys/${keyB.id}`))
        .set(roleHeader('owner'))
        .expect(404);

      expect(res.body.code).toBe('API_KEY_NOT_FOUND');

      // Key in company B is unchanged
      const row = await getKeyRow(keyB.id);
      expect(row?.revokedAt).toBeNull();
    });

    it('empty name is rejected with 400', async () => {
      const res = await request(app)
        .post(url('/agent-api-keys'))
        .set(roleHeader('owner'))
        .send({ name: '' })
        .expect(400);

      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('missing name is rejected with 400', async () => {
      const res = await request(app)
        .post(url('/agent-api-keys'))
        .set(roleHeader('owner'))
        .send({})
        .expect(400);

      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('viewer key can access read endpoints but not writes', async () => {
      const data = await createKey({ name: 'Viewer Bearer Key', role: 'viewer' });
      const rawKey = data.rawKey;

      // Viewer can read
      const readRes = await request(app).get(url('/agents')).set(bearerHeader(rawKey)).expect(200);
      expect(readRes.status).toBe(200);

      // Viewer cannot create (POST /artifacts → 403)
      const writeRes = await request(app)
        .post(url('/artifacts'))
        .set(bearerHeader(rawKey))
        .send({ title: 'Test', type: 'note' })
        .expect(403);
      expect(writeRes.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('paginates keys in descending deterministic order and follows cursors', async () => {
      const createdAt = [
        new Date('2025-01-01T00:00:00.000Z'),
        new Date('2025-01-02T00:00:00.000Z'),
        new Date('2025-01-03T00:00:00.000Z'),
      ];
      await db.drizzle.insert(db.schema.agentApiKeys).values(
        createdAt.map((date, index) => ({
          companyId,
          name: `Page ${index}`,
          keyHash: hashAgentKey(`${AGENT_KEY_PREFIX}page_${index}`),
          keyPrefix: `${AGENT_KEY_PREFIX}p${index}`,
          role: 'member' as const,
          createdByUserId: 'dev-user-000',
          createdAt: date,
          updatedAt: date,
        })),
      );

      const first = await request(app)
        .get(url('/agent-api-keys?limit=2'))
        .set(roleHeader('owner'))
        .expect(200);
      expect(first.body.data.map((key: { name: string }) => key.name)).toEqual([
        'Page 2',
        'Page 1',
      ]);
      expect(first.body.hasMore).toBe(true);
      expect(first.body.nextCursor).toEqual(expect.any(String));

      const second = await request(app)
        .get(url(`/agent-api-keys?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`))
        .set(roleHeader('owner'))
        .expect(200);
      expect(second.body.data.map((key: { name: string }) => key.name)).toEqual(['Page 0']);
      expect(second.body.hasMore).toBe(false);
      expect(second.body.nextCursor).toBeNull();
    });

    it('filters keys by name or key prefix and rejects invalid pagination values', async () => {
      await db.drizzle.insert(db.schema.agentApiKeys).values({
        companyId,
        name: 'Production Key',
        keyHash: hashAgentKey(`${AGENT_KEY_PREFIX}search_name`),
        keyPrefix: `${AGENT_KEY_PREFIX}one`,
        role: 'member',
        createdByUserId: 'dev-user-000',
      });
      await db.drizzle.insert(db.schema.agentApiKeys).values({
        companyId,
        name: 'Other Key',
        keyHash: hashAgentKey(`${AGENT_KEY_PREFIX}search_prefix`),
        keyPrefix: `${AGENT_KEY_PREFIX}EID`,
        role: 'member',
        createdByUserId: 'dev-user-000',
      });

      const search = await request(app)
        .get(url('/agent-api-keys?search=prod'))
        .set(roleHeader('owner'))
        .expect(200);
      expect(search.body.data).toHaveLength(1);
      expect(search.body.data[0].name).toBe('Production Key');

      const prefixSearch = await request(app)
        .get(url('/agent-api-keys?search=eid'))
        .set(roleHeader('owner'))
        .expect(200);
      expect(prefixSearch.body.data.map((key: { name: string }) => key.name)).toContain(
        'Other Key',
      );
      expect(
        prefixSearch.body.data.every((key: { keyPrefix: string }) =>
          key.keyPrefix.toLowerCase().includes('eid'),
        ),
      ).toBe(true);

      await request(app).get(url('/agent-api-keys?limit=0')).set(roleHeader('owner')).expect(400);
      await request(app).get(url('/agent-api-keys?limit=-1')).set(roleHeader('owner')).expect(400);
      await request(app)
        .get(url('/agent-api-keys?cursor=not-valid'))
        .set(roleHeader('owner'))
        .expect(400);
    });

    it('rejects cursors containing invalid Base64 characters', async () => {
      const validCursor = Buffer.from(
        JSON.stringify({ createdAt: '2025-01-01T00:00:00.000Z', id: 'cursor-key' }),
        'utf8',
      ).toString('base64');

      for (const cursor of ['!!!', `${validCursor}!!!`]) {
        const res = await request(app)
          .get(url(`/agent-api-keys?cursor=${encodeURIComponent(cursor)}`))
          .set(roleHeader('owner'))
          .expect(400);
        expect(res.body.code).toBe('INVALID_CURSOR');
      }
    });

    it('rejects valid Base64 cursors with invalid JSON or missing fields', async () => {
      const invalidJson = Buffer.from('not JSON', 'utf8').toString('base64');
      const missingFields = Buffer.from(JSON.stringify({ id: 'cursor-key' }), 'utf8').toString(
        'base64',
      );

      for (const cursor of [invalidJson, missingFields]) {
        const res = await request(app)
          .get(url(`/agent-api-keys?cursor=${encodeURIComponent(cursor)}`))
          .set(roleHeader('owner'))
          .expect(400);
        expect(res.body.code).toBe('INVALID_CURSOR');
      }
    });

    it('accepts a valid Base64 JSON cursor', async () => {
      const [key] = await db.drizzle
        .insert(db.schema.agentApiKeys)
        .values({
          companyId,
          name: 'Cursor Target',
          keyHash: hashAgentKey(`${AGENT_KEY_PREFIX}cursor_target`),
          keyPrefix: `${AGENT_KEY_PREFIX}cursor`,
          role: 'member',
          createdByUserId: 'dev-user-000',
          createdAt: new Date('2025-01-02T00:00:00.000Z'),
          updatedAt: new Date('2025-01-02T00:00:00.000Z'),
        })
        .returning();
      const cursor = Buffer.from(
        JSON.stringify({ createdAt: key.createdAt.toISOString(), id: key.id }),
        'utf8',
      ).toString('base64');

      const res = await request(app)
        .get(url(`/agent-api-keys?limit=1&cursor=${encodeURIComponent(cursor)}`))
        .set(roleHeader('owner'))
        .expect(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.hasMore).toBe(false);
      expect(res.body.nextCursor).toBeNull();
    });
  });
});
