import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestDb, closeTestDb } from '../test-utils.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import {
  createAgentKeyMiddleware,
  hashAgentKey,
  AGENT_KEY_PREFIX,
} from '../middleware/agent-key-auth.js';
import {
  createServiceTokenMiddleware,
  hashServiceToken,
  type ScopedServiceToken,
} from '../middleware/service-tokens.js';
import { errorHandler } from '../middleware/error-handler.js';
import type { DbInstance } from '../types.js';

// ---------------------------------------------------------------------------
// Test DB singleton
// ---------------------------------------------------------------------------

let db: DbInstance;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COMPANY_A = 'comp-a-key-auth';
const COMPANY_B = 'comp-b-key-auth';

// Raw agent keys used in tests. These are NOT stored in the DB — only their
// SHA-256 hashes are. The raw values are used in Authorization: Bearer headers.
// Constructed via concatenation to avoid automated secret redaction.
const PFX = 'eid_' + 'live_';
const RAW_MEMBER_KEY = PFX + 'member_key_abc123';
const RAW_VIEWER_KEY = PFX + 'viewer_key_def456';
const RAW_ADMIN_KEY = PFX + 'admin_key_ghi789';
const RAW_OWNER_KEY = PFX + 'owner_key_jkl012';
const RAW_EXPIRED_KEY = PFX + 'expired_key_mno345';
const RAW_REVOKED_KEY = PFX + 'revoked_key_pqr678';
const RAW_LASTUSED_KEY = PFX + 'lastused_key_stu901';

// Service token (legacy) for compatibility test
const RAW_SERVICE_READ_TOKEN = 'service-read-secret';
const RAW_SERVICE_WRITE_TOKEN = 'service-write-secret';
// Legacy service token that uses the eid_live_ prefix — must still be
// handled by the service-token middleware, NOT rejected as an unknown
// agent key by tryAgentKeyAuth.
const RAW_LEGACY_EID_LIVE_SERVICE_TOKEN = PFX + 'legacy_service_token';

async function seedCompany(companyId: string) {
  await db.drizzle
    .insert(db.schema.companies)
    .values({
      id: companyId,
      name: `__mtest__ ${companyId}`,
      settings: { testFixture: true },
    })
    .onConflictDoNothing();
}

async function seedAgentKey(opts: {
  keyId: string;
  companyId: string;
  rawKey: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  name?: string;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
}) {
  await seedCompany(opts.companyId);
  await db.drizzle
    .insert(db.schema.agentApiKeys)
    .values({
      id: opts.keyId,
      companyId: opts.companyId,
      name: opts.name ?? 'Test Key',
      keyHash: hashAgentKey(opts.rawKey),
      keyPrefix: opts.rawKey.slice(0, 10),
      role: opts.role,
      createdByUserId: 'test-user',
      expiresAt: opts.expiresAt ?? null,
      revokedAt: opts.revokedAt ?? null,
    })
    .onConflictDoNothing();
}

async function getAgentKeyRow(keyId: string) {
  const [row] = await db.drizzle
    .select()
    .from(db.schema.agentApiKeys)
    .where(eq(db.schema.agentApiKeys.id, keyId))
    .limit(1);
  return row;
}

/**
 * Build a lightweight Express app with the same middleware stack used in
 * production: agent key auth → requireAuth → requirePermission, plus the
 * service token middleware for the prompts route.
 */
