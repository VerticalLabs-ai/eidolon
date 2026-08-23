import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, createTestApp } from '../test-utils.js';
import { MissionStartService } from '../services/mission/start.js';
import {
  resolvePolicy,
  resolveCustomPolicy,
  policyContentHash,
  previewPolicy,
  computePreviewKey,
  type CompanyPolicyInput,
  type UserReductions,
  type CustomProfileConfig,
} from '../services/mission/policy.js';
import { PLATFORM_HARD_CAPS } from '../services/mission/modes.js';
import { AppError } from '../middleware/error-handler.js';

/**
 * Deny-biased effective policy resolution and preview revalidation tests.
 *
 * Covers:
 * - VAL-MODEQ-035: Resolution precedence is deny biased
 * - VAL-MODEQ-036: User overrides only lower limits
 * - VAL-MODEQ-037: Empty required intersection fails
 * - VAL-MODEQ-038: Unsatisfiable policy has no side effects
 * - VAL-MODEQ-126: Policy preview cannot authorize stale policy
 * - VAL-MODEQ-151: Root agent revocation is deny only
 * - VAL-CROSS-008: Custom mode narrows policy
 */

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

function enableMissionFlag() {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify({ missionAgentIntelligence: { enabled: true } }),
  );
}

async function createCompany(db: AnyDb, name: string, settings: Record<string, unknown> = {}) {
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "companies" ("id", "name", "status", "budget_monthly_cents", "spent_monthly_cents", "settings", "created_at", "updated_at")
    VALUES (${id}, ${name}, 'active', 100000, 0, ${JSON.stringify(settings)}::jsonb, ${now}, ${now})
  `);
  return id;
}

async function createProject(db: AnyDb, companyId: string) {
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "projects" ("id", "company_id", "name", "status", "created_at", "updated_at")
    VALUES (${id}, ${companyId}, '__mtest__ project', 'active', ${now}, ${now})
  `);
  return id;
}

