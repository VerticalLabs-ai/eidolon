import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { eq, and } from 'drizzle-orm';
import { createTestDb, createTestServer } from '../test-utils.js';
import type { DbInstance } from '../types.js';

/**
 * RBAC Invitation System Tests
 *
 * Comprehensive tests for invitation CRUD and the Clerk webhook handler.
 * Covers all VAL-INV-* assertions plus VAL-CROSS-001/002/003/009/014/015.
 *
 * Invitation endpoints:
 *   POST   /api/companies/:companyId/invitations
 *   GET    /api/companies/:companyId/invitations
 *   DELETE /api/companies/:companyId/invitations/:invitationId
 *
 * Webhook endpoint:
 *   POST   /api/webhooks/clerk
 */
describe('RBAC Invitation System', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    // Create a company — auto-creates owner membership for dev-user-000
    const res = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Invitations Test', settings: { testFixture: true } })
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

  async function getInvitation(invitationId: string) {
    const rows = await db.drizzle
      .select()
      .from(db.schema.companyInvitations)
      .where(eq(db.schema.companyInvitations.id, invitationId))
      .limit(1);
    return rows[0] ?? null;
  }

  async function getMembership(companyId: string, userId: string) {
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

  async function countInvitations(): Promise<number> {
    const rows = await db.drizzle
      .select()
      .from(db.schema.companyInvitations)
      .where(eq(db.schema.companyInvitations.companyId, companyId));
    return rows.length;
  }

  /** Seed an invitation directly in the DB. */
  async function seedInvitation(
    email: string,
    role: 'owner' | 'admin' | 'member' | 'viewer' = 'member',
    overrides: Partial<{
      status: string;
      expiresAt: Date;
      companyId: string;
      acceptedByUserId: string;
      acceptedAt: Date;
    }> = {},
  ) {
    const [invitation] = await db.drizzle
      .insert(db.schema.companyInvitations)
      .values({
        companyId: overrides.companyId ?? companyId,
        email,
        role,
        status: (overrides.status as any) ?? 'pending',
        invitedByUserId: 'dev-user-000',
        expiresAt: overrides.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        acceptedByUserId: overrides.acceptedByUserId,
        acceptedAt: overrides.acceptedAt,
      })
      .returning();
    return invitation;
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
  // VAL-INV-001: Owner creates an invitation
  // =========================================================================

  describe('VAL-INV-001: owner creates invitation', () => {
    it('owner POST invitation returns 2xx with pending status', async () => {
      const res = await request(app)
        .post(url('/invitations'))
        .set(roleHeader('owner'))
        .send({ email: 'invitee-001@test.com', role: 'member' })
        .expect(201);

      expect(res.body.data.status).toBe('pending');
      expect(res.body.data.email).toBe('invitee-001@test.com');

      // DB row exists
      const invitation = await getInvitation(res.body.data.id);
      expect(invitation).not.toBeNull();
      expect(invitation?.status).toBe('pending');
    });
  });

  // =========================================================================
  // VAL-INV-002: Admin creates an invitation
  // =========================================================================

  describe('VAL-INV-002: admin creates invitation', () => {
    it('admin POST invitation returns 2xx with pending status', async () => {
      const res = await request(app)
        .post(url('/invitations'))
        .set(roleHeader('admin'))
        .send({ email: 'invitee-002@test.com', role: 'member' })
        .expect(201);

      expect(res.body.data.status).toBe('pending');

      const invitation = await getInvitation(res.body.data.id);
      expect(invitation).not.toBeNull();
      expect(invitation?.status).toBe('pending');
    });
  });

  // =========================================================================
  // VAL-INV-003: Member cannot create an invitation
  // =========================================================================

  describe('VAL-INV-003: member cannot create invitation', () => {
    it('member gets 403 on POST; no invitation row created', async () => {
      const countBefore = await countInvitations();

      const res = await request(app)
        .post(url('/invitations'))
        .set(roleHeader('member'))
        .send({ email: 'invitee-003@test.com', role: 'member' })
        .expect(403);

      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      const countAfter = await countInvitations();
      expect(countAfter).toBe(countBefore);
    });
  });

  // =========================================================================
  // VAL-INV-004: Viewer cannot create an invitation
  // =========================================================================

  describe('VAL-INV-004: viewer cannot create invitation', () => {
    it('viewer gets 403 on POST; no invitation row created', async () => {
      const countBefore = await countInvitations();

      const res = await request(app)
        .post(url('/invitations'))
        .set(roleHeader('viewer'))
        .send({ email: 'invitee-004@test.com', role: 'member' })
        .expect(403);

      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

      const countAfter = await countInvitations();
      expect(countAfter).toBe(countBefore);
    });
  });

  // =========================================================================
  // VAL-INV-005: Invitation role assignment is honored
  // =========================================================================

  describe('VAL-INV-005: invitation role is honored', () => {
    it('can invite as owner', async () => {
      const res = await request(app)
        .post(url('/invitations'))
        .set(roleHeader('owner'))
        .send({ email: 'owner-role@test.com', role: 'owner' })
        .expect(201);
      expect(res.body.data.role).toBe('owner');
      const inv = await getInvitation(res.body.data.id);
      expect(inv?.role).toBe('owner');
    });

    it('can invite as admin', async () => {
      const res = await request(app)
        .post(url('/invitations'))
        .set(roleHeader('owner'))
        .send({ email: 'admin-role@test.com', role: 'admin' })
        .expect(201);
      expect(res.body.data.role).toBe('admin');
    });

    it('can invite as member', async () => {
      const res = await request(app)
        .post(url('/invitations'))
        .set(roleHeader('owner'))
        .send({ email: 'member-role@test.com', role: 'member' })
        .expect(201);
      expect(res.body.data.role).toBe('member');
    });

    it('can invite as viewer', async () => {
      const res = await request(app)
        .post(url('/invitations'))
        .set(roleHeader('owner'))
        .send({ email: 'viewer-role@test.com', role: 'viewer' })
        .expect(201);
      expect(res.body.data.role).toBe('viewer');
    });

    it('role defaults to member when omitted', async () => {
      const res = await request(app)
        .post(url('/invitations'))
        .set(roleHeader('owner'))
        .send({ email: 'default-role@test.com' })
        .expect(201);
      expect(res.body.data.role).toBe('member');
    });
  });

  // =========================================================================
  // VAL-INV-006: Duplicate pending invitation is rejected
  // =========================================================================

  describe('VAL-INV-006: duplicate pending invitation rejected (409)', () => {
    it('second pending invitation for same email+company gets 409', async () => {
      await request(app)
        .post(url('/invitations'))
        .set(roleHeader('owner'))
        .send({ email: 'dup-006@test.com', role: 'member' })
        .expect(201);

      const countBefore = await countInvitations();

      const res = await request(app)
        .post(url('/invitations'))
        .set(roleHeader('owner'))
        .send({ email: 'dup-006@test.com', role: 'admin' })
        .expect(409);

      expect(res.body.code).toBe('DUPLICATE_PENDING_INVITATION');

      const countAfter = await countInvitations();
      expect(countAfter).toBe(countBefore); // no new row
    });
  });

  // =========================================================================
  // VAL-INV-007: Invalid invitation email is rejected
  // =========================================================================

  describe('VAL-INV-007: invalid email returns 400', () => {
    it('invalid email format returns 400; no invitation persisted', async () => {
      const countBefore = await countInvitations();

      const res = await request(app)
        .post(url('/invitations'))
        .set(roleHeader('owner'))
        .send({ email: 'not-an-email', role: 'member' })
        .expect(400);

      expect(res.body.code).toBe('VALIDATION_ERROR');

      const countAfter = await countInvitations();
      expect(countAfter).toBe(countBefore);
    });

    it('empty email returns 400', async () => {
      await request(app)
        .post(url('/invitations'))
        .set(roleHeader('owner'))
        .send({ email: '', role: 'member' })
        .expect(400);
    });

    it('email without domain returns 400', async () => {
      await request(app)
        .post(url('/invitations'))
        .set(roleHeader('owner'))
        .send({ email: 'test@', role: 'member' })
        .expect(400);
    });
  });

  // =========================================================================
  // VAL-INV-008: Create response reports pending details
  // =========================================================================

  describe('VAL-INV-008: create response includes pending details', () => {
    it('response has id, companyId, email, role, status=pending, expiresAt', async () => {
      const res = await request(app)
        .post(url('/invitations'))
        .set(roleHeader('owner'))
        .send({ email: 'details-008@test.com', role: 'admin' })
        .expect(201);

      const data = res.body.data;
      expect(data.id).toBeDefined();
      expect(typeof data.id).toBe('string');
      expect(data.companyId).toBe(companyId);
      expect(data.email).toBe('details-008@test.com');
      expect(data.role).toBe('admin');
      expect(data.status).toBe('pending');
      expect(data.expiresAt).toBeDefined();
      expect(data.invitedByUserId).toBeDefined();

      // DB row matches
      const inv = await getInvitation(data.id);
      expect(inv?.status).toBe('pending');
      expect(inv?.email).toBe('details-008@test.com');
    });
  });

  // =========================================================================
  // VAL-INV-009: Invitation expiry is seven days ahead
  // =========================================================================

  describe('VAL-INV-009: expiresAt is ~7 days in the future', () => {
    it('expiresAt is within tolerance of now + 7 days', async () => {
      const beforeCreate = Date.now();

      const res = await request(app)
        .post(url('/invitations'))
        .set(roleHeader('owner'))
        .send({ email: 'expiry-009@test.com', role: 'member' })
        .expect(201);

      const afterCreate = Date.now();
      const expiresAt = new Date(res.body.data.expiresAt).getTime();
      const sevenDays = 7 * 24 * 60 * 60 * 1000;

      // expiresAt should be ~7 days from creation time (within 5 sec tolerance)
      expect(expiresAt).toBeGreaterThan(beforeCreate + sevenDays - 5000);
      expect(expiresAt).toBeLessThan(afterCreate + sevenDays + 5000);
    });
  });

  // =========================================================================
  // VAL-INV-010: Owner and admin list invitations
  // =========================================================================

  describe('VAL-INV-010: owner and admin can list invitations', () => {
    it('owner gets 2xx with all invitations', async () => {
      await seedInvitation('list-010a@test.com', 'member');
      await seedInvitation('list-010b@test.com', 'admin');

      const res = await request(app).get(url('/invitations')).set(roleHeader('owner')).expect(200);

      expect(res.body.data).toBeDefined();
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(2);

      // Each invitation has email, role, id, status, expiresAt
      for (const inv of res.body.data) {
        expect(inv.email).toBeDefined();
        expect(inv.role).toBeDefined();
        expect(inv.id).toBeDefined();
        expect(inv.status).toBeDefined();
        expect(inv.expiresAt).toBeDefined();
      }
    });

    it('admin gets 2xx with all invitations', async () => {
      await seedInvitation('list-010c@test.com', 'member');

      const res = await request(app).get(url('/invitations')).set(roleHeader('admin')).expect(200);

      expect(res.body.data).toBeDefined();
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  // =========================================================================
  // VAL-INV-011: Member and viewer cannot list invitations
  // =========================================================================

  describe('VAL-INV-011: member and viewer cannot list invitations', () => {
    it('member gets 403 on GET; no invitation records returned', async () => {
      await seedInvitation('list-011a@test.com', 'member');

      const res = await request(app).get(url('/invitations')).set(roleHeader('member')).expect(403);

      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
      expect(res.body).not.toHaveProperty('data');
    });

    it('viewer gets 403 on GET; no invitation records returned', async () => {
      await seedInvitation('list-011b@test.com', 'member');

      const res = await request(app).get(url('/invitations')).set(roleHeader('viewer')).expect(403);

      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
      expect(res.body).not.toHaveProperty('data');
    });
  });

  // =========================================================================
  // VAL-INV-012: Owner and admin revoke pending invitations
  // =========================================================================

  describe('VAL-INV-012: owner and admin can revoke pending invitations', () => {
    it('owner can DELETE pending invitation (2xx)', async () => {
      const inv = await seedInvitation('revoke-012a@test.com', 'member');

      const res = await request(app)
        .delete(url(`/invitations/${inv.id}`))
        .set(roleHeader('owner'))
        .expect(200);

      expect(res.body.data.status).toBe('revoked');

      const dbInv = await getInvitation(inv.id);
      expect(dbInv?.status).toBe('revoked');
    });

    it('admin can DELETE pending invitation (2xx)', async () => {
      const inv = await seedInvitation('revoke-012b@test.com', 'member');

      const res = await request(app)
        .delete(url(`/invitations/${inv.id}`))
        .set(roleHeader('admin'))
        .expect(200);

      expect(res.body.data.status).toBe('revoked');

      const dbInv = await getInvitation(inv.id);
      expect(dbInv?.status).toBe('revoked');
    });
  });

  // =========================================================================
  // VAL-INV-013: Revocation changes status to revoked
  // =========================================================================

  describe('VAL-INV-013: revocation changes status to revoked', () => {
    it('DELETE changes status from pending to revoked', async () => {
      const inv = await seedInvitation('status-013@test.com', 'member');
      expect(inv.status).toBe('pending');

      await request(app)
        .delete(url(`/invitations/${inv.id}`))
        .set(roleHeader('owner'))
        .expect(200);

      const dbInv = await getInvitation(inv.id);
      expect(dbInv?.status).toBe('revoked');

      // Verify in list response
      const listRes = await request(app)
        .get(url('/invitations'))
        .set(roleHeader('owner'))
        .expect(200);

      const listed = listRes.body.data.find((i: any) => i.id === inv.id);
      expect(listed.status).toBe('revoked');
    });
  });

  // =========================================================================
  // VAL-INV-014: Accepted invitations cannot be revoked
  // =========================================================================

  describe('VAL-INV-014: accepted invitation cannot be revoked', () => {
    it('DELETE on accepted invitation returns 409; status unchanged', async () => {
      const inv = await seedInvitation('accepted-014@test.com', 'member', {
        status: 'accepted',
        acceptedByUserId: 'user-accepted-014',
        acceptedAt: new Date(),
      });

      const res = await request(app)
        .delete(url(`/invitations/${inv.id}`))
        .set(roleHeader('owner'))
        .expect(409);

      expect(res.body.code).toBe('INVITATION_ALREADY_ACCEPTED');

      const dbInv = await getInvitation(inv.id);
      expect(dbInv?.status).toBe('accepted');
    });
  });

  // =========================================================================
  // VAL-INV-015: Matching Clerk signup creates membership
  // =========================================================================

  describe('VAL-INV-015: matching Clerk signup creates company_members row', () => {
    it('user.created webhook with matching email creates membership', async () => {
      await seedInvitation('webhook-015@test.com', 'member');

      const clerkUserId = 'user_webhook_015';
      const res = await request(app)
        .post('/api/webhooks/clerk')
        .send(clerkUserCreatedPayload(clerkUserId, 'webhook-015@test.com'))
        .expect(200);

      expect(res.body.received).toBe(true);

      const membership = await getMembership(companyId, clerkUserId);
      expect(membership).not.toBeNull();
      expect(membership?.companyId).toBe(companyId);

      // Invitation is no longer pending
      const invitations = await db.drizzle
        .select()
        .from(db.schema.companyInvitations)
        .where(
          and(
            eq(db.schema.companyInvitations.companyId, companyId),
            eq(db.schema.companyInvitations.email, 'webhook-015@test.com'),
          ),
        );
      expect(invitations[0].status).toBe('accepted');
    });
  });

  // =========================================================================
  // VAL-INV-016: Signup membership uses invitation role
  // =========================================================================

  describe('VAL-INV-016: membership role matches invitation role', () => {
    it('invitation with admin role → membership has admin role', async () => {
      await seedInvitation('role-016@test.com', 'admin');

      const clerkUserId = 'user_role_016';
      await request(app)
        .post('/api/webhooks/clerk')
        .send(clerkUserCreatedPayload(clerkUserId, 'role-016@test.com'))
        .expect(200);

      const membership = await getMembership(companyId, clerkUserId);
      expect(membership?.role).toBe('admin');
    });

    it('invitation with viewer role → membership has viewer role', async () => {
      await seedInvitation('role-016b@test.com', 'viewer');

      const clerkUserId = 'user_role_016b';
      await request(app)
        .post('/api/webhooks/clerk')
        .send(clerkUserCreatedPayload(clerkUserId, 'role-016b@test.com'))
        .expect(200);

      const membership = await getMembership(companyId, clerkUserId);
      expect(membership?.role).toBe('viewer');
    });
  });

  // =========================================================================
  // VAL-INV-017: Signup accepts invitation and records accepter
  // =========================================================================

  describe('VAL-INV-017: invitation transitions to accepted with metadata', () => {
    it('invitation has status=accepted, acceptedByUserId, non-null acceptedAt', async () => {
      const inv = await seedInvitation('accept-017@test.com', 'member');
      const beforeTime = new Date();

      const clerkUserId = 'user_accept_017';
      await request(app)
        .post('/api/webhooks/clerk')
        .send(clerkUserCreatedPayload(clerkUserId, 'accept-017@test.com'))
        .expect(200);

      const dbInv = await getInvitation(inv.id);
      expect(dbInv?.status).toBe('accepted');
      expect(dbInv?.acceptedByUserId).toBe(clerkUserId);
      expect(dbInv?.acceptedAt).not.toBeNull();
      expect(dbInv!.acceptedAt!.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime() - 1000);
    });
  });

  // =========================================================================
  // VAL-INV-018: Signup accepts invitations across companies
  // =========================================================================

  describe('VAL-INV-018: multiple invitations across companies all activate', () => {
    it('user with pending invitations in 2 companies gets memberships in both', async () => {
      const email = 'multi-018@test.com';
      const clerkUserId = 'user_multi_018';

      // Invitation in company A (companyId) with role=member
      await seedInvitation(email, 'member');

      // Invitation in company B with role=admin
      const companyB = 'co-multi-018';
      await seedOtherCompany(companyB, 'b-owner-018', 'owner');
      await db.drizzle.insert(db.schema.companyInvitations).values({
        companyId: companyB,
        email,
        role: 'admin',
        status: 'pending',
        invitedByUserId: 'b-owner-018',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });

      // Fire webhook
      await request(app)
        .post('/api/webhooks/clerk')
        .send(clerkUserCreatedPayload(clerkUserId, email))
        .expect(200);

      // Both memberships created with correct roles
      const membershipA = await getMembership(companyId, clerkUserId);
      expect(membershipA).not.toBeNull();
      expect(membershipA?.role).toBe('member');

      const membershipB = await getMembership(companyB, clerkUserId);
      expect(membershipB).not.toBeNull();
      expect(membershipB?.role).toBe('admin');

      // Both invitations accepted
      const invA = await db.drizzle
        .select()
        .from(db.schema.companyInvitations)
        .where(
          and(
            eq(db.schema.companyInvitations.companyId, companyId),
            eq(db.schema.companyInvitations.email, email),
          ),
        );
      expect(invA[0].status).toBe('accepted');

      const invB = await db.drizzle
        .select()
        .from(db.schema.companyInvitations)
        .where(
          and(
            eq(db.schema.companyInvitations.companyId, companyB),
            eq(db.schema.companyInvitations.email, email),
          ),
        );
      expect(invB[0].status).toBe('accepted');
    });
  });

  // =========================================================================
  // VAL-INV-019: No matching invitation → webhook succeeds, no action
  // =========================================================================

  describe('VAL-INV-019: no matching invitation → no action', () => {
    it('webhook for email with no invitations returns 2xx, no membership created', async () => {
      const clerkUserId = 'user_nomatch_019';

      const res = await request(app)
        .post('/api/webhooks/clerk')
        .send(clerkUserCreatedPayload(clerkUserId, 'nomatch-019@test.com'))
        .expect(200);

      expect(res.body.received).toBe(true);

      // No membership created
      const allMembers = await db.drizzle
        .select()
        .from(db.schema.companyMembers)
        .where(eq(db.schema.companyMembers.userId, clerkUserId));
      expect(allMembers.length).toBe(0);
    });
  });

  // =========================================================================
  // VAL-INV-020: Invalid webhook signature returns 401 in production mode
  // =========================================================================

  describe('VAL-INV-020: invalid signature returns 401 in production mode', () => {
    it('unsigned request in non-local-trusted mode returns 401', async () => {
      // Create a test server in production mode (not local_trusted)
      const prodApp = await createTestServer(db, 'production');

      const res = await request(prodApp)
        .post('/api/webhooks/clerk')
        .send(clerkUserCreatedPayload('user_bad_sig', 'badsig@test.com'))
        .expect(401);

      expect(res.body.code).toBe('WEBHOOK_VERIFICATION_FAILED');

      // No membership created
      const membership = await getMembership(companyId, 'user_bad_sig');
      expect(membership).toBeNull();
    });
  });

  // =========================================================================
  // VAL-INV-021: Local trusted mode simulates webhook without signature
  // =========================================================================

  describe('VAL-INV-021: local_trusted simulates webhook without signature', () => {
    it('unsigned simulated request in local_trusted mode is accepted (2xx)', async () => {
      await seedInvitation('local-021@test.com', 'member');

      const clerkUserId = 'user_local_021';
      const res = await request(app)
        .post('/api/webhooks/clerk')
        .send(clerkUserCreatedPayload(clerkUserId, 'local-021@test.com'))
        .expect(200);

      expect(res.body.received).toBe(true);

      // Membership created and invitation accepted
      const membership = await getMembership(companyId, clerkUserId);
      expect(membership).not.toBeNull();
      expect(membership?.role).toBe('member');
    });
  });

  // =========================================================================
  // VAL-INV-022: Expired invitation cannot be accepted via webhook
  // =========================================================================

  describe('VAL-INV-022: expired invitation cannot be accepted', () => {
    it('webhook for expired invitation does not create membership', async () => {
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day ago
      const inv = await seedInvitation('expired-022@test.com', 'member', {
        expiresAt: pastDate,
      });

      const clerkUserId = 'user_expired_022';
      await request(app)
        .post('/api/webhooks/clerk')
        .send(clerkUserCreatedPayload(clerkUserId, 'expired-022@test.com'))
        .expect(200);

      // No membership created
      const membership = await getMembership(companyId, clerkUserId);
      expect(membership).toBeNull();

      // Invitation remains pending (not accepted)
      const dbInv = await getInvitation(inv.id);
      expect(dbInv?.status).toBe('pending');
      expect(dbInv?.acceptedByUserId).toBeNull();
      expect(dbInv?.acceptedAt).toBeNull();
    });
  });

  // =========================================================================
  // VAL-INV-023: Non-members cannot perform invitation operations
  // =========================================================================

  describe('VAL-INV-023: non-members get 403 on all invitation operations', () => {
    it('non-member gets 403 on POST invitation', async () => {
      // User with membership in another company only (not the target)
      await seedOtherCompany('co-other-023', 'cross-user-023', 'owner');

      const res = await request(app)
        .post(url('/invitations'))
        .set(userHeader('cross-user-023'))
        .send({ email: 'nonmember-023@test.com', role: 'member' })
        .expect(403);

      expect(res.body).not.toHaveProperty('data');
    });

    it('non-member gets 403 on GET invitations', async () => {
      await seedInvitation('nonmember-list-023@test.com', 'member');
      await seedOtherCompany('co-other-023b', 'cross-user-023b', 'owner');

      const res = await request(app)
        .get(url('/invitations'))
        .set(userHeader('cross-user-023b'))
        .expect(403);

      expect(res.body).not.toHaveProperty('data');
    });

    it('non-member gets 403 on DELETE invitation', async () => {
      const inv = await seedInvitation('nonmember-revoke-023@test.com', 'member');
      await seedOtherCompany('co-other-023c', 'cross-user-023c', 'owner');

      const res = await request(app)
        .delete(url(`/invitations/${inv.id}`))
        .set(userHeader('cross-user-023c'))
        .expect(403);

      expect(res.body).not.toHaveProperty('data');

      // Invitation unchanged
      const dbInv = await getInvitation(inv.id);
      expect(dbInv?.status).toBe('pending');
    });
  });

  // =========================================================================
  // VAL-CROSS-001: Invitation creates a pending access grant
  // =========================================================================

  describe('VAL-CROSS-001: invitation creates pending access grant', () => {
    it('invitation persisted with pending status, role, expiration', async () => {
      const res = await request(app)
        .post(url('/invitations'))
        .set(roleHeader('owner'))
        .send({ email: 'cross-001@test.com', role: 'admin' })
        .expect(201);

      expect(res.body.data.status).toBe('pending');
      expect(res.body.data.role).toBe('admin');
      expect(res.body.data.expiresAt).toBeDefined();

      // Verify in list response
      const listRes = await request(app)
        .get(url('/invitations'))
        .set(roleHeader('owner'))
        .expect(200);

      const listed = listRes.body.data.find((i: any) => i.id === res.body.data.id);
      expect(listed).toBeDefined();
      expect(listed.status).toBe('pending');
      expect(listed.role).toBe('admin');
      expect(listed.expiresAt).toBeDefined();
    });

    it('unauthorized user (member) cannot create invitation', async () => {
      const res = await request(app)
        .post(url('/invitations'))
        .set(roleHeader('member'))
        .send({ email: 'cross-001b@test.com', role: 'member' })
        .expect(403);

      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });
  });

  // =========================================================================
  // VAL-CROSS-002: Clerk signup activates non-expired invitation (idempotent)
  // =========================================================================

  describe('VAL-CROSS-002: Clerk signup activates non-expired invitation', () => {
    it('user.created creates exactly one membership and transitions invitation', async () => {
      await seedInvitation('cross-002@test.com', 'member');

      const clerkUserId = 'user_cross_002';

      // First webhook
      await request(app)
        .post('/api/webhooks/clerk')
        .send(clerkUserCreatedPayload(clerkUserId, 'cross-002@test.com'))
        .expect(200);

      // Verify membership
      const membership = await getMembership(companyId, clerkUserId);
      expect(membership).not.toBeNull();
      expect(membership?.role).toBe('member');

      // Invitation is accepted
      const invitations = await db.drizzle
        .select()
        .from(db.schema.companyInvitations)
        .where(
          and(
            eq(db.schema.companyInvitations.companyId, companyId),
            eq(db.schema.companyInvitations.email, 'cross-002@test.com'),
          ),
        );
      expect(invitations[0].status).toBe('accepted');

      // Retry webhook — should be idempotent (no duplicate membership)
      await request(app)
        .post('/api/webhooks/clerk')
        .send(clerkUserCreatedPayload(clerkUserId, 'cross-002@test.com'))
        .expect(200);

      const allMemberships = await db.drizzle
        .select()
        .from(db.schema.companyMembers)
        .where(
          and(
            eq(db.schema.companyMembers.companyId, companyId),
            eq(db.schema.companyMembers.userId, clerkUserId),
          ),
        );
      expect(allMemberships.length).toBe(1);
    });
  });

  // =========================================================================
  // VAL-CROSS-003: Activated invitee can access the invited company
  // =========================================================================

  describe('VAL-CROSS-003: activated invitee can access invited company', () => {
    it('new member can access company-scoped resources with invited role', async () => {
      await seedInvitation('cross-003@test.com', 'member');

      const clerkUserId = 'user_cross_003';
      await request(app)
        .post('/api/webhooks/clerk')
        .send(clerkUserCreatedPayload(clerkUserId, 'cross-003@test.com'))
        .expect(200);

      // The new user can access company-scoped endpoint (members list)
      const membersRes = await request(app)
        .get(url('/members'))
        .set(userHeader(clerkUserId))
        .expect(200);
      expect(membersRes.body.data).toBeDefined();

      // The new user is in the member list
      const found = membersRes.body.data.find((m: any) => m.userId === clerkUserId);
      expect(found).toBeDefined();
      expect(found.role).toBe('member');

      // Member-level access works (agents list)
      const agentsRes = await request(app)
        .get(url('/agents'))
        .set(userHeader(clerkUserId))
        .expect(200);
      expect(agentsRes.status).toBe(200);
    });

    it('new member gets 403 on admin-only endpoint', async () => {
      await seedInvitation('cross-003b@test.com', 'member');

      const clerkUserId = 'user_cross_003b';
      await request(app)
        .post('/api/webhooks/clerk')
        .send(clerkUserCreatedPayload(clerkUserId, 'cross-003b@test.com'))
        .expect(200);

      // Member cannot access admin-only endpoint (integrations)
      const res = await request(app)
        .get(url('/integrations'))
        .set(userHeader(clerkUserId))
        .expect(403);
      expect(res.body).not.toHaveProperty('data');
    });
  });

  // =========================================================================
  // VAL-CROSS-009: Invitation acceptance followed by promotion → admin access
  // =========================================================================

  describe('VAL-CROSS-009: invite → accept → promote grants admin access', () => {
    it('member invited, activated, promoted to admin can access admin endpoints', async () => {
      await seedInvitation('cross-009@test.com', 'member');

      const clerkUserId = 'user_cross_009';

      // Step 1: Activate via webhook
      await request(app)
        .post('/api/webhooks/clerk')
        .send(clerkUserCreatedPayload(clerkUserId, 'cross-009@test.com'))
        .expect(200);

      // Step 2: Before promotion, member gets 403 on admin-only endpoint
      const beforeRes = await request(app)
        .get(url('/integrations'))
        .set(userHeader(clerkUserId))
        .expect(403);
      expect(beforeRes.body).not.toHaveProperty('data');

      // Step 3: Owner promotes member to admin
      await request(app)
        .patch(url(`/members/${clerkUserId}/role`))
        .set(roleHeader('owner'))
        .send({ role: 'admin' })
        .expect(200);

      // Step 4: After promotion, admin can access admin-only endpoint
      const afterRes = await request(app)
        .get(url('/integrations'))
        .set(userHeader(clerkUserId))
        .expect(200);
      expect(afterRes.status).toBe(200);

      // Verify DB role
      const membership = await getMembership(companyId, clerkUserId);
      expect(membership?.role).toBe('admin');
    });
  });

  // =========================================================================
  // VAL-CROSS-014: Expired invitations do not activate on signup
  // =========================================================================

  describe('VAL-CROSS-014: expired invitations do not activate', () => {
    it('expired invitation → no membership, invitation remains non-activatable', async () => {
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const inv = await seedInvitation('cross-014@test.com', 'member', {
        expiresAt: pastDate,
      });

      const clerkUserId = 'user_cross_014';
      await request(app)
        .post('/api/webhooks/clerk')
        .send(clerkUserCreatedPayload(clerkUserId, 'cross-014@test.com'))
        .expect(200);

      // No membership
      const membership = await getMembership(companyId, clerkUserId);
      expect(membership).toBeNull();

      // Invitation remains pending (not accepted)
      const dbInv = await getInvitation(inv.id);
      expect(dbInv?.status).toBe('pending');
      expect(dbInv?.acceptedByUserId).toBeNull();
    });
  });

  // =========================================================================
  // VAL-CROSS-015: Revoked invitations do not activate on signup
  // =========================================================================

  describe('VAL-CROSS-015: revoked invitations do not activate', () => {
    it('revoked invitation → webhook does not create membership', async () => {
      const inv = await seedInvitation('cross-015@test.com', 'member', {
        status: 'revoked',
      });

      const clerkUserId = 'user_cross_015';
      await request(app)
        .post('/api/webhooks/clerk')
        .send(clerkUserCreatedPayload(clerkUserId, 'cross-015@test.com'))
        .expect(200);

      // No membership
      const membership = await getMembership(companyId, clerkUserId);
      expect(membership).toBeNull();

      // Invitation remains revoked
      const dbInv = await getInvitation(inv.id);
      expect(dbInv?.status).toBe('revoked');
    });

    it('owner revokes invitation → subsequent signup does not activate', async () => {
      // Create invitation via API
      const createRes = await request(app)
        .post(url('/invitations'))
        .set(roleHeader('owner'))
        .send({ email: 'cross-015b@test.com', role: 'member' })
        .expect(201);

      // Owner revokes it
      await request(app)
        .delete(url(`/invitations/${createRes.body.data.id}`))
        .set(roleHeader('owner'))
        .expect(200);

      // User signs up via webhook
      const clerkUserId = 'user_cross_015b';
      await request(app)
        .post('/api/webhooks/clerk')
        .send(clerkUserCreatedPayload(clerkUserId, 'cross-015b@test.com'))
        .expect(200);

      // No membership created
      const membership = await getMembership(companyId, clerkUserId);
      expect(membership).toBeNull();

      // Invitation remains revoked
      const dbInv = await getInvitation(createRes.body.data.id);
      expect(dbInv?.status).toBe('revoked');
    });
  });

  // =========================================================================
  // Additional edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('revoking a non-existent invitation returns 404', async () => {
      const res = await request(app)
        .delete(url('/invitations/nonexistent-id'))
        .set(roleHeader('owner'))
        .expect(404);

      expect(res.body.code).toBe('INVITATION_NOT_FOUND');
    });

    it('revoking an invitation from another company returns 404', async () => {
      // Create invitation in another company
      const companyB = 'co-edge-001';
      await seedOtherCompany(companyB, 'b-owner-001', 'owner');
      const [invB] = await db.drizzle
        .insert(db.schema.companyInvitations)
        .values({
          companyId: companyB,
          email: 'cross-company@test.com',
          role: 'member',
          status: 'pending',
          invitedByUserId: 'b-owner-001',
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        })
        .returning();

      // Owner of company A tries to revoke company B's invitation
      const res = await request(app)
        .delete(url(`/invitations/${invB.id}`))
        .set(roleHeader('owner'))
        .expect(404);

      expect(res.body.code).toBe('INVITATION_NOT_FOUND');

      // Invitation in company B is unchanged
      const dbInv = await getInvitation(invB.id);
      expect(dbInv?.status).toBe('pending');
    });

    it('revoking an already-revoked invitation is idempotent (200)', async () => {
      const inv = await seedInvitation('idempotent@test.com', 'member', {
        status: 'revoked',
      });

      const res = await request(app)
        .delete(url(`/invitations/${inv.id}`))
        .set(roleHeader('owner'))
        .expect(200);

      expect(res.body.data.status).toBe('revoked');
    });

    it('webhook with no email addresses succeeds with no action', async () => {
      const payload = {
        type: 'user.created',
        object: 'event',
        data: {
          id: 'user-no-email',
          object: 'user',
          email_addresses: [],
          primary_email_address_id: null,
        },
      };

      const res = await request(app).post('/api/webhooks/clerk').send(payload).expect(200);

      expect(res.body.received).toBe(true);
    });

    it('webhook for non-user.created event succeeds with no action', async () => {
      const payload = {
        type: 'session.created',
        object: 'event',
        data: { id: 'sess-001' },
      };

      const res = await request(app).post('/api/webhooks/clerk').send(payload).expect(200);

      expect(res.body.received).toBe(true);
    });
  });
});
