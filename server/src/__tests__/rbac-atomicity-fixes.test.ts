import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { eq, and } from 'drizzle-orm';
import { createTestDb, createTestServer } from '../test-utils.js';
import type { DbInstance } from '../types.js';

/**
 * RBAC Atomicity & Validation Fixes Tests
 *
 * Tests for the M2 scrutiny fixes:
 *   1. Atomic last-owner protection for role demotion (concurrent scenario)
 *   2. Atomic last-owner protection for member removal
 *   3. Invitation email normalization (case-insensitive duplicate prevention)
 *   4. Email case-insensitive webhook matching
 *   5. Agent API key agentId cross-company rejection
 */
describe('RBAC Atomicity & Validation Fixes', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    const res = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Atomicity Fix Test', settings: { testFixture: true } })
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

  async function seedAgent(agentId: string, coId: string = companyId): Promise<void> {
    await db.drizzle
      .insert(db.schema.agents)
      .values({
        id: agentId,
        companyId: coId,
        name: 'Test Agent',
        role: 'engineer',
      })
      .onConflictDoNothing();
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

  async function getInvitationByEmail(email: string) {
    const rows = await db.drizzle
      .select()
      .from(db.schema.companyInvitations)
      .where(
        and(
          eq(db.schema.companyInvitations.companyId, companyId),
          eq(db.schema.companyInvitations.email, email),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Build a simulated Clerk user.created webhook payload. */
  function clerkUserCreatedPayload(clerkUserId: string, email: string) {
    const emailId = `ema_${clerkUserId}`;
    return {
      type: 'user.created',
      object: 'event',
      data: {
        id: clerkUserId,
        object: 'user',
        username: null,
        first_name: 'Test',
        last_name: 'User',
        image_url: '',
        has_image: false,
        primary_email_address_id: emailId,
        primary_phone_number_id: null,
        primary_web3_wallet_id: null,
        password_enabled: true,
        two_factor_enabled: false,
        totp_enabled: false,
        backup_code_enabled: false,
        email_addresses: [
          {
            id: emailId,
            object: 'email_address',
            email_address: email,
            verification: null,
            linked_to: [],
          },
        ],
        phone_numbers: [],
        web3_wallets: [],
        organization_memberships: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    };
  }

  // =========================================================================
  // Fix 1: Atomic last-owner protection for role demotion
  // =========================================================================

  describe('atomic last-owner protection: role demotion', () => {
    it('sole owner cannot demote themselves (400); role unchanged', async () => {
      const ownersBefore = await countOwners();
      expect(ownersBefore).toBe(1);

      const res = await request(app)
        .patch(url('/members/dev-user-000/role'))
        .set(roleHeader('owner'))
        .send({ role: 'admin' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('LAST_OWNER_PROTECTION');

      const membership = await getMembership('dev-user-000');
      expect(membership?.role).toBe('owner');

      const ownersAfter = await countOwners();
      expect(ownersAfter).toBe(1);
    });

    it('concurrent demotion of both owners: exactly one succeeds, one fails', async () => {
      // Seed two owners (dev-user-000 is already owner, add a second)
      await seedMember('concurrent-owner-a', 'owner');
      await seedMember('concurrent-owner-b', 'owner');

      const ownersBefore = await countOwners();
      expect(ownersBefore).toBe(3); // dev-user-000 + a + b

      // Two concurrent requests to demote both non-dev owners to member.
      // With the old non-atomic code, both could see count=3 and both
      // succeed, leaving only 1 owner (dev-user-000). With the atomic
      // code, the SELECT FOR UPDATE serializes them: one succeeds (count
      // drops to 2), the other sees count=2 (still > 1) and also succeeds.
      // Wait — both should succeed here because there are 3 owners and
      // demoting 2 still leaves 1. Let me test the true last-owner race:
      // 2 owners, both demoted concurrently → exactly one must fail.

      // Reset: remove dev-user-000's ownership to create a 2-owner scenario
      await db.drizzle
        .update(db.schema.companyMembers)
        .set({ role: 'member' })
        .where(
          and(
            eq(db.schema.companyMembers.companyId, companyId),
            eq(db.schema.companyMembers.userId, 'dev-user-000'),
          ),
        );

      // Remove concurrent-owner-a and b, re-add as a fresh 2-owner setup
      await db.drizzle
        .delete(db.schema.companyMembers)
        .where(
          and(
            eq(db.schema.companyMembers.companyId, companyId),
            eq(db.schema.companyMembers.userId, 'concurrent-owner-a'),
          ),
        );
      await db.drizzle
        .delete(db.schema.companyMembers)
        .where(
          and(
            eq(db.schema.companyMembers.companyId, companyId),
            eq(db.schema.companyMembers.userId, 'concurrent-owner-b'),
          ),
        );

      // Add exactly 2 owners
      await seedMember('race-owner-1', 'owner');
      await seedMember('race-owner-2', 'owner');

      const raceOwnersBefore = await countOwners();
      expect(raceOwnersBefore).toBe(2);

      // Fire two concurrent demotion requests (Promise.all)
      const [res1, res2] = await Promise.all([
        request(app)
          .patch(url('/members/race-owner-1/role'))
          .set(userHeader('race-owner-1'))
          .send({ role: 'member' }),
        request(app)
          .patch(url('/members/race-owner-2/role'))
          .set(userHeader('race-owner-2'))
          .send({ role: 'member' }),
      ]);

      // Exactly one should succeed (200) and the other should fail (400)
      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toContain(200);
      expect(statuses).toContain(400);

      // The company must retain at least one owner
      const ownersAfter = await countOwners();
      expect(ownersAfter).toBe(1);

      // Verify which one succeeded and which failed
      const m1 = await getMembership('race-owner-1');
      const m2 = await getMembership('race-owner-2');
      const roles = [m1?.role, m2?.role].sort();
      expect(roles).toContain('owner');
      expect(roles).toContain('member');
    });

    it('owner can demote self when another owner exists (200)', async () => {
      await seedMember('second-owner-demote', 'owner');
      const ownersBefore = await countOwners();
      expect(ownersBefore).toBe(2);

      const res = await request(app)
        .patch(url('/members/dev-user-000/role'))
        .set(roleHeader('owner'))
        .send({ role: 'member' })
        .expect(200);

      expect(res.body.data.role).toBe('member');
      const ownersAfter = await countOwners();
      expect(ownersAfter).toBe(1);
    });
  });

  // =========================================================================
  // Fix 2: Atomic last-owner protection for member removal
  // =========================================================================

  describe('atomic last-owner protection: member removal', () => {
    it('sole owner cannot be removed (400)', async () => {
      const ownersBefore = await countOwners();
      expect(ownersBefore).toBe(1);

      const res = await request(app).delete(url('/members/dev-user-000')).set(roleHeader('owner'));

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('LAST_OWNER_PROTECTION');

      const membership = await getMembership('dev-user-000');
      expect(membership).not.toBeNull();
      expect(membership?.role).toBe('owner');

      const ownersAfter = await countOwners();
      expect(ownersAfter).toBe(1);
    });

    it('concurrent removal of both owners: exactly one succeeds, one fails', async () => {
      // Set up exactly 2 owners (remove dev-user-000's ownership)
      await db.drizzle
        .update(db.schema.companyMembers)
        .set({ role: 'member' })
        .where(
          and(
            eq(db.schema.companyMembers.companyId, companyId),
            eq(db.schema.companyMembers.userId, 'dev-user-000'),
          ),
        );

      await seedMember('race-remove-1', 'owner');
      await seedMember('race-remove-2', 'owner');

      const ownersBefore = await countOwners();
      expect(ownersBefore).toBe(2);

      // Fire two concurrent removal requests (Promise.all)
      const [res1, res2] = await Promise.all([
        request(app).delete(url('/members/race-remove-1')).set(userHeader('race-remove-1')),
        request(app).delete(url('/members/race-remove-2')).set(userHeader('race-remove-2')),
      ]);

      // Exactly one should succeed (200) and the other should fail (400)
      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toContain(200);
      expect(statuses).toContain(400);

      // The company must retain at least one owner
      const ownersAfter = await countOwners();
      expect(ownersAfter).toBe(1);
    });

    it('owner can remove another (non-last) owner (200)', async () => {
      await seedMember('removable-owner', 'owner');
      const ownersBefore = await countOwners();
      expect(ownersBefore).toBe(2);

      await request(app)
        .delete(url('/members/removable-owner'))
        .set(roleHeader('owner'))
        .expect(200);

      const membership = await getMembership('removable-owner');
      expect(membership).toBeNull();

      const ownersAfter = await countOwners();
      expect(ownersAfter).toBe(1);
    });
  });

  // =========================================================================
  // Fix 3: Invitation email normalization (case-insensitive duplicate)
  // =========================================================================

  describe('email normalization: case-insensitive duplicate prevention', () => {
    it('email is stored in lowercase', async () => {
      const res = await request(app)
        .post(url('/invitations'))
        .set(roleHeader('owner'))
        .send({ email: 'John.Doe@Example.COM', role: 'member' })
        .expect(201);

      expect(res.body.data.email).toBe('john.doe@example.com');

      const inv = await getInvitationByEmail('john.doe@example.com');
      expect(inv).not.toBeNull();
      expect(inv?.email).toBe('john.doe@example.com');
    });

    it('email with whitespace is trimmed and lowercased', async () => {
      const res = await request(app)
        .post(url('/invitations'))
        .set(roleHeader('owner'))
        .send({ email: '  Alice@Test.com  ', role: 'member' })
        .expect(201);

      expect(res.body.data.email).toBe('alice@test.com');

      const inv = await getInvitationByEmail('alice@test.com');
      expect(inv?.email).toBe('alice@test.com');
    });

    it('case variants are treated as duplicates (409)', async () => {
      // Create first invitation with mixed case
      await request(app)
        .post(url('/invitations'))
        .set(roleHeader('owner'))
        .send({ email: 'John@Example.com', role: 'member' })
        .expect(201);

      // Second invitation with different case should be rejected as duplicate
      const res = await request(app)
        .post(url('/invitations'))
        .set(roleHeader('owner'))
        .send({ email: 'john@example.com', role: 'admin' })
        .expect(409);

      expect(res.body.code).toBe('DUPLICATE_PENDING_INVITATION');

      // Verify only one invitation exists
      const inv = await getInvitationByEmail('john@example.com');
      expect(inv?.role).toBe('member'); // first invitation's role
    });

    it('UPPERCASE email matches lowercase email as duplicate', async () => {
      await request(app)
        .post(url('/invitations'))
        .set(roleHeader('owner'))
        .send({ email: 'test@domain.com', role: 'viewer' })
        .expect(201);

      const res = await request(app)
        .post(url('/invitations'))
        .set(roleHeader('owner'))
        .send({ email: 'TEST@DOMAIN.COM', role: 'admin' })
        .expect(409);

      expect(res.body.code).toBe('DUPLICATE_PENDING_INVITATION');
    });

    it('different emails are not treated as duplicates', async () => {
      await request(app)
        .post(url('/invitations'))
        .set(roleHeader('owner'))
        .send({ email: 'alice@test.com', role: 'member' })
        .expect(201);

      await request(app)
        .post(url('/invitations'))
        .set(roleHeader('owner'))
        .send({ email: 'bob@test.com', role: 'member' })
        .expect(201);
    });
  });

  // =========================================================================
  // Fix 4: Email case-insensitive webhook matching
  // =========================================================================

  describe('email case-insensitive webhook matching', () => {
    it('webhook with uppercase email matches lowercase invitation', async () => {
      // Create invitation with lowercase email
      await request(app)
        .post(url('/invitations'))
        .set(roleHeader('owner'))
        .send({ email: 'mixedcase@test.com', role: 'admin' })
        .expect(201);

      // Webhook with uppercase email should match
      const clerkUserId = 'user_webhook_case';
      const res = await request(app)
        .post('/api/webhooks/clerk')
        .send(clerkUserCreatedPayload(clerkUserId, 'MIXEDCASE@TEST.COM'))
        .expect(200);

      expect(res.body.received).toBe(true);

      // Membership created with invitation's role
      const membership = await getMembership(clerkUserId);
      expect(membership).not.toBeNull();
      expect(membership?.role).toBe('admin');

      // Invitation is accepted
      const inv = await getInvitationByEmail('mixedcase@test.com');
      expect(inv?.status).toBe('accepted');
      expect(inv?.acceptedByUserId).toBe(clerkUserId);
    });

    it('webhook with mixed-case email matches lowercase invitation', async () => {
      await request(app)
        .post(url('/invitations'))
        .set(roleHeader('owner'))
        .send({ email: 'user@domain.com', role: 'member' })
        .expect(201);

      const clerkUserId = 'user_webhook_mixed';
      await request(app)
        .post('/api/webhooks/clerk')
        .send(clerkUserCreatedPayload(clerkUserId, 'UsEr@DoMain.CoM'))
        .expect(200);

      const membership = await getMembership(clerkUserId);
      expect(membership).not.toBeNull();
      expect(membership?.role).toBe('member');
    });

    it('webhook email with whitespace is trimmed before matching', async () => {
      await request(app)
        .post(url('/invitations'))
        .set(roleHeader('owner'))
        .send({ email: 'whitespace@test.com', role: 'member' })
        .expect(201);

      const clerkUserId = 'user_webhook_ws';
      await request(app)
        .post('/api/webhooks/clerk')
        .send(clerkUserCreatedPayload(clerkUserId, '  whitespace@test.com  '))
        .expect(200);

      const membership = await getMembership(clerkUserId);
      expect(membership).not.toBeNull();
      expect(membership?.role).toBe('member');
    });
  });

  // =========================================================================
  // Fix 5: Agent API key agentId cross-company rejection
  // =========================================================================

  describe('agentId company validation', () => {
    it('creating key with agentId from same company succeeds (201)', async () => {
      const agentId = 'agent-same-co';
      await seedAgent(agentId);

      const res = await request(app)
        .post(url('/agent-api-keys'))
        .set(roleHeader('owner'))
        .send({ name: 'Bound Key', agentId })
        .expect(201);

      expect(res.body.data.agentId).toBe(agentId);
    });

    it('creating key with agentId from different company returns 400', async () => {
      // Create an agent in a different company
      const otherCompanyId = 'co-agent-cross';
      await seedOtherCompany(otherCompanyId, 'other-owner', 'owner');
      const agentId = 'agent-other-co';
      await seedAgent(agentId, otherCompanyId);

      const res = await request(app)
        .post(url('/agent-api-keys'))
        .set(roleHeader('owner'))
        .send({ name: 'Cross-company Key', agentId })
        .expect(400);

      expect(res.body.code).toBe('AGENT_COMPANY_MISMATCH');

      // No key was created
      const keys = await db.drizzle
        .select()
        .from(db.schema.agentApiKeys)
        .where(eq(db.schema.agentApiKeys.companyId, companyId));
      expect(keys.length).toBe(0);
    });

    it('creating key with non-existent agentId returns 400', async () => {
      const res = await request(app)
        .post(url('/agent-api-keys'))
        .set(roleHeader('owner'))
        .send({ name: 'Ghost Agent Key', agentId: 'nonexistent-agent-id' })
        .expect(400);

      expect(res.body.code).toBe('AGENT_NOT_FOUND');

      // No key was created
      const keys = await db.drizzle
        .select()
        .from(db.schema.agentApiKeys)
        .where(eq(db.schema.agentApiKeys.companyId, companyId));
      expect(keys.length).toBe(0);
    });

    it('creating key without agentId still works (201)', async () => {
      const res = await request(app)
        .post(url('/agent-api-keys'))
        .set(roleHeader('owner'))
        .send({ name: 'Unbound Key' })
        .expect(201);

      expect(res.body.data.agentId).toBeNull();
    });
  });

  // =========================================================================
  // Fix 6: Atomic webhook acceptance (non-blocking)
  // =========================================================================

  describe('atomic webhook acceptance', () => {
    it('webhook creates membership and accepts invitation atomically', async () => {
      await request(app)
        .post(url('/invitations'))
        .set(roleHeader('owner'))
        .send({ email: 'atomic@test.com', role: 'member' })
        .expect(201);

      const clerkUserId = 'user_atomic';
      await request(app)
        .post('/api/webhooks/clerk')
        .send(clerkUserCreatedPayload(clerkUserId, 'atomic@test.com'))
        .expect(200);

      // Both membership and acceptance happened
      const membership = await getMembership(clerkUserId);
      expect(membership).not.toBeNull();
      expect(membership?.role).toBe('member');

      const inv = await getInvitationByEmail('atomic@test.com');
      expect(inv?.status).toBe('accepted');
    });

    it('expired invitation is not accepted by webhook (no membership)', async () => {
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await db.drizzle.insert(db.schema.companyInvitations).values({
        companyId,
        email: 'expired-atomic@test.com',
        role: 'member',
        status: 'pending',
        invitedByUserId: 'dev-user-000',
        expiresAt: pastDate,
      });

      const clerkUserId = 'user_expired_atomic';
      await request(app)
        .post('/api/webhooks/clerk')
        .send(clerkUserCreatedPayload(clerkUserId, 'expired-atomic@test.com'))
        .expect(200);

      // No membership created
      const membership = await getMembership(clerkUserId);
      expect(membership).toBeNull();

      // Invitation remains pending
      const inv = await getInvitationByEmail('expired-atomic@test.com');
      expect(inv?.status).toBe('pending');
    });

    it('revoked invitation is not accepted by webhook (no membership)', async () => {
      await db.drizzle.insert(db.schema.companyInvitations).values({
        companyId,
        email: 'revoked-atomic@test.com',
        role: 'member',
        status: 'revoked',
        invitedByUserId: 'dev-user-000',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });

      const clerkUserId = 'user_revoked_atomic';
      await request(app)
        .post('/api/webhooks/clerk')
        .send(clerkUserCreatedPayload(clerkUserId, 'revoked-atomic@test.com'))
        .expect(200);

      // No membership created
      const membership = await getMembership(clerkUserId);
      expect(membership).toBeNull();

      // Invitation remains revoked
      const inv = await getInvitationByEmail('revoked-atomic@test.com');
      expect(inv?.status).toBe('revoked');
    });
  });
});