async function createThread(db: AnyDb, companyId: string, projectId: string) {
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "project_threads" ("id", "company_id", "project_id", "title", "type", "status", "created_at", "updated_at")
    VALUES (${id}, ${companyId}, ${projectId}, '__mtest__ thread', 'conversation', 'active', ${now}, ${now})
  `);
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
    apiKeyEncrypted?: string | null;
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
      apiKeyEncrypted: overrides.apiKeyEncrypted ?? 'test-key',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: db.schema.agents.id });
  return row.id;
}

async function createSession(
  db: AnyDb,
  companyId: string,
  role: 'owner' | 'admin' | 'member' | 'viewer' = 'owner',
): Promise<string> {
  const [row] = await db.drizzle
    .insert(db.schema.localTrustedSessions)
    .values({ companyId, role, userId: 'dev-user-000' })
    .returning();
  return row.id;
}

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

// ---------------------------------------------------------------------------
// VAL-MODEQ-035: Resolution precedence is deny biased
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-035: Resolution precedence is deny biased', () => {
  it('applies platform caps as the first layer (limits never exceed caps)', () => {
    const policy = resolvePolicy({
      mode: 'deep_work',
      agent: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        toolAllowlist: ['research.search'],
        domainAllowlist: ['example.com'],
      },
    });
    expect(policy.limits.costCents).toBeLessThanOrEqual(PLATFORM_HARD_CAPS.costCents);
    expect(policy.limits.totalTokens).toBeLessThanOrEqual(PLATFORM_HARD_CAPS.totalTokens);
    expect(policy.limits.durationSeconds).toBeLessThanOrEqual(PLATFORM_HARD_CAPS.durationSeconds);
    expect(policy.limits.depth).toBeLessThanOrEqual(PLATFORM_HARD_CAPS.depth);
    expect(policy.limits.fanOut).toBeLessThanOrEqual(PLATFORM_HARD_CAPS.fanOut);
    expect(policy.limits.descendants).toBeLessThanOrEqual(PLATFORM_HARD_CAPS.descendants);
  });

  it('company governance intersects tools (sets intersect)', () => {
    const company: CompanyPolicyInput = {
      allowedTools: ['research.search', 'artifact.create'],
    };
    const policy = resolvePolicy({
      mode: 'fast',
      agent: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        toolAllowlist: ['research.search', 'mcp.tool1', 'code.execute'],
        domainAllowlist: [],
      },
      company,
    });
    // Intersection: agent has research.search, mcp.tool1, code.execute;
    // company allows research.search, artifact.create → only research.search.
    expect(policy.toolAllowlist).toEqual(['research.search']);
  });

  it('company denied tools always win over agent allowlist (explicit deny wins)', () => {
    const company: CompanyPolicyInput = {
      deniedTools: ['research.search'],
    };
    const policy = resolvePolicy({
      mode: 'fast',
      agent: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        toolAllowlist: ['research.search', 'artifact.create'],
        domainAllowlist: [],
      },
      company,
    });
    expect(policy.toolAllowlist).not.toContain('research.search');
    expect(policy.toolAllowlist).toEqual(['artifact.create']);
  });

  it('company governance intersects domains (sets intersect)', () => {
    const company: CompanyPolicyInput = {
      allowedDomains: ['example.com', 'trusted.org'],
    };
    const policy = resolvePolicy({
      mode: 'fast',
      agent: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        toolAllowlist: [],
        domainAllowlist: ['example.com', 'untrusted.com'],
      },
      company,
    });
    expect(policy.domainAllowlist).toEqual(['example.com']);
  });

  it('company denied domains always win (explicit deny wins)', () => {
    const company: CompanyPolicyInput = {
      deniedDomains: ['malicious.com'],
    };
    const policy = resolvePolicy({
      mode: 'fast',
      agent: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        toolAllowlist: [],
        domainAllowlist: ['malicious.com', 'safe.com'],
      },
      company,
    });
    expect(policy.domainAllowlist).not.toContain('malicious.com');
    expect(policy.domainAllowlist).toEqual(['safe.com']);
  });

  it('limits take the minimum across all layers', () => {
    const company: CompanyPolicyInput = {
      limits: { costCents: 2000, totalTokens: 100_000 },
    };
    const reductions: UserReductions = { costCents: 500 };
    const policy = resolvePolicy({
      mode: 'deep_work',
      agent: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        toolAllowlist: [],
        domainAllowlist: [],
      },
      company,
      userReductions: reductions,
    });
    // Deep Work default costCents is 5000, company lowers to 2000, user
    // lowers to 500 → minimum is 500.
    expect(policy.limits.costCents).toBe(500);
    // Deep Work default totalTokens is 300_000, company lowers to 100_000.
    expect(policy.limits.totalTokens).toBe(100_000);
  });

  it('company governance restricts provider (deny-biased)', () => {
    const company: CompanyPolicyInput = {
      allowedProviders: ['openai'],
    };
    expectAppError(
      () =>
        resolvePolicy({
          mode: 'fast',
          agent: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            toolAllowlist: [],
            domainAllowlist: [],
          },
          company,
        }),
      'POLICY_UNSATISFIABLE',
    );
  });

  it('company governance allows the agent provider when it matches', () => {
    const company: CompanyPolicyInput = {
      allowedProviders: ['anthropic'],
    };
    const policy = resolvePolicy({
      mode: 'fast',
      agent: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        toolAllowlist: [],
        domainAllowlist: [],
      },
      company,
    });
    expect(policy.provider).toBe('anthropic');
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-036: User overrides only lower limits
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-036: User overrides only lower limits', () => {
  it('user can lower a numeric limit (minimum wins)', () => {
    const policy = resolvePolicy({
      mode: 'fast',
      agent: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        toolAllowlist: [],
        domainAllowlist: [],
      },
      userReductions: { costCents: 100 },
    });
    // Fast default is 500, user lowers to 100.
    expect(policy.limits.costCents).toBe(100);
  });

  it('user cannot raise a limit above the mode default (minimum wins)', () => {
    const policy = resolvePolicy({
      mode: 'fast',
      agent: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        toolAllowlist: [],
        domainAllowlist: [],
      },
      userReductions: { costCents: 10000 },
    });
    // Fast default is 500, user tries 10000 → minimum is 500.
    expect(policy.limits.costCents).toBe(500);
  });

  it('user can remove tools (narrowing only)', () => {
    const policy = resolvePolicy({
      mode: 'fast',
      agent: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        toolAllowlist: ['research.search', 'artifact.create'],
        domainAllowlist: [],
      },
      userReductions: { removedTools: ['research.search'] },
    });
    expect(policy.toolAllowlist).not.toContain('research.search');
    expect(policy.toolAllowlist).toEqual(['artifact.create']);
  });

  it('user can remove domains (narrowing only)', () => {
    const policy = resolvePolicy({
      mode: 'fast',
      agent: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        toolAllowlist: [],
        domainAllowlist: ['example.com', 'test.com'],
      },
      userReductions: { removedDomains: ['example.com'] },
    });
    expect(policy.domainAllowlist).not.toContain('example.com');
    expect(policy.domainAllowlist).toEqual(['test.com']);
  });

  it('user cannot add tools that the agent does not have', () => {
    // The start body does not accept tools to ADD — only removedTools.
    // So there is no way for the user to broaden the tool allowlist.
    // This test verifies the API surface: removedTools only narrows.
    const policy = resolvePolicy({
      mode: 'fast',
      agent: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        toolAllowlist: ['research.search'],
        domainAllowlist: [],
      },
      userReductions: { removedTools: [] },
    });
    // No tools added beyond the agent's allowlist.
    expect(policy.toolAllowlist).toEqual(['research.search']);
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-037: Empty required intersection fails
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-037: Empty required intersection fails', () => {
  it('empty provider intersection fails with POLICY_UNSATISFIABLE', () => {
    const company: CompanyPolicyInput = {
      allowedProviders: ['google'],
    };
    expectAppError(
      () =>
        resolvePolicy({
          mode: 'fast',
          agent: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            toolAllowlist: [],
            domainAllowlist: [],
          },
          company,
        }),
      'POLICY_UNSATISFIABLE',
    );
  });

  it('custom mode with empty tool intersection fails', () => {
    const config: CustomProfileConfig = {
      toolAllowlist: ['research.search'],
    };
    expectAppError(
      () =>
        resolveCustomPolicy({
          profileSlug: 'test',
          profileVersion: 1,
          profileId: randomUUID(),
          config,
          agent: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            toolAllowlist: ['artifact.create'], // no overlap with profile tools
            domainAllowlist: [],
          },
        }),
      'POLICY_UNSATISFIABLE',
    );
  });

  it('custom mode with empty required capability intersection fails', () => {
    const config: CustomProfileConfig = {
      requiredCapabilities: ['special-cap'],
    };
    expectAppError(
      () =>
        resolveCustomPolicy({
          profileSlug: 'test',
          profileVersion: 1,
          profileId: randomUUID(),
          config,
          agent: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            toolAllowlist: [],
            domainAllowlist: [],
            capabilities: ['other-cap'], // missing required capability
          },
        }),
      'POLICY_UNSATISFIABLE',
    );
  });

  it('custom mode with required provider mismatch fails', () => {
    const config: CustomProfileConfig = {
      requiredProvider: 'openai',
    };
    expectAppError(
      () =>
        resolveCustomPolicy({
          profileSlug: 'test',
          profileVersion: 1,
          profileId: randomUUID(),
          config,
          agent: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            toolAllowlist: [],
            domainAllowlist: [],
          },
        }),
      'POLICY_UNSATISFIABLE',
    );
  });

  it('custom mode with required model mismatch fails', () => {
    const config: CustomProfileConfig = {
      requiredModel: 'gpt-4',
    };
    expectAppError(
      () =>
        resolveCustomPolicy({
          profileSlug: 'test',
          profileVersion: 1,
          profileId: randomUUID(),
          config,
          agent: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            toolAllowlist: [],
            domainAllowlist: [],
          },
        }),
      'POLICY_UNSATISFIABLE',
    );
  });

  it('company denied tools that eliminate all tools still resolves (tools not required for built-in)', () => {
    // For built-in modes, tools are not "required" — an empty intersection
    // is acceptable (the mode can still do a plain chat). This is NOT a
    // POLICY_UNSATISFIABLE case for built-in modes.
    const company: CompanyPolicyInput = {
      deniedTools: ['research.search', 'artifact.create'],
    };
    const policy = resolvePolicy({
      mode: 'fast',
      agent: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        toolAllowlist: ['research.search', 'artifact.create'],
        domainAllowlist: [],
      },
      company,
    });
    expect(policy.toolAllowlist).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-038: Unsatisfiable policy has no side effects
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-038: Unsatisfiable policy has no side effects', () => {
  let db: AnyDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(() => {
    enableMissionFlag();
  });

  afterEach(async () => {
    await db.drizzle.execute(
      sql`DELETE FROM "mission_runs" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "run_commands" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "run_events" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "run_policy_snapshots" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "budget_reservations" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "budget_allocations" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "agents" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "project_threads" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "projects" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(sql`DELETE FROM "companies" WHERE "name" LIKE '__mtest__%'`);
  });

  it('POLICY_UNSATISFIABLE start creates no run, reservation, or command', async () => {
    const companyId = await createCompany(db, '__mtest__ unsat-company', {
      testFixture: true,
      missionPolicy: { allowedProviders: ['google'] },
    });
    const projectId = await createProject(db, companyId);
    const threadId = await createThread(db, companyId, projectId);
    const agentId = await createAgent(db, companyId, { provider: 'anthropic' });

    const service = new MissionStartService(db);
    await expect(
      service.start({
        companyId,
        projectId,
        idempotencyKey: 'unsat-test-key-1',
        body: {
          projectThreadId: threadId,
          mode: 'fast',
          initiatingAgentId: agentId,
          request: { text: 'Test request' },
        },
        actorType: 'user',
        actorId: 'dev-user-000',
      }),
    ).rejects.toThrow();

    // Verify no run was created.
    const runs = await db.drizzle
      .select()
      .from(db.schema.missionRuns)
      .where(eq(db.schema.missionRuns.companyId, companyId));
    expect(runs).toHaveLength(0);

    // Verify no policy snapshot was created.
    const snapshots = await db.drizzle
      .select()
      .from(db.schema.runPolicySnapshots)
      .where(eq(db.schema.runPolicySnapshots.companyId, companyId));
    expect(snapshots).toHaveLength(0);

    // Verify no budget reservation was created.
    const reservations = await db.drizzle
      .select()
      .from(db.schema.budgetReservations)
      .where(eq(db.schema.budgetReservations.companyId, companyId));
    expect(reservations).toHaveLength(0);

    // Verify no command was created.
    const commands = await db.drizzle
      .select()
      .from(db.schema.runCommands)
      .where(eq(db.schema.runCommands.companyId, companyId));
    expect(commands).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-126: Policy preview cannot authorize stale policy
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-126: Policy preview cannot authorize stale policy', () => {
  it('preview is labelled as a preview (not authority)', () => {
    const policy = resolvePolicy({
      mode: 'fast',
      agent: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        toolAllowlist: ['research.search'],
        domainAllowlist: [],
      },
    });
    const preview = previewPolicy(policy, {
      companyId: 'co-1',
      projectId: 'pr-1',
      projectThreadId: 'th-1',
      initiatingAgentId: 'ag-1',
      requestTextHash: 'hash-1',
      contextHash: 'ctx-1',
      mode: 'fast',
      modeProfileId: null,
      modeProfileVersion: null,
      reductionsHash: 'red-1',
    });
    expect(preview.kind).toBe('preview');
    expect(preview.previewKey).toBeDefined();
    expect(preview.policyContentHash).toBe(policyContentHash(policy));
  });

  it('changing any input invalidates the preview key', () => {
    const baseInputs = {
      companyId: 'co-1',
      projectId: 'pr-1',
      projectThreadId: 'th-1',
      initiatingAgentId: 'ag-1',
      requestTextHash: 'hash-1',
      contextHash: 'ctx-1',
      mode: 'fast',
      modeProfileId: null,
      modeProfileVersion: null,
      reductionsHash: 'red-1',
    };
    const key1 = computePreviewKey(baseInputs);

    // Change companyId.
    expect(computePreviewKey({ ...baseInputs, companyId: 'co-2' })).not.toBe(key1);
    // Change projectThreadId.
    expect(computePreviewKey({ ...baseInputs, projectThreadId: 'th-2' })).not.toBe(key1);
    // Change initiatingAgentId.
    expect(computePreviewKey({ ...baseInputs, initiatingAgentId: 'ag-2' })).not.toBe(key1);
    // Change requestTextHash.
    expect(computePreviewKey({ ...baseInputs, requestTextHash: 'hash-2' })).not.toBe(key1);
    // Change mode.
    expect(computePreviewKey({ ...baseInputs, mode: 'deep_work' })).not.toBe(key1);
    // Change modeProfileId.
    expect(computePreviewKey({ ...baseInputs, modeProfileId: 'profile-1' })).not.toBe(key1);
    // Change modeProfileVersion.
    expect(computePreviewKey({ ...baseInputs, modeProfileVersion: 2 })).not.toBe(key1);
    // Change reductionsHash.
    expect(computePreviewKey({ ...baseInputs, reductionsHash: 'red-2' })).not.toBe(key1);
    // Same inputs → same key (deterministic).
    expect(computePreviewKey(baseInputs)).toBe(key1);
  });

  it('preview reflects the narrowed effective policy', () => {
    const policy = resolvePolicy({
      mode: 'fast',
      agent: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        toolAllowlist: ['research.search', 'artifact.create'],
        domainAllowlist: ['example.com'],
      },
      company: { deniedTools: ['artifact.create'] },
      userReductions: { costCents: 100 },
    });
    const preview = previewPolicy(policy, {
      companyId: 'co-1',
      projectId: 'pr-1',
      projectThreadId: 'th-1',
      initiatingAgentId: null,
      requestTextHash: 'h',
      contextHash: 'c',
      mode: 'fast',
      modeProfileId: null,
      modeProfileVersion: null,
      reductionsHash: 'r',
    });
    // The preview reflects the narrowed policy.
    expect(preview.toolAllowlist).toEqual(['research.search']);
    expect(preview.limits.costCents).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-008: Custom mode narrows policy
// ---------------------------------------------------------------------------

describe('VAL-CROSS-008: Custom mode narrows policy', () => {
  it('custom mode snapshot is no broader than company, agent, and platform constraints', () => {
    const company: CompanyPolicyInput = {
      allowedTools: ['research.search', 'artifact.create'],
      limits: { costCents: 3000 },
    };
    const config: CustomProfileConfig = {
      planning: 'when_complex',
      approval: 'when_complex',
      research: 'off',
      limits: { costCents: 5000, totalTokens: 200_000 },
      toolAllowlist: ['research.search'],
    };
    const policy = resolveCustomPolicy({
      profileSlug: 'test-custom',
      profileVersion: 1,
      profileId: randomUUID(),
      config,
      agent: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        toolAllowlist: ['research.search', 'artifact.create', 'code.execute'],
        domainAllowlist: [],
      },
      company,
    });
    // Tools: profile ∩ agent ∩ company = research.search.
    expect(policy.toolAllowlist).toEqual(['research.search']);
    // Cost: min(profile 5000, company 3000, platform 10000) = 3000.
    expect(policy.limits.costCents).toBe(3000);
    // TotalTokens: min(profile 200k, platform 500k) = 200k.
    expect(policy.limits.totalTokens).toBe(200_000);
    // Resolved mode is 'custom'.
    expect(policy.resolvedMode).toBe('custom');
  });

  it('unsatisfiable custom profile fails closed with POLICY_UNSATISFIABLE', () => {
    const config: CustomProfileConfig = {
      toolAllowlist: ['nonexistent.tool'],
    };
    expectAppError(
      () =>
        resolveCustomPolicy({
          profileSlug: 'unsat',
          profileVersion: 1,
          profileId: randomUUID(),
          config,
          agent: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            toolAllowlist: ['research.search'],
            domainAllowlist: [],
          },
        }),
      'POLICY_UNSATISFIABLE',
    );
  });

  it('custom mode with company denied tools narrows further', () => {
    const company: CompanyPolicyInput = {
      deniedTools: ['research.search'],
    };
    const config: CustomProfileConfig = {
      toolAllowlist: ['research.search', 'artifact.create'],
    };
    const policy = resolveCustomPolicy({
      profileSlug: 'test',
      profileVersion: 1,
      profileId: randomUUID(),
      config,
      agent: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        toolAllowlist: ['research.search', 'artifact.create'],
        domainAllowlist: [],
      },
      company,
    });
    // Company denies research.search, so only artifact.create remains.
    expect(policy.toolAllowlist).toEqual(['artifact.create']);
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-151: Root agent revocation is deny only
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-151: Root agent revocation is deny only', () => {
  let db: AnyDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(() => {
    enableMissionFlag();
  });

  afterEach(async () => {
    await db.drizzle.execute(
      sql`DELETE FROM "run_tool_invocations" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "run_events" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "mission_runs" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "run_commands" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "run_policy_snapshots" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "budget_reservations" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "budget_allocations" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "budget_settlements" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "agents" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "project_threads" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "projects" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(sql`DELETE FROM "companies" WHERE "name" LIKE '__mtest__%'`);
  });

  it('revoking agent status (paused) before claim blocks the run from progressing', async () => {
    const { RunCoordinator } = await import('../services/mission/coordinator.js');
    const { RunProcessor } = await import('../services/mission/run-processor.js');

    const companyId = await createCompany(db, '__mtest__ revoke-status');
    const projectId = await createProject(db, companyId);
    const threadId = await createThread(db, companyId, projectId);
    const agentId = await createAgent(db, companyId, {
      toolsEnabled: ['research.search'],
      status: 'idle',
    });

    const service = new MissionStartService(db);
    const result = await service.start({
      companyId,
      projectId,
      idempotencyKey: 'revoke-status-key',
      body: {
        projectThreadId: threadId,
        mode: 'fast',
        initiatingAgentId: agentId,
        request: { text: 'Test request for revocation' },
      },
      actorType: 'user',
      actorId: 'dev-user-000',
    });
    expect(result.run.status).toBe('queued');

    // Revoke: set agent status to 'paused'.
    await db.drizzle
      .update(db.schema.agents)
      .set({ status: 'paused' })
      .where(eq(db.schema.agents.id, agentId));

    // Claim the run.
    const coordinator = new RunCoordinator(db);
    const claim = await coordinator.claimNext('worker-test');
    expect(claim).not.toBeNull();
    expect(claim!.runId).toBe(result.run.id);

    // Process the run — should fail safely due to agent revocation.
    let providerCalled = false;
    const processor = new RunProcessor(db, {
      providerCall: async () => {
        providerCalled = true;
        return {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          content: 'test',
          inputTokens: 10,
          outputTokens: 5,
          costCents: 1,
          finishReason: 'stop',
          latencyMs: 100,
        };
      },
    });
    await processor.advance(claim!, new AbortController().signal);

    // The provider should NOT have been called (agent revoked).
    expect(providerCalled).toBe(false);

    // The run should be terminal (failed).
    const [finalRun] = await db.drizzle
      .select()
      .from(db.schema.missionRuns)
      .where(eq(db.schema.missionRuns.id, result.run.id));
    expect(['failed', 'cancelled']).toContain(finalRun.status);
  });

  it('revoking agent tools before tool dispatch blocks the tool call', async () => {
    const { ToolDispatcher } = await import('../services/mission/tool-dispatcher.js');
    const { RunCoordinator } = await import('../services/mission/coordinator.js');

    const companyId = await createCompany(db, '__mtest__ revoke-tools');
    const projectId = await createProject(db, companyId);
    const threadId = await createThread(db, companyId, projectId);
    const agentId = await createAgent(db, companyId, {
      toolsEnabled: ['research.search', 'artifact.create'],
      status: 'idle',
    });

    const service = new MissionStartService(db);
    const result = await service.start({
      companyId,
      projectId,
      idempotencyKey: 'revoke-tools-key',
      body: {
        projectThreadId: threadId,
        mode: 'fast',
        initiatingAgentId: agentId,
        request: { text: 'Test request for tool revocation' },
      },
      actorType: 'user',
      actorId: 'dev-user-000',
    });

    // Claim and advance to running.
    const coordinator = new RunCoordinator(db);
    const claim = await coordinator.claimNext('worker-test');
    expect(claim).not.toBeNull();
    expect(claim!.status).toBe('running');

    // Revoke: remove 'research.search' from agent's tools.
    await db.drizzle
      .update(db.schema.agents)
      .set({ toolsEnabled: ['artifact.create'] })
      .where(eq(db.schema.agents.id, agentId));

    // Attempt to dispatch 'research.search' — should be denied.
    const dispatcher = new ToolDispatcher(db);
    const authResult = await dispatcher.authorizeAndPrepare({
      companyId,
      projectId,
      runId: result.run.id,
      leaseToken: claim!.leaseToken,
      toolId: 'research.search',
      args: {},
      replayClass: 'read_only',
      stepKey: 'root',
      attempt: 1,
    });
    expect(authResult.authorized).toBe(false);
    expect(authResult.denialCode).toBe('TOOL_NOT_ALLOWED');
  });

  it('revoking agent status to offline before claim blocks the run from progressing', async () => {
    const { RunCoordinator } = await import('../services/mission/coordinator.js');
    const { RunProcessor } = await import('../services/mission/run-processor.js');

    const companyId = await createCompany(db, '__mtest__ revoke-offline');
    const projectId = await createProject(db, companyId);
    const threadId = await createThread(db, companyId, projectId);
    const agentId = await createAgent(db, companyId, {
      toolsEnabled: ['research.search'],
      status: 'idle',
    });

    const service = new MissionStartService(db);
    const result = await service.start({
      companyId,
      projectId,
      idempotencyKey: 'revoke-offline-key',
      body: {
        projectThreadId: threadId,
        mode: 'fast',
        initiatingAgentId: agentId,
        request: { text: 'Test request for agent offline' },
      },
      actorType: 'user',
      actorId: 'dev-user-000',
    });

    // Revoke: set agent status to 'offline' (simulates deletion/revocation).
    await db.drizzle
      .update(db.schema.agents)
      .set({ status: 'offline' })
      .where(eq(db.schema.agents.id, agentId));

    // Claim the run.
    const coordinator = new RunCoordinator(db);
    const claim = await coordinator.claimNext('worker-test');
    expect(claim).not.toBeNull();

    // Process — should fail safely.
    let providerCalled = false;
    const processor = new RunProcessor(db, {
      providerCall: async () => {
        providerCalled = true;
        return {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          content: 'test',
          inputTokens: 10,
          outputTokens: 5,
          costCents: 1,
          finishReason: 'stop',
          latencyMs: 100,
        };
      },
    });
    await processor.advance(claim!, new AbortController().signal);
    expect(providerCalled).toBe(false);

    const [finalRun] = await db.drizzle
      .select()
      .from(db.schema.missionRuns)
      .where(eq(db.schema.missionRuns.id, result.run.id));
    expect(['failed', 'cancelled']).toContain(finalRun.status);
  });

  it('later broadening never expands the immutable snapshot', async () => {
    const companyId = await createCompany(db, '__mtest__ revoke-broaden');
    const projectId = await createProject(db, companyId);
    const threadId = await createThread(db, companyId, projectId);
    const agentId = await createAgent(db, companyId, {
      toolsEnabled: ['research.search'],
      status: 'idle',
    });

    const service = new MissionStartService(db);
    const result = await service.start({
      companyId,
      projectId,
      idempotencyKey: 'revoke-broaden-key',
      body: {
        projectThreadId: threadId,
        mode: 'fast',
        initiatingAgentId: agentId,
        request: { text: 'Test request for broadening' },
      },
      actorType: 'user',
      actorId: 'dev-user-000',
    });

    // Capture the original policy snapshot hash.
    const [originalSnapshot] = await db.drizzle
      .select()
      .from(db.schema.runPolicySnapshots)
      .where(eq(db.schema.runPolicySnapshots.id, result.run.policySnapshotId!));
    const originalHash = originalSnapshot.contentHash;
    const originalTools = originalSnapshot.toolAllowlist as string[];

    // Broaden: add more tools to the agent.
    await db.drizzle
      .update(db.schema.agents)
      .set({ toolsEnabled: ['research.search', 'artifact.create', 'code.execute'] })
      .where(eq(db.schema.agents.id, agentId));

    // The policy snapshot must remain unchanged.
    const [unchangedSnapshot] = await db.drizzle
      .select()
      .from(db.schema.runPolicySnapshots)
      .where(eq(db.schema.runPolicySnapshots.id, result.run.policySnapshotId!));
    expect(unchangedSnapshot.contentHash).toBe(originalHash);
    expect(unchangedSnapshot.toolAllowlist).toEqual(originalTools);
  });
});

// ---------------------------------------------------------------------------
// Integration: preview endpoint via HTTP
// ---------------------------------------------------------------------------

describe('Policy preview endpoint (VAL-MODEQ-126 integration)', () => {
  let db: AnyDb;
  let app: ReturnType<typeof createTestApp>;

  beforeAll(async () => {
    db = await createTestDb();
    app = createTestApp(db);
  });

  beforeEach(() => {
    enableMissionFlag();
  });

  afterEach(async () => {
    await db.drizzle.execute(
      sql`DELETE FROM "agents" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "project_threads" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "projects" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(sql`DELETE FROM "companies" WHERE "name" LIKE '__mtest__%'`);
  });

  it('POST /preview returns a preview without creating a run', async () => {
    const companyId = await createCompany(db, '__mtest__ preview-co');
    const projectId = await createProject(db, companyId);
    const threadId = await createThread(db, companyId, projectId);
    const agentId = await createAgent(db, companyId, {
      toolsEnabled: ['research.search'],
    });
    const sessionId = await createSession(db, companyId);

    const res = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/mission-runs/preview`)
      .set('X-Eidolon-Test-Session-Id', sessionId)
      .send({
        projectThreadId: threadId,
        mode: 'fast',
        initiatingAgentId: agentId,
        request: { text: 'Preview test' },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.preview.kind).toBe('preview');
    expect(res.body.data.preview.previewKey).toBeDefined();
    expect(res.body.data.preview.resolvedMode).toBe('fast');

    // Verify no run was created.
    const runs = await db.drizzle
      .select()
      .from(db.schema.missionRuns)
      .where(eq(db.schema.missionRuns.companyId, companyId));
    expect(runs).toHaveLength(0);
  });

  it('preview narrows tools per company governance', async () => {
    const companyId = await createCompany(db, '__mtest__ preview-narrow', {
      testFixture: true,
      missionPolicy: {
        allowedTools: ['research.search'],
      },
    });
    const projectId = await createProject(db, companyId);
    const threadId = await createThread(db, companyId, projectId);
    const agentId = await createAgent(db, companyId, {
      toolsEnabled: ['research.search', 'artifact.create', 'code.execute'],
    });
    const sessionId = await createSession(db, companyId);

    const res = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/mission-runs/preview`)
      .set('X-Eidolon-Test-Session-Id', sessionId)
      .send({
        projectThreadId: threadId,
        mode: 'fast',
        initiatingAgentId: agentId,
        request: { text: 'Narrowing preview test' },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.preview.toolAllowlist).toEqual(['research.search']);
  });

  it('preview with unsatisfiable policy returns 422', async () => {
    const companyId = await createCompany(db, '__mtest__ preview-unsat', {
      testFixture: true,
      missionPolicy: {
        allowedProviders: ['google'],
      },
    });
    const projectId = await createProject(db, companyId);
    const threadId = await createThread(db, companyId, projectId);
    const agentId = await createAgent(db, companyId, { provider: 'anthropic' });
    const sessionId = await createSession(db, companyId);

    const res = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/mission-runs/preview`)
      .set('X-Eidolon-Test-Session-Id', sessionId)
      .send({
        projectThreadId: threadId,
        mode: 'fast',
        initiatingAgentId: agentId,
        request: { text: 'Unsatisfiable preview test' },
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('POLICY_UNSATISFIABLE');
  });
});

// ---------------------------------------------------------------------------
// Integration: start with company governance via HTTP
// ---------------------------------------------------------------------------

describe('Start with company governance (VAL-MODEQ-035, 036, 037 integration)', () => {
  let db: AnyDb;
  let app: ReturnType<typeof createTestApp>;

  beforeAll(async () => {
    db = await createTestDb();
    app = createTestApp(db);
  });

  beforeEach(() => {
    enableMissionFlag();
  });

  afterEach(async () => {
    await db.drizzle.execute(
      sql`DELETE FROM "run_tool_invocations" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "run_events" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "mission_runs" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "run_commands" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "run_policy_snapshots" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "budget_reservations" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "budget_allocations" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "budget_settlements" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "agents" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "project_threads" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(
      sql`DELETE FROM "projects" WHERE "company_id" IN (SELECT "id" FROM "companies" WHERE "name" LIKE '__mtest__%')`,
    );
    await db.drizzle.execute(sql`DELETE FROM "companies" WHERE "name" LIKE '__mtest__%'`);
  });

  it('start with company denied tools produces a snapshot without those tools', async () => {
    const companyId = await createCompany(db, '__mtest__ gov-deny', {
      testFixture: true,
      missionPolicy: {
        deniedTools: ['research.search'],
      },
    });
    const projectId = await createProject(db, companyId);
    const threadId = await createThread(db, companyId, projectId);
    const agentId = await createAgent(db, companyId, {
      toolsEnabled: ['research.search', 'artifact.create'],
    });
    const sessionId = await createSession(db, companyId);

    const res = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/mission-runs`)
      .set('X-Eidolon-Test-Session-Id', sessionId)
      .set('Idempotency-Key', 'gov-deny-key')
      .send({
        projectThreadId: threadId,
        mode: 'fast',
        initiatingAgentId: agentId,
        request: { text: 'Governed start test' },
      });

    expect(res.status).toBe(202);

    // Verify the policy snapshot excludes the denied tool.
    const [snapshot] = await db.drizzle
      .select()
      .from(db.schema.runPolicySnapshots)
      .where(eq(db.schema.runPolicySnapshots.id, res.body.data.run.policySnapshotId));
    const tools = snapshot.toolAllowlist as string[];
    expect(tools).not.toContain('research.search');
    expect(tools).toContain('artifact.create');
  });

  it('start with user removedTools narrows the snapshot', async () => {
    const companyId = await createCompany(db, '__mtest__ user-remove');
    const projectId = await createProject(db, companyId);
    const threadId = await createThread(db, companyId, projectId);
    const agentId = await createAgent(db, companyId, {
      toolsEnabled: ['research.search', 'artifact.create'],
    });
    const sessionId = await createSession(db, companyId);

    const res = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/mission-runs`)
      .set('X-Eidolon-Test-Session-Id', sessionId)
      .set('Idempotency-Key', 'user-remove-key')
      .send({
        projectThreadId: threadId,
        mode: 'fast',
        initiatingAgentId: agentId,
        request: { text: 'User removal test' },
        removedTools: ['research.search'],
      });

    expect(res.status).toBe(202);

    const [snapshot] = await db.drizzle
      .select()
      .from(db.schema.runPolicySnapshots)
      .where(eq(db.schema.runPolicySnapshots.id, res.body.data.run.policySnapshotId));
    const tools = snapshot.toolAllowlist as string[];
    expect(tools).not.toContain('research.search');
    expect(tools).toEqual(['artifact.create']);
  });

  it('start with unsatisfiable provider returns 422 and creates no run', async () => {
    const companyId = await createCompany(db, '__mtest__ unsat-provider', {
      testFixture: true,
      missionPolicy: {
        allowedProviders: ['google'],
      },
    });
    const projectId = await createProject(db, companyId);
    const threadId = await createThread(db, companyId, projectId);
    const agentId = await createAgent(db, companyId, { provider: 'anthropic' });
    const sessionId = await createSession(db, companyId);

    const res = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/mission-runs`)
      .set('X-Eidolon-Test-Session-Id', sessionId)
      .set('Idempotency-Key', 'unsat-provider-key')
      .send({
        projectThreadId: threadId,
        mode: 'fast',
        initiatingAgentId: agentId,
        request: { text: 'Unsatisfiable provider test' },
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('POLICY_UNSATISFIABLE');

    // Verify no run was created.
    const runs = await db.drizzle
      .select()
      .from(db.schema.missionRuns)
      .where(eq(db.schema.missionRuns.companyId, companyId));
    expect(runs).toHaveLength(0);
  });
});