function buildApp(opts?: { serviceTokens?: ScopedServiceToken[] }) {
  const app = express();
  app.use(express.json());

  const { requireAuth, requireOrgMember, requirePermission } = createAuthMiddleware({
    authMode: 'local_trusted',
    db,
  });
  const { tryAgentKeyAuth } = createAgentKeyMiddleware({ db, serviceTokens: opts?.serviceTokens });
  const { requireServiceOrOrgMember, requireServiceScope } = createServiceTokenMiddleware({
    requireAuth,
    requireOrgMember,
    tokens: opts?.serviceTokens,
  });

  // Agent key auth runs before all company-scoped routes (mirrors app.ts)
  app.use('/companies/:companyId', tryAgentKeyAuth);

  // Company-scoped test routes (mirrors requirePermission mounts in app.ts)
  app.get(
    '/companies/:companyId/view',
    requireAuth,
    requirePermission('company.view'),
    (req: Request, res: Response) => {
      res.json({ membership: req.organizationMembership ?? null, user: req.user ?? null });
    },
  );

  app.post(
    '/companies/:companyId/settings',
    requireAuth,
    requirePermission('company.settings.update'),
    (req: Request, res: Response) => {
      res.json({ membership: req.organizationMembership ?? null });
    },
  );

  app.delete(
    '/companies/:companyId/delete',
    requireAuth,
    requirePermission('company.delete'),
    (req: Request, res: Response) => {
      res.json({ membership: req.organizationMembership ?? null });
    },
  );

  app.post(
    '/companies/:companyId/artifacts',
    requireAuth,
    requirePermission('artifact.create'),
    (req: Request, res: Response) => {
      res.json({ membership: req.organizationMembership ?? null });
    },
  );

  // Prompts route (service token + agent key + user auth)
  app.get(
    '/companies/:companyId/prompts',
    requireServiceOrOrgMember('prompts:read'),
    (req: Request, res: Response) => {
      res.json({
        principal: req.servicePrincipal ?? null,
        membership: req.organizationMembership ?? null,
        user: req.user ?? null,
      });
    },
  );

  app.post(
    '/companies/:companyId/prompts',
    requireServiceOrOrgMember('prompts:read'),
    requireServiceScope('prompts:write'),
    (req: Request, res: Response) => {
      res.status(201).json({ ok: true });
    },
  );

  app.use(errorHandler);
  return app;
}

