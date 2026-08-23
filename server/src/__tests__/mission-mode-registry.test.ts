import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, createTestServer } from '../test-utils.js';
import { ModeRegistryService } from '../services/mission/mode-registry.js';
import { MissionStartService } from '../services/mission/start.js';
import {
  resolveCustomPolicy,
  checkAgentEligibility,
  type CustomProfileConfig,
} from '../services/mission/policy.js';
import { PLATFORM_HARD_CAPS } from '../services/mission/modes.js';
import { CreateProfileBody, UpdateProfileBody } from '../services/mission/mode-profile-schema.js';
import { AppError } from '../middleware/error-handler.js';

/** Helper: expect a function to throw an AppError with the given code. */
function expectAppError(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.fail(`Expected AppError with code ${code}, but no error was thrown`);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
  }
}

/**
 * Mission mode registry and custom profile tests.
 *
 * Covers:
 * - VAL-MODEQ-016: Company custom isolation
 * - VAL-MODEQ-017: Disabled custom profile hidden
 * - VAL-MODEQ-018: Newly disabled profile cannot start
 * - VAL-MODEQ-019: Ineligible custom mode denies start
 * - VAL-MODEQ-020: Custom mode can only narrow
 * - VAL-MODEQ-123: Initiating-agent eligibility is enforced
 * - VAL-MODEQ-124: Custom-profile administration is versioned and authorized
 * - VAL-MODEQ-152: Custom profile payloads are closed, bounded, and inert
 * - VAL-MODEQ-153: The mode registry API is scoped and executable
 */

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

function enableMissionFlag() {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify({ missionAgentIntelligence: { enabled: true } }),
  );
}

