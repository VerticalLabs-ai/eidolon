import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { createTestDb, createTestServer } from '../test-utils.js';
import type { DbInstance } from '../types.js';

/**
 * Ownership Transfer Endpoint Tests
 *
 * POST /api/companies/:companyId/transfer-ownership
 *
 * Covers VAL-OWNER-001 through VAL-OWNER-011, VAL-AUDIT-005/006/008,
 * VAL-CROSS-001/002.
 */
describe('Ownership Transfer', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    // Create a company — auto-creates owner membership for dev-user-000
    const res = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Transfer Test', settings: { testFixture: true } })
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

  function url(path: string): string {
    return `/api/companies/${companyId}${path}`;
  }

  async function seedMember(userId: string, role: 'owner' | 'admin' | 'member' | 'viewer') {
    await db.drizzle
      .insert(db.schema.companyMembers)
      .values({ companyId, userId, role })
      .onConflictDoNothing();
  }

  async function getMembership(userId: string) {
    const rows = await db.drizzle
      .select()
      .from(db.schema.companyMembers)
      .where(
        and(
          eq(db.schema.companyMembers.companyId, companyId),
          eq(db.schema.companyMembers.userId, userId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async function getMembershipById(memberId: string) {
    const rows = await db.drizzle
      .select()
      .from(db.schema.companyMembers)
      .where(eq(db.schema.companyMembers.id, memberId))
      .limit(1);
    return rows[0] ?? null;
  }

  async function countOwners(): Promise<number> {
    const rows = await db.drizzle
      .select()
      .from(db.schema.companyMembers)
      .where(
        and(
          eq(db.schema.companyMembers.companyId, companyId),
          eq(db.schema.companyMembers.role, 'owner'),
        ),
      );
    return rows.length;
  }

  async function getAuditEntries(action: string) {
    return db.drizzle
      .select()
      .from(db.schema.activityLog)
      .where(
        and(
          eq(db.schema.activityLog.companyId, companyId),
          eq(db.schema.activityLog.action, action),
        ),
      );
  }

  async function countAuditEntries(action: string): Promise<number> {
    const rows = await getAuditEntries(action);
    return rows.length;
  }

  /** Create a local-trusted session for a user. */
  async function createSession(userId: string, role: 'owner' | 'admin' | 'member' | 'viewer') {
    const res = await request(app)
      .post('/api/auth/local-trusted/create-session')
      .send({ companyId, userId, role })
      .expect(201);
    return res.body.data.id as string;
  }

  /** Seed a step-up session for a user. */
  async function seedStepUp(userId: string, companyIdOverride?: string) {
    await db.drizzle.insert(db.schema.stepUpSessions).values({
      userId,
      companyId: companyIdOverride ?? companyId,
      scope: 'sensitive_action',
      grantedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      consumed: false,
    });
  }

  async function getActiveStepUps(userId: string) {
    return db.drizzle
      .select()
      .from(db.schema.stepUpSessions)
      .where(
        and(
          eq(db.schema.stepUpSessions.userId, userId),
          isNull(db.schema.stepUpSessions.revokedAt),
        ),
      );
  }

  // =========================================================================
  // VAL-OWNER-001: Owner transfers ownership to a company member
  // =========================================================================

  describe('VAL-OWNER-001: owner transfers ownership', () => {
    it('succeeds with newOwner (owner) and previousOwner (admin)', async () => {
      await seedMember('new-owner-001', 'member');

      const res = await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('owner'))
        .send({ targetMemberId: 'new-owner-001' })
        .expect(200);

      expect(res.body.data.newOwner).toBeDefined();
      expect(res.body.data.newOwner.role).toBe('owner');
      expect(res.body.data.newOwner.userId).toBe('new-owner-001');

      expect(res.body.data.previousOwner).toBeDefined();
      expect(res.body.data.previousOwner.role).toBe('admin');
      expect(res.body.data.previousOwner.userId).toBe('dev-user-000');

      // DB state
      const newOwnerMembership = await getMembership('new-owner-001');
      expect(newOwnerMembership?.role).toBe('owner');

      const prevOwnerMembership = await getMembership('dev-user-000');
      expect(prevOwnerMembership?.role).toBe('admin');
    });

    it('works with targetMemberId as company_members.id (UUID)', async () => {
      await seedMember('new-owner-uuid', 'member');
      const membership = await getMembership('new-owner-uuid');
      expect(membership).not.toBeNull();

      const res = await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('owner'))
        .send({ targetMemberId: membership!.id })
        .expect(200);

      expect(res.body.data.newOwner.role).toBe('owner');
      expect(res.body.data.newOwner.id).toBe(membership!.id);
    });
  });

  // =========================================================================
  // VAL-OWNER-002: Missing/invalid targetMemberId returns 400
  // =========================================================================

  describe('VAL-OWNER-002: missing/invalid targetMemberId', () => {
    it('missing targetMemberId returns 400', async () => {
      const res = await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('owner'))
        .send({})
        .expect(400);

      expect(res.body.code).toBe('VALIDATION_ERROR');

      // No roles changed
      const ownerMembership = await getMembership('dev-user-000');
      expect(ownerMembership?.role).toBe('owner');
    });

    it('empty string targetMemberId returns 400', async () => {
      const res = await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('owner'))
        .send({ targetMemberId: '' })
        .expect(400);

      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  // =========================================================================
  // VAL-OWNER-003: Non-owner cannot transfer ownership
  // =========================================================================

  describe('VAL-OWNER-003: non-owner gets 403', () => {
    it('admin gets 403 INSUFFICIENT_ROLE', async () => {
      await seedMember('transfer-target-003', 'member');

      const res = await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('admin'))
        .send({ targetMemberId: 'transfer-target-003' })
        .expect(403);

      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      // No roles changed
      const target = await getMembership('transfer-target-003');
      expect(target?.role).toBe('member');
      const owner = await getMembership('dev-user-000');
      expect(owner?.role).toBe('owner');
    });

    it('member gets 403', async () => {
      await seedMember('transfer-target-003b', 'member');

      const res = await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('member'))
        .send({ targetMemberId: 'transfer-target-003b' })
        .expect(403);

      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('viewer gets 403', async () => {
      await seedMember('transfer-target-003c', 'member');

      const res = await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('viewer'))
        .send({ targetMemberId: 'transfer-target-003c' })
        .expect(403);

      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });
  });

  // =========================================================================
  // VAL-OWNER-004: Self-transfer returns 400 CANNOT_TRANSFER_TO_SELF
  // =========================================================================

  describe('VAL-OWNER-004: self-transfer rejected', () => {
    it('owner targeting self gets 400 CANNOT_TRANSFER_TO_SELF', async () => {
      const ownerMembership = await getMembership('dev-user-000');

      const res = await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('owner'))
        .send({ targetMemberId: 'dev-user-000' })
        .expect(400);

      expect(res.body.code).toBe('CANNOT_TRANSFER_TO_SELF');

      // Owner remains owner
      const after = await getMembership('dev-user-000');
      expect(after?.role).toBe('owner');
    });

    it('owner targeting self by member UUID gets 400', async () => {
      const ownerMembership = await getMembership('dev-user-000');
      expect(ownerMembership).not.toBeNull();

      const res = await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('owner'))
        .send({ targetMemberId: ownerMembership!.id })
        .expect(400);

      expect(res.body.code).toBe('CANNOT_TRANSFER_TO_SELF');
    });
  });

  // =========================================================================
  // VAL-OWNER-005: Transfer to existing owner is rejected
  // =========================================================================

  describe('VAL-OWNER-005: target already owner rejected', () => {
    it('targeting another owner gets 400 TARGET_ALREADY_OWNER', async () => {
      // Seed a second owner
      await seedMember('second-owner-005', 'owner');
      const ownersBefore = await countOwners();
      expect(ownersBefore).toBe(2);

      const res = await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('owner'))
        .send({ targetMemberId: 'second-owner-005' })
        .expect(400);

      expect(res.body.code).toBe('TARGET_ALREADY_OWNER');

      // No roles changed
      const secondOwner = await getMembership('second-owner-005');
      expect(secondOwner?.role).toBe('owner');
      const firstOwner = await getMembership('dev-user-000');
      expect(firstOwner?.role).toBe('owner');
    });
  });

  // =========================================================================
  // VAL-OWNER-006: Nonexistent member returns 404
  // =========================================================================

  describe('VAL-OWNER-006: nonexistent member 404', () => {
    it('nonexistent userId returns 404 MEMBER_NOT_FOUND', async () => {
      const res = await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('owner'))
        .send({ targetMemberId: 'nonexistent-user-999' })
        .expect(404);

      expect(res.body.code).toBe('MEMBER_NOT_FOUND');

      // Owner remains owner
      const owner = await getMembership('dev-user-000');
      expect(owner?.role).toBe('owner');
    });

    it('fabricated UUID returns 404', async () => {
      const res = await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('owner'))
        .send({ targetMemberId: '00000000-0000-0000-0000-000000000000' })
        .expect(404);

      expect(res.body.code).toBe('MEMBER_NOT_FOUND');
    });
  });

  // =========================================================================
  // VAL-OWNER-007: Transfer is atomic — both roles change or neither
  // =========================================================================

  describe('VAL-OWNER-007: atomic transfer', () => {
    it('on success: target promoted and previous demoted in one transaction', async () => {
      await seedMember('atomic-target-007', 'admin');

      await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('owner'))
        .send({ targetMemberId: 'atomic-target-007' })
        .expect(200);

      // Both roles changed
      const target = await getMembership('atomic-target-007');
      expect(target?.role).toBe('owner');
      const prevOwner = await getMembership('dev-user-000');
      expect(prevOwner?.role).toBe('admin');

      // Exactly one owner
      const owners = await countOwners();
      expect(owners).toBe(1);
    });

    it('on failure: both retain original roles', async () => {
      await seedMember('atomic-fail-target-007', 'member');

      // This will fail because the target doesn't exist
      await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('owner'))
        .send({ targetMemberId: 'nonexistent-for-atomic' })
        .expect(404);

      // No roles changed
      const owner = await getMembership('dev-user-000');
      expect(owner?.role).toBe('owner');
      const target = await getMembership('atomic-fail-target-007');
      expect(target?.role).toBe('member');
    });
  });

  // =========================================================================
  // VAL-OWNER-008: Demoted owner's step-up sessions are revoked
  // =========================================================================

  describe('VAL-OWNER-008: step-up sessions revoked', () => {
    it('previous owner step-up sessions revoked after transfer', async () => {
      await seedMember('stepup-target-008', 'member');

      // Seed a step-up session for the current owner (dev-user-000)
      await seedStepUp('dev-user-000');

      const activeBefore = await getActiveStepUps('dev-user-000');
      expect(activeBefore.length).toBeGreaterThanOrEqual(1);

      await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('owner'))
        .send({ targetMemberId: 'stepup-target-008' })
        .expect(200);

      // All step-ups for the demoted owner should be revoked
      const activeAfter = await getActiveStepUps('dev-user-000');
      expect(activeAfter.length).toBe(0);
    });
  });

  // =========================================================================
  // VAL-OWNER-009: New owner can perform owner-only actions; previous gets 403
  // =========================================================================

  describe('VAL-OWNER-009: new owner can act; previous owner cannot', () => {
    it('new owner can PATCH roles; previous owner gets 403', async () => {
      await seedMember('new-owner-009', 'member');
      await seedMember('bystander-009', 'member');

      // Transfer ownership
      await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('owner'))
        .send({ targetMemberId: 'new-owner-009' })
        .expect(200);

      // New owner (new-owner-009) can perform owner-only action (PATCH role)
      const newOwnerRes = await request(app)
        .patch(url('/members/bystander-009/role'))
        .set(userHeader('new-owner-009'))
        .send({ role: 'admin' })
        .expect(200);

      expect(newOwnerRes.body.data.role).toBe('admin');

      // Previous owner (dev-user-000) gets 403 on the same action
      const prevOwnerRes = await request(app)
        .patch(url('/members/bystander-009/role'))
        .set(userHeader('dev-user-000'))
        .send({ role: 'member' })
        .expect(403);

      expect(prevOwnerRes.body.code).toBe('INSUFFICIENT_PERMISSION');
    });
  });

  // =========================================================================
  // VAL-OWNER-010: Transfer persists through member readback
  // =========================================================================

  describe('VAL-OWNER-010: transfer persists in GET /members', () => {
    it('GET /members shows target as owner, previous as admin', async () => {
      await seedMember('persist-target-010', 'member');

      await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('owner'))
        .send({ targetMemberId: 'persist-target-010' })
        .expect(200);

      // Read back via the API
      const res = await request(app)
        .get(url('/members'))
        .set(userHeader('persist-target-010'))
        .expect(200);

      const members = res.body.data;
      const newOwner = members.find((m: any) => m.userId === 'persist-target-010');
      expect(newOwner).toBeDefined();
      expect(newOwner.role).toBe('owner');

      const prevOwner = members.find((m: any) => m.userId === 'dev-user-000');
      expect(prevOwner).toBeDefined();
      expect(prevOwner.role).toBe('admin');
    });
  });

  // =========================================================================
  // VAL-OWNER-011: Transfer works in local_trusted mode with session updates
  // =========================================================================

  describe('VAL-OWNER-011: local_trusted session updates', () => {
    it('updates local_trusted_sessions for both users', async () => {
      await seedMember('lt-target-011', 'member');

      // Create sessions for both users
      const ownerSessionId = await createSession('dev-user-000', 'owner');
      const targetSessionId = await createSession('lt-target-011', 'member');

      // Transfer using the owner session
      await request(app)
        .post(url('/transfer-ownership'))
        .set('X-Eidolon-Test-Session-Id', ownerSessionId)
        .send({ targetMemberId: 'lt-target-011' })
        .expect(200);

      // Check that the target's session now has role=owner
      const [targetSession] = await db.drizzle
        .select()
        .from(db.schema.localTrustedSessions)
        .where(eq(db.schema.localTrustedSessions.id, targetSessionId))
        .limit(1);
      expect(targetSession?.role).toBe('owner');

      // Check that the previous owner's session now has role=admin
      const [ownerSession] = await db.drizzle
        .select()
        .from(db.schema.localTrustedSessions)
        .where(eq(db.schema.localTrustedSessions.id, ownerSessionId))
        .limit(1);
      expect(ownerSession?.role).toBe('admin');
    });

    it('new owner session can perform owner-only action; old owner session cannot', async () => {
      await seedMember('lt-target-011b', 'member');
      await seedMember('lt-bystander-011b', 'member');

      const ownerSessionId = await createSession('dev-user-000', 'owner');
      const targetSessionId = await createSession('lt-target-011b', 'member');

      // Transfer
      await request(app)
        .post(url('/transfer-ownership'))
        .set('X-Eidolon-Test-Session-Id', ownerSessionId)
        .send({ targetMemberId: 'lt-target-011b' })
        .expect(200);

      // New owner's session can do owner-only action
      await request(app)
        .patch(url('/members/lt-bystander-011b/role'))
        .set('X-Eidolon-Test-Session-Id', targetSessionId)
        .send({ role: 'admin' })
        .expect(200);

      // Previous owner's session gets 403
      await request(app)
        .patch(url('/members/lt-bystander-011b/role'))
        .set('X-Eidolon-Test-Session-Id', ownerSessionId)
        .send({ role: 'member' })
        .expect(403);
    });
  });

  // =========================================================================
  // VAL-AUDIT-005: Ownership transfer creates audit entry
  // =========================================================================

  describe('VAL-AUDIT-005: audit entry created', () => {
    it('creates ownership.transferred entry with both owner IDs in metadata', async () => {
      await seedMember('audit-target-005', 'member');

      const res = await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('owner'))
        .send({ targetMemberId: 'audit-target-005' })
        .expect(200);

      const entries = await getAuditEntries('ownership.transferred');
      expect(entries.length).toBe(1);

      const entry = entries[0];
      expect(entry.actorType).toBe('user');
      expect(entry.actorId).toBe('dev-user-000');
      expect(entry.entityType).toBe('company');
      expect(entry.entityId).toBe(companyId);

      const metadata = entry.metadata as Record<string, unknown>;
      expect(metadata.previousOwnerUserId).toBe('dev-user-000');
      expect(metadata.newOwnerUserId).toBe('audit-target-005');
      expect(metadata.newOwnerMemberId).toBeDefined();
      expect(metadata.previousOwnerMemberId).toBeDefined();

      // No secrets in metadata
      const metadataStr = JSON.stringify(metadata);
      expect(metadataStr).not.toMatch(/password|secret|token|key/i);
    });

    it('audit entry is readable through GET /activity', async () => {
      await seedMember('audit-readback-005', 'member');

      await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('owner'))
        .send({ targetMemberId: 'audit-readback-005' })
        .expect(200);

      const res = await request(app)
        .get(url('/activity'))
        .set(userHeader('audit-readback-005'))
        .expect(200);

      const transferEntry = res.body.data.find((e: any) => e.action === 'ownership.transferred');
      expect(transferEntry).toBeDefined();
      expect(transferEntry.entityType).toBe('company');
      expect(transferEntry.entityId).toBe(companyId);
    });
  });

  // =========================================================================
  // VAL-AUDIT-006: Failed transfers do not write audit entries
  // =========================================================================

  describe('VAL-AUDIT-006: failed transfers not audited', () => {
    it('403 failure does not create audit entry', async () => {
      const before = await countAuditEntries('ownership.transferred');

      await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('admin'))
        .send({ targetMemberId: 'some-user' })
        .expect(403);

      const after = await countAuditEntries('ownership.transferred');
      expect(after).toBe(before);
    });

    it('404 failure does not create audit entry', async () => {
      const before = await countAuditEntries('ownership.transferred');

      await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('owner'))
        .send({ targetMemberId: 'nonexistent-audit-006' })
        .expect(404);

      const after = await countAuditEntries('ownership.transferred');
      expect(after).toBe(before);
    });

    it('400 self-transfer failure does not create audit entry', async () => {
      const before = await countAuditEntries('ownership.transferred');

      await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('owner'))
        .send({ targetMemberId: 'dev-user-000' })
        .expect(400);

      const after = await countAuditEntries('ownership.transferred');
      expect(after).toBe(before);
    });

    it('400 already-owner failure does not create audit entry', async () => {
      await seedMember('audit-already-owner-006', 'owner');
      const before = await countAuditEntries('ownership.transferred');

      await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('owner'))
        .send({ targetMemberId: 'audit-already-owner-006' })
        .expect(400);

      const after = await countAuditEntries('ownership.transferred');
      expect(after).toBe(before);
    });
  });

  // =========================================================================
  // VAL-AUDIT-008: Existing RBAC audit events remain intact
  // =========================================================================

  describe('VAL-AUDIT-008: existing audit events still work', () => {
    it('member.role_changed audit still works after transfer', async () => {
      await seedMember('regression-target-008', 'member');

      // Transfer ownership first
      await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('owner'))
        .send({ targetMemberId: 'regression-target-008' })
        .expect(200);

      // New owner changes someone's role — should produce member.role_changed
      await seedMember('regression-victim-008', 'member');

      await request(app)
        .patch(url('/members/regression-victim-008/role'))
        .set(userHeader('regression-target-008'))
        .send({ role: 'admin' })
        .expect(200);

      const roleChangedEntries = await getAuditEntries('member.role_changed');
      expect(roleChangedEntries.length).toBeGreaterThanOrEqual(1);
      const latest = roleChangedEntries[roleChangedEntries.length - 1];
      expect(latest.action).toBe('member.role_changed');
    });

    it('member.removed audit still works after transfer', async () => {
      await seedMember('regression-remove-target-008', 'member');
      await seedMember('regression-remove-victim-008', 'member');

      // Transfer ownership
      await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('owner'))
        .send({ targetMemberId: 'regression-remove-target-008' })
        .expect(200);

      // New owner removes a member
      await request(app)
        .delete(url('/members/regression-remove-victim-008'))
        .set(userHeader('regression-remove-target-008'))
        .expect(200);

      const removedEntries = await getAuditEntries('member.removed');
      expect(removedEntries.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // VAL-CROSS-001: Ownership transfer recorded in activity log
  // =========================================================================

  describe('VAL-CROSS-001: transfer recorded in activity log', () => {
    it('GET /activity returns ownership.transferred after transfer', async () => {
      await seedMember('cross-target-001', 'member');

      await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('owner'))
        .send({ targetMemberId: 'cross-target-001' })
        .expect(200);

      const res = await request(app)
        .get(url('/activity'))
        .set(userHeader('cross-target-001'))
        .expect(200);

      const entry = res.body.data.find((e: any) => e.action === 'ownership.transferred');
      expect(entry).toBeDefined();
      expect(entry.metadata.previousOwnerUserId).toBe('dev-user-000');
      expect(entry.metadata.newOwnerUserId).toBe('cross-target-001');
    });
  });

  // =========================================================================
  // VAL-CROSS-002: Transfer updates effective permissions end-to-end
  // =========================================================================

  describe('VAL-CROSS-002: effective permissions update end-to-end', () => {
    it('new owner can promote/demote; previous owner gets 403', async () => {
      await seedMember('cross-new-owner-002', 'member');
      await seedMember('cross-victim-002', 'member');

      // Transfer
      await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('owner'))
        .send({ targetMemberId: 'cross-new-owner-002' })
        .expect(200);

      // New owner can change roles
      const newOwnerAction = await request(app)
        .post(url('/members/cross-victim-002/role'))
        .set(userHeader('cross-new-owner-002'))
        .send({ role: 'admin' })
        .expect(200);
      expect(newOwnerAction.body.data.role).toBe('admin');

      // Previous owner gets 403 on the same action
      const prevOwnerAction = await request(app)
        .post(url('/members/cross-victim-002/role'))
        .set(userHeader('dev-user-000'))
        .send({ role: 'member' })
        .expect(403);
      expect(prevOwnerAction.body.code).toBe('INSUFFICIENT_PERMISSION');
    });
  });

  // =========================================================================
  // ISSUE 1 FIX: Session-only targets (found in local_trusted_sessions but
  // NOT in company_members) must be rejected with 404 MEMBER_NOT_FOUND.
  // Ownership transfer requires a persisted company_members row.
  // =========================================================================

  describe('ISSUE 1: session-only target rejected', () => {
    it('target found only in local_trusted_sessions gets 404 MEMBER_NOT_FOUND', async () => {
      // Create a local_trusted session WITHOUT a company_members row
      await db.drizzle.insert(db.schema.localTrustedSessions).values({
        companyId,
        userId: 'session-only-target',
        role: 'member',
      });

      // Verify no company_members row exists for this user
      const membership = await getMembership('session-only-target');
      expect(membership).toBeNull();

      // Transfer should be rejected with 404
      const res = await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('owner'))
        .send({ targetMemberId: 'session-only-target' })
        .expect(404);

      expect(res.body.code).toBe('MEMBER_NOT_FOUND');

      // Owner remains owner — no demotion occurred
      const owner = await getMembership('dev-user-000');
      expect(owner?.role).toBe('owner');

      // No audit entry was written
      const auditCount = await countAuditEntries('ownership.transferred');
      expect(auditCount).toBe(0);
    });

    it('session-only target by UUID (session id) gets 404 MEMBER_NOT_FOUND', async () => {
      // Create a local_trusted session and use its id as targetMemberId
      const sessionResult = await db.drizzle
        .insert(db.schema.localTrustedSessions)
        .values({
          companyId,
          userId: 'session-only-uuid-target',
          role: 'member',
        })
        .returning({ id: db.schema.localTrustedSessions.id });

      const sessionId = sessionResult[0].id;

      // Verify no company_members row exists
      const membership = await getMembership('session-only-uuid-target');
      expect(membership).toBeNull();

      // Transfer targeting the session id should be rejected
      const res = await request(app)
        .post(url('/transfer-ownership'))
        .set(roleHeader('owner'))
        .send({ targetMemberId: sessionId })
        .expect(404);

      expect(res.body.code).toBe('MEMBER_NOT_FOUND');

      // Owner remains owner
      const owner = await getMembership('dev-user-000');
      expect(owner?.role).toBe('owner');
    });
  });

  // =========================================================================
  // ISSUE 2 FIX: Target lookup must be transaction-bound (using tx, not db),
  // and the promotion update must verify at least one row was affected.
  // If the target is concurrently removed (promotion affects 0 rows), the
  // transaction must roll back — no demotion of the current owner.
  // =========================================================================

  describe('ISSUE 2: concurrent target removal causes rollback', () => {
    it('if promotion affects 0 rows (target concurrently removed), owner is not demoted', async () => {
      await seedMember('concurrent-remove-target', 'member');

      // Create a BEFORE UPDATE trigger that returns NULL for the target's
      // promotion, simulating a concurrent removal that makes the UPDATE
      // a no-op (0 rows affected in .returning()).
      await db.drizzle.execute(sql`
        CREATE OR REPLACE FUNCTION test_skip_promotion() RETURNS trigger AS $$
        BEGIN
          RETURN NULL;
        END;
        $$ LANGUAGE plpgsql
      `);
      await db.drizzle.execute(sql`
        CREATE TRIGGER test_skip_promotion_trigger
        BEFORE UPDATE ON company_members
        FOR EACH ROW
        WHEN (NEW.role = 'owner' AND OLD.role != 'owner' AND NEW.user_id = 'concurrent-remove-target')
        EXECUTE FUNCTION test_skip_promotion()
      `);

      try {
        const res = await request(app)
          .post(url('/transfer-ownership'))
          .set(roleHeader('owner'))
          .send({ targetMemberId: 'concurrent-remove-target' })
          .expect(404);

        expect(res.body.code).toBe('MEMBER_NOT_FOUND');

        // Owner was NOT demoted — transaction rolled back
        const owner = await getMembership('dev-user-000');
        expect(owner?.role).toBe('owner');

        // Target was NOT promoted — still member
        const target = await getMembership('concurrent-remove-target');
        expect(target?.role).toBe('member');

        // Exactly one owner (the original)
        const owners = await countOwners();
        expect(owners).toBe(1);

        // No audit entry was written
        const auditCount = await countAuditEntries('ownership.transferred');
        expect(auditCount).toBe(0);
      } finally {
        await db.drizzle.execute(
          sql`DROP TRIGGER IF EXISTS test_skip_promotion_trigger ON company_members`,
        );
        await db.drizzle.execute(sql`DROP FUNCTION IF EXISTS test_skip_promotion()`);
      }
    });
  });
});