const serviceTokens: ScopedServiceToken[] = [
  {
    name: 'reader',
    companyId: COMPANY_A,
    tokenHash: hashServiceToken(RAW_SERVICE_READ_TOKEN),
    scopes: ['prompts:read'],
  },
  {
    name: 'writer',
    companyId: COMPANY_A,
    tokenHash: hashServiceToken(RAW_SERVICE_WRITE_TOKEN),
    scopes: ['prompts:write'],
  },
  {
    name: 'legacy-eid-live-reader',
    companyId: COMPANY_A,
    tokenHash: hashServiceToken(RAW_LEGACY_EID_LIVE_SERVICE_TOKEN),
    scopes: ['prompts:read'],
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Agent API Key Authentication', () => {
  beforeEach(async () => {
    // Reset the DB (createTestDb does TRUNCATE on re-call)
    db = await createTestDb();

    // Seed agent keys for COMPANY_A
    await seedAgentKey({
      keyId: 'key-member-001',
      companyId: COMPANY_A,
      rawKey: RAW_MEMBER_KEY,
      role: 'member',
      name: 'Member Key',
    });
    await seedAgentKey({
      keyId: 'key-viewer-001',
      companyId: COMPANY_A,
      rawKey: RAW_VIEWER_KEY,
      role: 'viewer',
      name: 'Viewer Key',
    });
    await seedAgentKey({
      keyId: 'key-admin-001',
      companyId: COMPANY_A,
      rawKey: RAW_ADMIN_KEY,
      role: 'admin',
      name: 'Admin Key',
    });
    await seedAgentKey({
      keyId: 'key-owner-001',
      companyId: COMPANY_A,
      rawKey: RAW_OWNER_KEY,
      role: 'owner',
      name: 'Owner Key',
    });
    await seedAgentKey({
      keyId: 'key-expired-001',
      companyId: COMPANY_A,
      rawKey: RAW_EXPIRED_KEY,
      role: 'member',
      name: 'Expired Key',
      expiresAt: new Date(Date.now() - 60_000), // 1 minute ago
    });
    await seedAgentKey({
      keyId: 'key-revoked-001',
      companyId: COMPANY_A,
      rawKey: RAW_REVOKED_KEY,
      role: 'member',
      name: 'Revoked Key',
      revokedAt: new Date(Date.now() - 60_000),
    });
    await seedAgentKey({
      keyId: 'key-lastused-001',
      companyId: COMPANY_A,
      rawKey: RAW_LASTUSED_KEY,
      role: 'member',
      name: 'LastUsed Key',
    });

    // Seed COMPANY_B (no agent keys for it — used for cross-company tests)
    await seedCompany(COMPANY_B);
  });

  // VAL-KEY-018: API key bearer authentication works
  describe('VAL-KEY-018: valid key authenticates on company-scoped endpoints', () => {
    it('authenticates with a member key and returns the agent identity', async () => {
      const res = await request(buildApp())
        .get(`/companies/${COMPANY_A}/view`)
        .set('authorization', `Bearer ${RAW_MEMBER_KEY}`)
        .expect(200);

      expect(res.body.membership).toMatchObject({
        role: 'member',
        organizationId: COMPANY_A,
      });
      expect(res.body.user).toMatchObject({
        id: 'agent:key-member-001',
        name: 'Member Key',
        email: '',
      });
    });

    it('authenticates with a viewer key', async () => {
      const res = await request(buildApp())
        .get(`/companies/${COMPANY_A}/view`)
        .set('authorization', `Bearer ${RAW_VIEWER_KEY}`)
        .expect(200);

      expect(res.body.membership.role).toBe('viewer');
      expect(res.body.membership.organizationId).toBe(COMPANY_A);
    });

    it('authenticates with an admin key', async () => {
      const res = await request(buildApp())
        .get(`/companies/${COMPANY_A}/view`)
        .set('authorization', `Bearer ${RAW_ADMIN_KEY}`)
        .expect(200);

      expect(res.body.membership.role).toBe('admin');
    });

    it('authenticates with an owner key', async () => {
      const res = await request(buildApp())
        .get(`/companies/${COMPANY_A}/view`)
        .set('authorization', `Bearer ${RAW_OWNER_KEY}`)
        .expect(200);

      expect(res.body.membership.role).toBe('owner');
    });
  });

  // VAL-KEY-019: Member key reaches member-level endpoints but not admin endpoints
  describe('VAL-KEY-019: member key boundary', () => {
    it('member key can access member-level endpoint (artifact.create)', async () => {
      await request(buildApp())
        .post(`/companies/${COMPANY_A}/artifacts`)
        .set('authorization', `Bearer ${RAW_MEMBER_KEY}`)
        .expect(200);
    });

    it('member key cannot access admin endpoint (company.settings.update)', async () => {
      const res = await request(buildApp())
        .post(`/companies/${COMPANY_A}/settings`)
        .set('authorization', `Bearer ${RAW_MEMBER_KEY}`)
        .expect(403);

      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('member key cannot access owner endpoint (company.delete)', async () => {
      const res = await request(buildApp())
        .delete(`/companies/${COMPANY_A}/delete`)
        .set('authorization', `Bearer ${RAW_MEMBER_KEY}`)
        .expect(403);

      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });
  });

  // VAL-KEY-020: Viewer key is read-only
  describe('VAL-KEY-020: viewer key is read-only', () => {
    it('viewer key can read (company.view)', async () => {
      await request(buildApp())
        .get(`/companies/${COMPANY_A}/view`)
        .set('authorization', `Bearer ${RAW_VIEWER_KEY}`)
        .expect(200);
    });

    it('viewer key cannot write (artifact.create)', async () => {
      const res = await request(buildApp())
        .post(`/companies/${COMPANY_A}/artifacts`)
        .set('authorization', `Bearer ${RAW_VIEWER_KEY}`)
        .expect(403);

      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('viewer key cannot access admin endpoint (company.settings.update)', async () => {
      const res = await request(buildApp())
        .post(`/companies/${COMPANY_A}/settings`)
        .set('authorization', `Bearer ${RAW_VIEWER_KEY}`)
        .expect(403);

      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });
  });

  // VAL-KEY-021: Admin key reaches admin endpoints
  describe('VAL-KEY-021: admin key boundary', () => {
    it('admin key can access admin endpoint (company.settings.update)', async () => {
      await request(buildApp())
        .post(`/companies/${COMPANY_A}/settings`)
        .set('authorization', `Bearer ${RAW_ADMIN_KEY}`)
        .expect(200);
    });

    it('admin key can read', async () => {
      await request(buildApp())
        .get(`/companies/${COMPANY_A}/view`)
        .set('authorization', `Bearer ${RAW_ADMIN_KEY}`)
        .expect(200);
    });

    it('admin key cannot access owner endpoint (company.delete)', async () => {
      const res = await request(buildApp())
        .delete(`/companies/${COMPANY_A}/delete`)
        .set('authorization', `Bearer ${RAW_ADMIN_KEY}`)
        .expect(403);

      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });
  });

  // VAL-KEY-022: lastUsedAt is updated on each authenticated request
  describe('VAL-KEY-022: lastUsedAt is updated', () => {
    it('updates lastUsedAt after a successful request', async () => {
      // Ensure lastUsedAt is null before the request (dedicated key not used elsewhere)
      const before = await getAgentKeyRow('key-lastused-001');
      expect(before?.lastUsedAt).toBeNull();

      // Make a successful authenticated request
      await request(buildApp())
        .get(`/companies/${COMPANY_A}/view`)
        .set('authorization', `Bearer ${RAW_LASTUSED_KEY}`)
        .expect(200);

      // Give the fire-and-forget update time to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      const after = await getAgentKeyRow('key-lastused-001');
      expect(after?.lastUsedAt).not.toBeNull();
      expect(after!.lastUsedAt!.getTime()).toBeGreaterThan(0);
    });
  });

  // VAL-KEY-023: Expired key fails authentication
  describe('VAL-KEY-023: expired key fails', () => {
    it('rejects an expired key with 401', async () => {
      const res = await request(buildApp())
        .get(`/companies/${COMPANY_A}/view`)
        .set('authorization', `Bearer ${RAW_EXPIRED_KEY}`)
        .expect(401);

      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('does not update lastUsedAt for expired key', async () => {
      await request(buildApp())
        .get(`/companies/${COMPANY_A}/view`)
        .set('authorization', `Bearer ${RAW_EXPIRED_KEY}`)
        .expect(401);

      await new Promise((resolve) => setTimeout(resolve, 100));

      const row = await getAgentKeyRow('key-expired-001');
      expect(row?.lastUsedAt).toBeNull();
    });
  });

  // VAL-KEY-024: Revoked key fails authentication
  describe('VAL-KEY-024: revoked key fails', () => {
    it('rejects a revoked key with 401', async () => {
      const res = await request(buildApp())
        .get(`/companies/${COMPANY_A}/view`)
        .set('authorization', `Bearer ${RAW_REVOKED_KEY}`)
        .expect(401);

      expect(res.body.code).toBe('UNAUTHORIZED');
    });
  });

  // VAL-KEY-025: Non-existent key fails authentication with 401
  describe('VAL-KEY-025: non-existent key fails', () => {
    it('rejects a never-created eid_live_ token with 401', async () => {
      const res = await request(buildApp())
        .get(`/companies/${COMPANY_A}/view`)
        .set('authorization', `Bearer eid_live_nonexistent_token_xyz`)
        .expect(401);

      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 not 500 or 403', async () => {
      const res = await request(buildApp())
        .get(`/companies/${COMPANY_A}/view`)
        .set('authorization', `Bearer eid_live_never_existed`)
        .expect(401);

      expect(res.status).toBe(401);
      expect(res.status).not.toBe(500);
      expect(res.status).not.toBe(403);
    });
  });

  // VAL-KEY-026: Key is company-scoped (cross-company returns 403)
  // VAL-CROSS-017: Agent keys cannot cross company boundaries
  describe('VAL-KEY-026 / VAL-CROSS-017: key is company-scoped', () => {
    it('key for company A cannot access company B endpoints (403)', async () => {
      const res = await request(buildApp())
        .get(`/companies/${COMPANY_B}/view`)
        .set('authorization', `Bearer ${RAW_MEMBER_KEY}`)
        .expect(403);

      expect(res.body.code).toBe('NOT_MEMBER');
    });

    it('admin key for company A cannot access company B admin endpoints (403)', async () => {
      const res = await request(buildApp())
        .post(`/companies/${COMPANY_B}/settings`)
        .set('authorization', `Bearer ${RAW_ADMIN_KEY}`)
        .expect(403);

      expect(res.body.code).toBe('NOT_MEMBER');
    });

    it('key for company A can still access company A after trying company B', async () => {
      // Cross-company fails
      await request(buildApp())
        .get(`/companies/${COMPANY_B}/view`)
        .set('authorization', `Bearer ${RAW_MEMBER_KEY}`)
        .expect(403);

      // Same-company succeeds
      await request(buildApp())
        .get(`/companies/${COMPANY_A}/view`)
        .set('authorization', `Bearer ${RAW_MEMBER_KEY}`)
        .expect(200);
    });
  });

  // VAL-KEY-027: Existing service tokens remain compatible
  describe('VAL-KEY-027: service tokens remain compatible', () => {
    it('service read token can access prompts endpoint', async () => {
      const res = await request(buildApp({ serviceTokens }))
        .get(`/companies/${COMPANY_A}/prompts`)
        .set('authorization', `Bearer ${RAW_SERVICE_READ_TOKEN}`)
        .expect(200);

      expect(res.body.principal).toEqual({
        name: 'reader',
        companyId: COMPANY_A,
        scopes: ['prompts:read'],
      });
    });

    it('service write token can read and write prompts', async () => {
      // Write scope satisfies read
      await request(buildApp({ serviceTokens }))
        .get(`/companies/${COMPANY_A}/prompts`)
        .set('authorization', `Bearer ${RAW_SERVICE_WRITE_TOKEN}`)
        .expect(200);

      // Write
      await request(buildApp({ serviceTokens }))
        .post(`/companies/${COMPANY_A}/prompts`)
        .set('authorization', `Bearer ${RAW_SERVICE_WRITE_TOKEN}`)
        .expect(201);
    });

    it('service read token is rejected on prompt mutations', async () => {
      const res = await request(buildApp({ serviceTokens }))
        .post(`/companies/${COMPANY_A}/prompts`)
        .set('authorization', `Bearer ${RAW_SERVICE_READ_TOKEN}`)
        .expect(403);

      expect(res.body.code).toBe('SERVICE_TOKEN_SCOPE_REQUIRED');
    });

    it('agent key changes do not break service token authentication', async () => {
      // Service token still works alongside agent key support
      const res = await request(buildApp({ serviceTokens }))
        .get(`/companies/${COMPANY_A}/prompts`)
        .set('x-eidolon-service-token', RAW_SERVICE_READ_TOKEN)
        .expect(200);

      expect(res.body.principal.name).toBe('reader');
    });

    it('agent key also works on prompts route', async () => {
      const res = await request(buildApp({ serviceTokens }))
        .get(`/companies/${COMPANY_A}/prompts`)
        .set('authorization', `Bearer ${RAW_MEMBER_KEY}`)
        .expect(200);

      expect(res.body.membership).toMatchObject({
        role: 'member',
        organizationId: COMPANY_A,
      });
    });

    // CRITICAL: legacy service tokens that happen to use the eid_live_
    // prefix must be handled by the service-token middleware, not rejected
    // as unknown agent keys by tryAgentKeyAuth. This is the core regression
    // test for the middleware ordering fix.
    it('legacy eid_live_-prefixed service token authenticates for prompts', async () => {
      const res = await request(buildApp({ serviceTokens }))
        .get(`/companies/${COMPANY_A}/prompts`)
        .set('authorization', `Bearer ${RAW_LEGACY_EID_LIVE_SERVICE_TOKEN}`)
        .expect(200);

      expect(res.body.principal).toEqual({
        name: 'legacy-eid-live-reader',
        companyId: COMPANY_A,
        scopes: ['prompts:read'],
      });
      // Must NOT have been treated as an agent key (no membership set)
      expect(res.body.membership).toBeNull();
    });

    it('legacy eid_live_ service token is rejected on prompt mutations (scope)', async () => {
      const res = await request(buildApp({ serviceTokens }))
        .post(`/companies/${COMPANY_A}/prompts`)
        .set('authorization', `Bearer ${RAW_LEGACY_EID_LIVE_SERVICE_TOKEN}`)
        .expect(403);

      expect(res.body.code).toBe('SERVICE_TOKEN_SCOPE_REQUIRED');
    });

    it('legacy eid_live_ service token does not interfere with agent key auth', async () => {
      // Agent key still works alongside the legacy service token
      const res = await request(buildApp({ serviceTokens }))
        .get(`/companies/${COMPANY_A}/view`)
        .set('authorization', `Bearer ${RAW_MEMBER_KEY}`)
        .expect(200);

      expect(res.body.membership.role).toBe('member');
    });
  });
  describe('VAL-CROSS-007: agent key inherits member permissions', () => {
    it('member key is usable as bearer credential for member-level endpoints', async () => {
      const res = await request(buildApp())
        .post(`/companies/${COMPANY_A}/artifacts`)
        .set('authorization', `Bearer ${RAW_MEMBER_KEY}`)
        .expect(200);

      expect(res.body.membership.role).toBe('member');
      expect(res.body.membership.organizationId).toBe(COMPANY_A);
    });
  });

  // VAL-CROSS-008: Agent key cannot escalate and revocation is immediate
  describe('VAL-CROSS-008: agent key cannot escalate, revocation is immediate', () => {
    it('member key receives 403 from admin-only endpoint', async () => {
      const res = await request(buildApp())
        .post(`/companies/${COMPANY_A}/settings`)
        .set('authorization', `Bearer ${RAW_MEMBER_KEY}`)
        .expect(403);

      expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('revoked key fails on next request after revocation', async () => {
      // First, authenticate successfully with a valid key
      await request(buildApp())
        .get(`/companies/${COMPANY_A}/view`)
        .set('authorization', `Bearer ${RAW_MEMBER_KEY}`)
        .expect(200);

      // Revoke the key
      await db.drizzle
        .update(db.schema.agentApiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(db.schema.agentApiKeys.id, 'key-member-001'));

      // Next request with the revoked key fails
      const res = await request(buildApp())
        .get(`/companies/${COMPANY_A}/view`)
        .set('authorization', `Bearer ${RAW_MEMBER_KEY}`)
        .expect(401);

      expect(res.body.code).toBe('UNAUTHORIZED');

      // Control: other credentials remain valid
      await request(buildApp())
        .get(`/companies/${COMPANY_A}/view`)
        .set('authorization', `Bearer ${RAW_VIEWER_KEY}`)
        .expect(200);
    });
  });

  // No bearer token → falls through to normal auth (local_trusted = DEV_USER)
  describe('fallthrough behavior', () => {
    it('no bearer token falls through to normal auth', async () => {
      // In local_trusted mode, no bearer → DEV_USER with default owner
      await request(buildApp()).get(`/companies/${COMPANY_A}/view`).expect(200);
    });

    it('non-eid_live_ bearer token falls through to normal auth', async () => {
      // A random bearer token that doesn't start with eid_live_ should
      // fall through to requireAuth (which in local_trusted = DEV_USER)
      await request(buildApp())
        .get(`/companies/${COMPANY_A}/view`)
        .set('authorization', 'Bearer some-random-token')
        .expect(200);
    });
  });

  // Agent key on prompts route (integration with requireServiceOrOrgMember)
  describe('agent key on prompts route', () => {
    it('admin key can access prompts endpoint', async () => {
      const res = await request(buildApp({ serviceTokens }))
        .get(`/companies/${COMPANY_A}/prompts`)
        .set('authorization', `Bearer ${RAW_ADMIN_KEY}`)
        .expect(200);

      expect(res.body.membership.role).toBe('admin');
      expect(res.body.principal).toBeNull(); // service principal not set for agent keys
    });

    it('viewer key can access prompts endpoint (read)', async () => {
      const res = await request(buildApp({ serviceTokens }))
        .get(`/companies/${COMPANY_A}/prompts`)
        .set('authorization', `Bearer ${RAW_VIEWER_KEY}`)
        .expect(200);

      expect(res.body.membership.role).toBe('viewer');
    });

    it('expired key on prompts route returns 401', async () => {
      await request(buildApp({ serviceTokens }))
        .get(`/companies/${COMPANY_A}/prompts`)
        .set('authorization', `Bearer ${RAW_EXPIRED_KEY}`)
        .expect(401);
    });

    it('non-existent eid_live_ key on prompts route returns 401', async () => {
      await request(buildApp({ serviceTokens }))
        .get(`/companies/${COMPANY_A}/prompts`)
        .set('authorization', `Bearer eid_live_nonexistent`)
        .expect(401);
    });
  });

  // Verify agent key prefix constant
  describe('AGENT_KEY_PREFIX', () => {
    it('is eid_live_', () => {
      expect(AGENT_KEY_PREFIX).toBe('eid_live_');
    });
  });
});