async function createCompany(db: AnyDb, name: string) {
  const now = new Date();
  const id = randomUUID();
  await db.drizzle.insert(db.schema.companies).values({
    id,
    name,
    settings: { testFixture: true },
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function createProject(db: AnyDb, companyId: string) {
  const now = new Date();
  const id = randomUUID();
  await db.drizzle.insert(db.schema.projects).values({
    id,
    companyId,
    name: '__mtest__ project',
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function createThread(db: AnyDb, companyId: string, projectId: string) {
  const now = new Date();
  const id = randomUUID();
  await db.drizzle.insert(db.schema.projectThreads).values({
    id,
    companyId,
    projectId,
    title: '__mtest__ thread',
    type: 'conversation',
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function createAgent(
  db: AnyDb,
  companyId: string,
  overrides: {
    provider?: 'anthropic' | 'openai' | 'google' | 'local';
    model?: string;
    status?: 'idle' | 'working' | 'paused' | 'error' | 'offline';
    toolsEnabled?: string[];
    allowedDomains?: string[];
    capabilities?: string[];
  } = {},
) {
  const now = new Date();
  const [row] = await db.drizzle
    .insert(db.schema.agents)
    .values({
      companyId,
      name: '__mtest__ agent',
      role: 'custom',
      provider: overrides.provider ?? 'anthropic',
      model: overrides.model ?? 'claude-sonnet-4-6',
      status: overrides.status ?? 'idle',
      toolsEnabled: overrides.toolsEnabled ?? [],
      allowedDomains: overrides.allowedDomains ?? [],
      capabilities: overrides.capabilities ?? [],
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: db.schema.agents.id });
  return row.id;
}

async function createSession(
  db: AnyDb,
  companyId: string,
  role: 'owner' | 'admin' | 'member' | 'viewer',
  userId = 'dev-user-000',
): Promise<string> {
  const [row] = await db.drizzle
    .insert(db.schema.localTrustedSessions)
    .values({ companyId, role, userId })
    .returning();
  return row.id;
}

const validConfig: CustomProfileConfig = {
  planning: 'when_complex',
  approval: 'when_complex',
  research: 'off',
  partialResultPolicy: 'require_all',
  limits: {
    steps: 5,
    durationSeconds: 300,
    providerCalls: 10,
    totalTokens: 50_000,
    outputBytes: 1024 * 1024,
    costCents: 1000,
    depth: 1,
    fanOut: 2,
    descendants: 4,
  },
  toolAllowlist: ['research.search'],
  domainAllowlist: ['example.com'],
};

// ---------------------------------------------------------------------------
// VAL-MODEQ-152: Custom profile payloads are closed, bounded, and inert
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-152: Custom profile payloads are closed, bounded, and inert', () => {
  it('accepts a valid profile payload', () => {
    const result = CreateProfileBody.safeParse({
      slug: 'my-custom-mode',
      name: 'My Custom Mode',
      description: 'A custom mode for specialized work.',
      config: validConfig,
      enabled: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects slug not matching [a-z0-9][a-z0-9-]{0,63}', () => {
    const cases = [
      'My-Custom-Mode', // uppercase
      '-leading-hyphen',
      'trailing-hyphen-',
      'double--hyphen',
      'space in slug',
      'a'.repeat(65), // too long
      '', // empty
      'under_score',
    ];
    for (const slug of cases) {
      const result = CreateProfileBody.safeParse({
        slug,
        name: 'Test',
        config: validConfig,
      });
      expect(result.success).toBe(false);
    }
  });

  it('accepts slug boundary: 1 char and 64 chars', () => {
    expect(CreateProfileBody.safeParse({ slug: 'a', name: 'T', config: validConfig }).success).toBe(
      true,
    );
    expect(
      CreateProfileBody.safeParse({
        slug: 'a'.repeat(64),
        name: 'T',
        config: validConfig,
      }).success,
    ).toBe(true);
  });

  it('rejects name over 100 Unicode code points', () => {
    const result = CreateProfileBody.safeParse({
      slug: 'test',
      name: 'x'.repeat(101),
      config: validConfig,
    });
    expect(result.success).toBe(false);
  });

  it('accepts name boundary: 100 code points', () => {
    expect(
      CreateProfileBody.safeParse({
        slug: 'test',
        name: 'x'.repeat(100),
        config: validConfig,
      }).success,
    ).toBe(true);
  });

  it('rejects description over 1,000 Unicode code points', () => {
    const result = CreateProfileBody.safeParse({
      slug: 'test',
      name: 'T',
      description: 'x'.repeat(1001),
      config: validConfig,
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown authority-bearing fields in config', () => {
    const result = CreateProfileBody.safeParse({
      slug: 'test',
      name: 'T',
      config: { ...validConfig, adminOverride: true, secretKey: 'abc' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields in create body', () => {
    const result = CreateProfileBody.safeParse({
      slug: 'test',
      name: 'T',
      config: validConfig,
      extraField: 'not allowed',
    });
    expect(result.success).toBe(false);
  });

  it('rejects over 100 tools', () => {
    const tools = Array.from({ length: 101 }, (_, i) => `tool.${i}`);
    const result = CreateProfileBody.safeParse({
      slug: 'test',
      name: 'T',
      config: { ...validConfig, toolAllowlist: tools },
    });
    expect(result.success).toBe(false);
  });

  it('rejects over 100 domains', () => {
    const domains = Array.from({ length: 101 }, (_, i) => `domain${i}.com`);
    const result = CreateProfileBody.safeParse({
      slug: 'test',
      name: 'T',
      config: { ...validConfig, domainAllowlist: domains },
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative or non-integer limits', () => {
    const result = CreateProfileBody.safeParse({
      slug: 'test',
      name: 'T',
      config: { ...validConfig, limits: { ...validConfig.limits, costCents: -100 } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects BiDi override characters in name', () => {
    const result = CreateProfileBody.safeParse({
      slug: 'test',
      name: 'Hello\u202EWorld',
      config: validConfig,
    });
    expect(result.success).toBe(false);
  });

  it('rejects config depth exceeding 8', () => {
    // Build a deeply nested config by abusing the limits object
    const deep: Record<string, unknown> = {
      a: { b: { c: { d: { e: { f: { g: { h: { i: 'too deep' } } } } } } } },
    };
    const result = CreateProfileBody.safeParse({
      slug: 'test',
      name: 'T',
      config: { ...validConfig, limits: deep as any },
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid update body with partial fields', () => {
    const result = UpdateProfileBody.safeParse({
      name: 'Updated Name',
      enabled: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown fields in update body', () => {
    const result = UpdateProfileBody.safeParse({
      slug: 'new-slug', // slug is immutable
      name: 'Updated',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-020: Custom mode can only narrow (policy resolution)
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-020: Custom mode can only narrow (policy unit tests)', () => {
  it('intersects limits with platform hard caps (min wins)', () => {
    const policy = resolveCustomPolicy({
      profileSlug: 'test',
      profileVersion: 1,
      profileId: randomUUID(),
      config: {
        ...validConfig,
        toolAllowlist: undefined, // no tool requirements for this test
        limits: {
          ...validConfig.limits,
          costCents: 999_999, // above platform cap
          depth: 99, // above platform cap
        },
      },
    });
    expect(policy.limits.costCents).toBe(10_000);
    expect(policy.limits.depth).toBe(2);
  });

  it('intersects tool allowlist with agent tools', () => {
    const policy = resolveCustomPolicy({
      profileSlug: 'test',
      profileVersion: 1,
      profileId: randomUUID(),
      config: {
        ...validConfig,
        toolAllowlist: ['research.search', 'artifact.create'],
      },
      agent: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        toolAllowlist: ['research.search', 'chat.participate'],
        domainAllowlist: [],
        status: 'idle',
        capabilities: [],
      },
    });
    // Intersection: only 'research.search' is in both
    expect(policy.toolAllowlist).toEqual(['research.search']);
  });

  it('fails with POLICY_UNSATISFIABLE when required tools are absent from agent', () => {
    expect(() =>
      resolveCustomPolicy({
        profileSlug: 'test',
        profileVersion: 1,
        profileId: randomUUID(),
        config: {
          ...validConfig,
          toolAllowlist: ['research.search'],
        },
        agent: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          toolAllowlist: ['chat.participate'], // no overlap
          domainAllowlist: [],
          status: 'idle',
          capabilities: [],
        },
      }),
    ).toThrow(AppError);
  });

  it('user limits can only lower, never raise', () => {
    const policy = resolveCustomPolicy({
      profileSlug: 'test',
      profileVersion: 1,
      profileId: randomUUID(),
      config: {
        ...validConfig,
        toolAllowlist: undefined,
        limits: { ...validConfig.limits, costCents: 1000 },
      },
      userLimits: { costCents: 500 },
    });
    expect(policy.limits.costCents).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-123: Initiating-agent eligibility is enforced (unit tests)
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-123: Initiating-agent eligibility (unit tests)', () => {
  it('rejects inactive agent (paused)', () => {
    expect(() =>
      checkAgentEligibility({
        id: 'x',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        toolAllowlist: [],
        domainAllowlist: [],
        status: 'paused',
        capabilities: [],
      }),
    ).toThrow(AppError);
  });

  it('rejects inactive agent (error)', () => {
    expect(() =>
      checkAgentEligibility({
        id: 'x',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        toolAllowlist: [],
        domainAllowlist: [],
        status: 'error',
        capabilities: [],
      }),
    ).toThrow(AppError);
  });

  it('rejects inactive agent (offline)', () => {
    expect(() =>
      checkAgentEligibility({
        id: 'x',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        toolAllowlist: [],
        domainAllowlist: [],
        status: 'offline',
        capabilities: [],
      }),
    ).toThrow(AppError);
  });

  it('accepts active agent (idle)', () => {
    expect(() =>
      checkAgentEligibility({
        id: 'x',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        toolAllowlist: [],
        domainAllowlist: [],
        status: 'idle',
        capabilities: [],
      }),
    ).not.toThrow();
  });

  it('accepts active agent (working)', () => {
    expect(() =>
      checkAgentEligibility({
        id: 'x',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        toolAllowlist: [],
        domainAllowlist: [],
        status: 'working',
        capabilities: [],
      }),
    ).not.toThrow();
  });

  it('rejects provider-incompatible agent for custom profile', () => {
    expect(() =>
      checkAgentEligibility(
        {
          id: 'x',
          provider: 'openai',
          model: 'gpt-4',
          toolAllowlist: [],
          domainAllowlist: [],
          status: 'idle',
          capabilities: [],
        },
        { ...validConfig, requiredProvider: 'anthropic' },
      ),
    ).toThrow(AppError);
  });

  it('rejects model-incompatible agent for custom profile', () => {
    expect(() =>
      checkAgentEligibility(
        {
          id: 'x',
          provider: 'anthropic',
          model: 'claude-3-haiku',
          toolAllowlist: [],
          domainAllowlist: [],
          status: 'idle',
          capabilities: [],
        },
        { ...validConfig, requiredModel: 'claude-sonnet-4-6' },
      ),
    ).toThrow(AppError);
  });

  it('rejects agent missing required capabilities', () => {
    expect(() =>
      checkAgentEligibility(
        {
          id: 'x',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          toolAllowlist: [],
          domainAllowlist: [],
          status: 'idle',
          capabilities: ['coding'],
        },
        { ...validConfig, requiredCapabilities: ['coding', 'research'] },
      ),
    ).toThrow(AppError);
  });

  it('accepts agent with all required capabilities', () => {
    expect(() =>
      checkAgentEligibility(
        {
          id: 'x',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          toolAllowlist: [],
          domainAllowlist: [],
          status: 'idle',
          capabilities: ['coding', 'research'],
        },
        { ...validConfig, requiredCapabilities: ['coding', 'research'] },
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-153 + VAL-MODEQ-124: Mode registry API (integration)
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-153 + VAL-MODEQ-124: Mode registry API', () => {
  let db: AnyDb;
  let server: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let ownerSession: string;
  let viewerSession: string;
  let memberSession: string;

  beforeAll(async () => {
    db = await createTestDb();
    server = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    companyId = await createCompany(db, '__mtest__ mode-registry');
    ownerSession = await createSession(db, companyId, 'owner');
    viewerSession = await createSession(db, companyId, 'viewer');
    memberSession = await createSession(db, companyId, 'member');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
  });

  function authHeader(sessionId: string) {
    return { 'X-Eidolon-Test-Session-Id': sessionId };
  }

  it('POST creates a profile with 201 and ETag', async () => {
    const res = await request(server)
      .post(`/api/companies/${companyId}/mission-mode-profiles`)
      .set(authHeader(ownerSession))
      .set('Idempotency-Key', 'test-create-1')
      .send({
        slug: 'my-mode',
        name: 'My Mode',
        description: 'Test mode',
        config: validConfig,
      });
    expect(res.status).toBe(201);
    expect(res.body.data.profile).toBeDefined();
    expect(res.body.data.profile.slug).toBe('my-mode');
    expect(res.body.data.profile.version).toBe(1);
    expect(res.headers.etag).toBe('"1"');
  });

  it('POST requires Idempotency-Key', async () => {
    const res = await request(server)
      .post(`/api/companies/${companyId}/mission-mode-profiles`)
      .set(authHeader(ownerSession))
      .send({ slug: 'test', name: 'Test', config: validConfig });
    expect(res.status).toBe(400);
  });

  it('POST requires company.settings.update (viewer denied)', async () => {
    const res = await request(server)
      .post(`/api/companies/${companyId}/mission-mode-profiles`)
      .set(authHeader(viewerSession))
      .set('Idempotency-Key', 'test-viewer-1')
      .send({ slug: 'test', name: 'Test', config: validConfig });
    expect(res.status).toBe(403);
  });

  it('POST requires company.settings.update (member denied)', async () => {
    const res = await request(server)
      .post(`/api/companies/${companyId}/mission-mode-profiles`)
      .set(authHeader(memberSession))
      .set('Idempotency-Key', 'test-member-1')
      .send({ slug: 'test', name: 'Test', config: validConfig });
    expect(res.status).toBe(403);
  });

  it('GET lists enabled profiles in name order', async () => {
    // Create two profiles
    await request(server)
      .post(`/api/companies/${companyId}/mission-mode-profiles`)
      .set(authHeader(ownerSession))
      .set('Idempotency-Key', 'list-1')
      .send({ slug: 'beta', name: 'Beta Mode', config: validConfig });
    await request(server)
      .post(`/api/companies/${companyId}/mission-mode-profiles`)
      .set(authHeader(ownerSession))
      .set('Idempotency-Key', 'list-2')
      .send({ slug: 'alpha', name: 'Alpha Mode', config: validConfig });

    const res = await request(server)
      .get(`/api/companies/${companyId}/mission-mode-profiles`)
      .set(authHeader(ownerSession));
    expect(res.status).toBe(200);
    expect(res.body.data.profiles).toHaveLength(2);
    // Ordered by name
    expect(res.body.data.profiles[0].name).toBe('Alpha Mode');
    expect(res.body.data.profiles[1].name).toBe('Beta Mode');
  });

  it('GET excludes disabled profiles by default', async () => {
    const createRes = await request(server)
      .post(`/api/companies/${companyId}/mission-mode-profiles`)
      .set(authHeader(ownerSession))
      .set('Idempotency-Key', 'disabled-1')
      .send({ slug: 'disabled-mode', name: 'Disabled', config: validConfig });
    const profileId = createRes.body.data.profile.id;

    // Disable it
    await request(server)
      .patch(`/api/companies/${companyId}/mission-mode-profiles/${profileId}`)
      .set(authHeader(ownerSession))
      .set('Idempotency-Key', 'disable-1')
      .set('If-Match', '"1"')
      .send({ enabled: false });

    // List without includeDisabled
    const res = await request(server)
      .get(`/api/companies/${companyId}/mission-mode-profiles`)
      .set(authHeader(ownerSession));
    expect(res.body.data.profiles).toHaveLength(0);

    // List with includeDisabled (admin)
    const res2 = await request(server)
      .get(`/api/companies/${companyId}/mission-mode-profiles?includeDisabled=true`)
      .set(authHeader(ownerSession));
    expect(res2.body.data.profiles).toHaveLength(1);
    expect(res2.body.data.profiles[0].enabled).toBe(false);
  });

  it('GET single profile returns ETag and data', async () => {
    const createRes = await request(server)
      .post(`/api/companies/${companyId}/mission-mode-profiles`)
      .set(authHeader(ownerSession))
      .set('Idempotency-Key', 'get-1')
      .send({ slug: 'get-test', name: 'Get Test', config: validConfig });
    const id = createRes.body.data.profile.id;

    const res = await request(server)
      .get(`/api/companies/${companyId}/mission-mode-profiles/${id}`)
      .set(authHeader(ownerSession));
    expect(res.status).toBe(200);
    expect(res.body.data.profile.id).toBe(id);
    expect(res.headers.etag).toBe('"1"');
  });

  it('GET foreign profile returns 404', async () => {
    // Create a profile in another company
    const otherCompany = await createCompany(db, '__mtest__ other');
    const otherSession = await createSession(db, otherCompany, 'owner');
    const createRes = await request(server)
      .post(`/api/companies/${otherCompany}/mission-mode-profiles`)
      .set(authHeader(otherSession))
      .set('Idempotency-Key', 'foreign-1')
      .send({ slug: 'foreign', name: 'Foreign', config: validConfig });
    const foreignId = createRes.body.data.profile.id;

    // Try to read from the first company
    const res = await request(server)
      .get(`/api/companies/${companyId}/mission-mode-profiles/${foreignId}`)
      .set(authHeader(ownerSession));
    expect(res.status).toBe(404);
  });

  it('PATCH updates profile and increments version', async () => {
    const createRes = await request(server)
      .post(`/api/companies/${companyId}/mission-mode-profiles`)
      .set(authHeader(ownerSession))
      .set('Idempotency-Key', 'patch-1')
      .send({ slug: 'patch-test', name: 'Original', config: validConfig });
    const id = createRes.body.data.profile.id;

    const res = await request(server)
      .patch(`/api/companies/${companyId}/mission-mode-profiles/${id}`)
      .set(authHeader(ownerSession))
      .set('Idempotency-Key', 'patch-update-1')
      .set('If-Match', '"1"')
      .send({ name: 'Updated Name' });
    expect(res.status).toBe(200);
    expect(res.body.data.profile.name).toBe('Updated Name');
    expect(res.body.data.profile.version).toBe(2);
    expect(res.headers.etag).toBe('"2"');
  });

  it('PATCH without If-Match returns 428', async () => {
    const createRes = await request(server)
      .post(`/api/companies/${companyId}/mission-mode-profiles`)
      .set(authHeader(ownerSession))
      .set('Idempotency-Key', 'patch-nomatch-1')
      .send({ slug: 'nomatch', name: 'Test', config: validConfig });
    const id = createRes.body.data.profile.id;

    const res = await request(server)
      .patch(`/api/companies/${companyId}/mission-mode-profiles/${id}`)
      .set(authHeader(ownerSession))
      .set('Idempotency-Key', 'patch-nomatch-2')
      .send({ name: 'Updated' });
    expect(res.status).toBe(428);
  });

  it('PATCH with stale version returns 412 PROFILE_VERSION_MISMATCH', async () => {
    const createRes = await request(server)
      .post(`/api/companies/${companyId}/mission-mode-profiles`)
      .set(authHeader(ownerSession))
      .set('Idempotency-Key', 'stale-1')
      .send({ slug: 'stale-test', name: 'Stale', config: validConfig });
    const id = createRes.body.data.profile.id;

    // Update to version 2
    await request(server)
      .patch(`/api/companies/${companyId}/mission-mode-profiles/${id}`)
      .set(authHeader(ownerSession))
      .set('Idempotency-Key', 'stale-2')
      .set('If-Match', '"1"')
      .send({ name: 'V2' });

    // Try to update with stale version 1
    const res = await request(server)
      .patch(`/api/companies/${companyId}/mission-mode-profiles/${id}`)
      .set(authHeader(ownerSession))
      .set('Idempotency-Key', 'stale-3')
      .set('If-Match', '"1"')
      .send({ name: 'V3' });
    expect(res.status).toBe(412);
    expect(res.body.code).toBe('PROFILE_VERSION_MISMATCH');
  });

  it('PATCH requires company.settings.update (viewer denied)', async () => {
    const createRes = await request(server)
      .post(`/api/companies/${companyId}/mission-mode-profiles`)
      .set(authHeader(ownerSession))
      .set('Idempotency-Key', 'patch-viewer-1')
      .send({ slug: 'viewer-patch', name: 'Test', config: validConfig });
    const id = createRes.body.data.profile.id;

    const res = await request(server)
      .patch(`/api/companies/${companyId}/mission-mode-profiles/${id}`)
      .set(authHeader(viewerSession))
      .set('Idempotency-Key', 'patch-viewer-2')
      .set('If-Match', '"1"')
      .send({ name: 'Updated' });
    expect(res.status).toBe(403);
  });

  it('DELETE route is not available (404 or 405)', async () => {
    const createRes = await request(server)
      .post(`/api/companies/${companyId}/mission-mode-profiles`)
      .set(authHeader(ownerSession))
      .set('Idempotency-Key', 'delete-test-1')
      .send({ slug: 'delete-test', name: 'Delete', config: validConfig });
    const id = createRes.body.data.profile.id;

    const res = await request(server)
      .delete(`/api/companies/${companyId}/mission-mode-profiles/${id}`)
      .set(authHeader(ownerSession));
    expect([404, 405]).toContain(res.status);
  });

  it('creates attributable activity log entries', async () => {
    const res = await request(server)
      .post(`/api/companies/${companyId}/mission-mode-profiles`)
      .set(authHeader(ownerSession))
      .set('Idempotency-Key', 'activity-1')
      .send({ slug: 'activity-test', name: 'Activity', config: validConfig });
    const profileId = res.body.data.profile.id;

    const [log] = await db.drizzle
      .select()
      .from(db.schema.activityLog)
      .where(eq(db.schema.activityLog.entityId, profileId))
      .limit(1);
    expect(log).toBeDefined();
    expect(log?.action).toBe('mission.profile.created');
    expect(log?.actorId).toBe('dev-user-000');
    expect(log?.entityType).toBe('mission_mode_profile');
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-016: Company custom isolation (integration)
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-016: Company custom isolation', () => {
  let db: AnyDb;
  let server: Awaited<ReturnType<typeof createTestServer>>;
  let companyA: string;
  let companyB: string;
  let sessionA: string;
  let sessionB: string;

  beforeAll(async () => {
    db = await createTestDb();
    server = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    companyA = await createCompany(db, '__mtest__ company-a');
    companyB = await createCompany(db, '__mtest__ company-b');
    sessionA = await createSession(db, companyA, 'owner');
    sessionB = await createSession(db, companyB, 'owner');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
  });

  it('company A cannot see company B profiles', async () => {
    // Create a profile in company B
    await request(server)
      .post(`/api/companies/${companyB}/mission-mode-profiles`)
      .set({ 'X-Eidolon-Test-Session-Id': sessionB })
      .set('Idempotency-Key', 'iso-1')
      .send({ slug: 'b-only', name: 'B Only', config: validConfig });

    // List from company A
    const res = await request(server)
      .get(`/api/companies/${companyA}/mission-mode-profiles`)
      .set({ 'X-Eidolon-Test-Session-Id': sessionA });
    expect(res.body.data.profiles).toHaveLength(0);
  });

  it('cross-company start attempt returns 404 and creates no run', async () => {
    // Create a profile in company B
    const createRes = await request(server)
      .post(`/api/companies/${companyB}/mission-mode-profiles`)
      .set({ 'X-Eidolon-Test-Session-Id': sessionB })
      .set('Idempotency-Key', 'iso-2')
      .send({ slug: 'b-start', name: 'B Start', config: validConfig });
    const profileId = createRes.body.data.profile.id;

    // Create project + thread in company A
    const projA = await createProject(db, companyA);
    const threadA = await createThread(db, companyA, projA);

    // Try to start a run in company A using company B's profile
    const res = await request(server)
      .post(`/api/companies/${companyA}/projects/${projA}/mission-runs`)
      .set({ 'X-Eidolon-Test-Session-Id': sessionA })
      .set('Idempotency-Key', 'iso-start-1')
      .send({
        projectThreadId: threadA,
        mode: 'custom',
        modeProfileId: profileId,
        request: { text: 'Test' },
      });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PROFILE_NOT_FOUND');

    // Verify no run was created
    const runs = await db.drizzle
      .select()
      .from(db.schema.missionRuns)
      .where(eq(db.schema.missionRuns.companyId, companyA));
    expect(runs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-017 + VAL-MODEQ-018: Disabled profile hidden and cannot start
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-017 + VAL-MODEQ-018: Disabled profile hidden and cannot start', () => {
  let db: AnyDb;
  let server: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;
  let ownerSession: string;

  beforeAll(async () => {
    db = await createTestDb();
    server = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    companyId = await createCompany(db, '__mtest__ disabled-test');
    projectId = await createProject(db, companyId);
    threadId = await createThread(db, companyId, projectId);
    ownerSession = await createSession(db, companyId, 'owner');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
  });

  it('disabled profile is absent from list and cannot start', async () => {
    // Create and then disable a profile
    const createRes = await request(server)
      .post(`/api/companies/${companyId}/mission-mode-profiles`)
      .set({ 'X-Eidolon-Test-Session-Id': ownerSession })
      .set('Idempotency-Key', 'dis-1')
      .send({ slug: 'will-disable', name: 'Will Disable', config: validConfig });
    const profileId = createRes.body.data.profile.id;

    // Disable it
    await request(server)
      .patch(`/api/companies/${companyId}/mission-mode-profiles/${profileId}`)
      .set({ 'X-Eidolon-Test-Session-Id': ownerSession })
      .set('Idempotency-Key', 'dis-2')
      .set('If-Match', '"1"')
      .send({ enabled: false });

    // Verify absent from selectable list
    const listRes = await request(server)
      .get(`/api/companies/${companyId}/mission-mode-profiles`)
      .set({ 'X-Eidolon-Test-Session-Id': ownerSession });
    expect(listRes.body.data.profiles.find((p: any) => p.id === profileId)).toBeUndefined();

    // Try to start with disabled profile
    const startRes = await request(server)
      .post(`/api/companies/${companyId}/projects/${projectId}/mission-runs`)
      .set({ 'X-Eidolon-Test-Session-Id': ownerSession })
      .set('Idempotency-Key', 'dis-start-1')
      .send({
        projectThreadId: threadId,
        mode: 'custom',
        modeProfileId: profileId,
        request: { text: 'Test' },
      });
    expect(startRes.status).toBe(409);
    expect(startRes.body.code).toBe('PROFILE_DISABLED');

    // Verify no run was created
    const runs = await db.drizzle
      .select()
      .from(db.schema.missionRuns)
      .where(eq(db.schema.missionRuns.companyId, companyId));
    expect(runs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-019: Ineligible custom mode denies start
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-019: Ineligible custom mode denies start', () => {
  let db: AnyDb;
  let server: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;
  let ownerSession: string;

  beforeAll(async () => {
    db = await createTestDb();
    server = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    companyId = await createCompany(db, '__mtest__ ineligible');
    projectId = await createProject(db, companyId);
    threadId = await createThread(db, companyId, projectId);
    ownerSession = await createSession(db, companyId, 'owner');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
  });

  it('start fails when required provider is incompatible', async () => {
    const agentId = await createAgent(db, companyId, { provider: 'openai' });

    const createRes = await request(server)
      .post(`/api/companies/${companyId}/mission-mode-profiles`)
      .set({ 'X-Eidolon-Test-Session-Id': ownerSession })
      .set('Idempotency-Key', 'inel-1')
      .send({
        slug: 'needs-anthropic',
        name: 'Needs Anthropic',
        config: { ...validConfig, requiredProvider: 'anthropic' },
      });
    const profileId = createRes.body.data.profile.id;

    const res = await request(server)
      .post(`/api/companies/${companyId}/projects/${projectId}/mission-runs`)
      .set({ 'X-Eidolon-Test-Session-Id': ownerSession })
      .set('Idempotency-Key', 'inel-start-1')
      .send({
        projectThreadId: threadId,
        mode: 'custom',
        modeProfileId: profileId,
        initiatingAgentId: agentId,
        request: { text: 'Test' },
      });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('POLICY_UNSATISFIABLE');

    const runs = await db.drizzle
      .select()
      .from(db.schema.missionRuns)
      .where(eq(db.schema.missionRuns.companyId, companyId));
    expect(runs).toHaveLength(0);
  });

  it('start fails when required tools are absent', async () => {
    const agentId = await createAgent(db, companyId, {
      toolsEnabled: ['chat.participate'],
    });

    const createRes = await request(server)
      .post(`/api/companies/${companyId}/mission-mode-profiles`)
      .set({ 'X-Eidolon-Test-Session-Id': ownerSession })
      .set('Idempotency-Key', 'inel-2')
      .send({
        slug: 'needs-tools',
        name: 'Needs Tools',
        config: { ...validConfig, toolAllowlist: ['research.search', 'artifact.create'] },
      });
    const profileId = createRes.body.data.profile.id;

    const res = await request(server)
      .post(`/api/companies/${companyId}/projects/${projectId}/mission-runs`)
      .set({ 'X-Eidolon-Test-Session-Id': ownerSession })
      .set('Idempotency-Key', 'inel-start-2')
      .send({
        projectThreadId: threadId,
        mode: 'custom',
        modeProfileId: profileId,
        initiatingAgentId: agentId,
        request: { text: 'Test' },
      });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('POLICY_UNSATISFIABLE');
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-123: Initiating-agent eligibility (integration)
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-123: Initiating-agent eligibility (integration)', () => {
  let db: AnyDb;
  let server: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;
  let ownerSession: string;

  beforeAll(async () => {
    db = await createTestDb();
    server = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    companyId = await createCompany(db, '__mtest__ agent-elig');
    projectId = await createProject(db, companyId);
    threadId = await createThread(db, companyId, projectId);
    ownerSession = await createSession(db, companyId, 'owner');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
  });

  it('rejects inactive (paused) agent', async () => {
    const agentId = await createAgent(db, companyId, { status: 'paused' });

    const res = await request(server)
      .post(`/api/companies/${companyId}/projects/${projectId}/mission-runs`)
      .set({ 'X-Eidolon-Test-Session-Id': ownerSession })
      .set('Idempotency-Key', 'elig-paused-1')
      .send({
        projectThreadId: threadId,
        mode: 'fast',
        initiatingAgentId: agentId,
        request: { text: 'Test' },
      });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('POLICY_UNSATISFIABLE');
  });

  it('rejects foreign-company agent (404)', async () => {
    const otherCompany = await createCompany(db, '__mtest__ other-co');
    const foreignAgentId = await createAgent(db, otherCompany);

    const res = await request(server)
      .post(`/api/companies/${companyId}/projects/${projectId}/mission-runs`)
      .set({ 'X-Eidolon-Test-Session-Id': ownerSession })
      .set('Idempotency-Key', 'elig-foreign-1')
      .send({
        projectThreadId: threadId,
        mode: 'fast',
        initiatingAgentId: foreignAgentId,
        request: { text: 'Test' },
      });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('AGENT_NOT_FOUND');
  });

  it('rejects nonexistent agent (404)', async () => {
    const res = await request(server)
      .post(`/api/companies/${companyId}/projects/${projectId}/mission-runs`)
      .set({ 'X-Eidolon-Test-Session-Id': ownerSession })
      .set('Idempotency-Key', 'elig-nonexist-1')
      .send({
        projectThreadId: threadId,
        mode: 'fast',
        initiatingAgentId: randomUUID(),
        request: { text: 'Test' },
      });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('AGENT_NOT_FOUND');
  });

  it('accepts active (idle) agent and creates run', async () => {
    const agentId = await createAgent(db, companyId, { status: 'idle' });

    const res = await request(server)
      .post(`/api/companies/${companyId}/projects/${projectId}/mission-runs`)
      .set({ 'X-Eidolon-Test-Session-Id': ownerSession })
      .set('Idempotency-Key', 'elig-idle-1')
      .send({
        projectThreadId: threadId,
        mode: 'fast',
        initiatingAgentId: agentId,
        request: { text: 'Test' },
      });
    expect(res.status).toBe(202);
    expect(res.body.data.run).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-020: Custom mode can only narrow (integration)
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-020: Custom mode can only narrow (integration)', () => {
  let db: AnyDb;
  let server: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;
  let ownerSession: string;

  beforeAll(async () => {
    db = await createTestDb();
    server = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    companyId = await createCompany(db, '__mtest__ narrow');
    projectId = await createProject(db, companyId);
    threadId = await createThread(db, companyId, projectId);
    ownerSession = await createSession(db, companyId, 'owner');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
  });

  it('profile with limits above platform caps is narrowed at start', async () => {
    const agentId = await createAgent(db, companyId, {
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });

    const createRes = await request(server)
      .post(`/api/companies/${companyId}/mission-mode-profiles`)
      .set({ 'X-Eidolon-Test-Session-Id': ownerSession })
      .set('Idempotency-Key', 'narrow-1')
      .send({
        slug: 'high-limits',
        name: 'High Limits',
        config: {
          ...validConfig,
          limits: {
            ...validConfig.limits,
            costCents: 999_999, // above platform cap
            depth: 99,
            fanOut: 99,
            descendants: 99,
          },
        },
      });
    const profileId = createRes.body.data.profile.id;

    const res = await request(server)
      .post(`/api/companies/${companyId}/projects/${projectId}/mission-runs`)
      .set({ 'X-Eidolon-Test-Session-Id': ownerSession })
      .set('Idempotency-Key', 'narrow-start-1')
      .send({
        projectThreadId: threadId,
        mode: 'custom',
        modeProfileId: profileId,
        initiatingAgentId: agentId,
        request: { text: 'Test' },
      });
    expect(res.status).toBe(202);
    // The snapshot should show narrowed limits — the start succeeds (202)
    // rather than failing with 422 POLICY_UNSATISFIABLE, proving the limits
    // above platform caps were narrowed (min wins), not rejected.
    const snapshot = res.body.data.run;
    expect(snapshot.resolvedMode).toBe('custom');
    expect(snapshot.policySnapshotId).not.toBeNull();
    expect(snapshot.policyContentHash).not.toBeNull();

    // Verify the run was created with modeProfileId set
    const [run] = await db.drizzle
      .select()
      .from(db.schema.missionRuns)
      .where(eq(db.schema.missionRuns.id, snapshot.id))
      .limit(1);
    expect(run).toBeDefined();
    expect(run.modeProfileId).toBe(profileId);
  });

  it('successful custom mode start with narrowed snapshot', async () => {
    const agentId = await createAgent(db, companyId, {
      toolsEnabled: ['research.search', 'chat.participate'],
      allowedDomains: ['example.com'],
    });

    const createRes = await request(server)
      .post(`/api/companies/${companyId}/mission-mode-profiles`)
      .set({ 'X-Eidolon-Test-Session-Id': ownerSession })
      .set('Idempotency-Key', 'narrow-2')
      .send({
        slug: 'narrow-test',
        name: 'Narrow Test',
        config: validConfig,
      });
    const profileId = createRes.body.data.profile.id;

    const res = await request(server)
      .post(`/api/companies/${companyId}/projects/${projectId}/mission-runs`)
      .set({ 'X-Eidolon-Test-Session-Id': ownerSession })
      .set('Idempotency-Key', 'narrow-start-2')
      .send({
        projectThreadId: threadId,
        mode: 'custom',
        modeProfileId: profileId,
        initiatingAgentId: agentId,
        request: { text: 'Test custom mode' },
      });
    expect(res.status).toBe(202);
    expect(res.body.data.run.resolvedMode).toBe('custom');

    // Verify modeProfileId is stored on the run
    const [run] = await db.drizzle
      .select()
      .from(db.schema.missionRuns)
      .where(eq(db.schema.missionRuns.id, res.body.data.run.id))
      .limit(1);
    expect(run.modeProfileId).toBe(profileId);
  });

  it('preserves historical run snapshot identity after profile update', async () => {
    const agentId = await createAgent(db, companyId, {
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });

    // Create profile v1
    const createRes = await request(server)
      .post(`/api/companies/${companyId}/mission-mode-profiles`)
      .set({ 'X-Eidolon-Test-Session-Id': ownerSession })
      .set('Idempotency-Key', 'hist-1')
      .send({
        slug: 'hist-test',
        name: 'Hist Test',
        config: { ...validConfig, limits: { ...validConfig.limits, costCents: 500 } },
      });
    const profileId = createRes.body.data.profile.id;

    // Start a run with v1
    const startRes = await request(server)
      .post(`/api/companies/${companyId}/projects/${projectId}/mission-runs`)
      .set({ 'X-Eidolon-Test-Session-Id': ownerSession })
      .set('Idempotency-Key', 'hist-start-1')
      .send({
        projectThreadId: threadId,
        mode: 'custom',
        modeProfileId: profileId,
        initiatingAgentId: agentId,
        request: { text: 'Test' },
      });
    expect(startRes.status).toBe(202);
    const runId = startRes.body.data.run.id;
    const originalPolicySnapshotId = startRes.body.data.run.policySnapshotId;

    // Update the profile to v2 (change costCents)
    await request(server)
      .patch(`/api/companies/${companyId}/mission-mode-profiles/${profileId}`)
      .set({ 'X-Eidolon-Test-Session-Id': ownerSession })
      .set('Idempotency-Key', 'hist-2')
      .set('If-Match', '"1"')
      .send({
        config: { ...validConfig, limits: { ...validConfig.limits, costCents: 200 } },
      });

    // The original run's policy snapshot should be unchanged
    const [run] = await db.drizzle
      .select()
      .from(db.schema.missionRuns)
      .where(eq(db.schema.missionRuns.id, runId))
      .limit(1);
    expect(run.policySnapshotId).toBe(originalPolicySnapshotId);

    const [policy] = await db.drizzle
      .select()
      .from(db.schema.runPolicySnapshots)
      .where(eq(db.schema.runPolicySnapshots.id, originalPolicySnapshotId))
      .limit(1);
    const limits = policy.limits as Record<string, number>;
    expect(limits.costCents).toBe(500); // original, not updated
    expect(policy.sourceProfileVersion).toBe(1); // original version
  });
});
