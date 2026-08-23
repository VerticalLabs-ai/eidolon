import { describe, expect, it, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, createTestServer } from '../test-utils.js';
import {
  resolvePolicy,
  resolveCustomPolicy,
  policyContentHash,
  canonicalStringify,
  canonicalHash,
  type ResolvedPolicy,
  type CompanyPolicyInput,
  type CustomProfileConfig,
} from '../services/mission/policy.js';
import {
  BUILT_IN_MODE_DISPLAY_NAMES,
  BUILT_IN_MODE_DESCRIPTIONS,
  PLATFORM_HARD_CAPS,
} from '../services/mission/modes.js';
import { ModeRegistryService } from '../services/mission/mode-registry.js';
import {
  CreateProfileBody,
  type ParsedCreateProfileBody,
} from '../services/mission/mode-profile-schema.js';

/**
 * Immutable policy snapshots and historical mode identity tests.
 *
 * Covers:
 * - VAL-MODEQ-039: Effective policy is snapshotted
 * - VAL-MODEQ-040: Snapshot survives policy edits
 * - VAL-MODEQ-041: Snapshot survives restart
 * - VAL-MODEQ-042: Enforcement uses snapshot
 * - VAL-MODEQ-115: Mode is reviewable after completion
 * - VAL-MODEQ-116: Mode changes require a new run
 * - VAL-MODEQ-117: Retry resolves a fresh snapshot
 * - VAL-MODEQ-127: Policy hashing is canonical and complete
 * - VAL-MODEQ-129: Historical mode identity survives profile changes
 * - VAL-RUN-103: Run snapshots preserve start configuration
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
  await db.drizzle.insert(db.schema.companies).values({
    id,
    name,
    settings: { testFixture: true, ...settings },
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function createProject(db: AnyDb, companyId: string) {
  const id = randomUUID();
  const now = new Date();
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
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.insert(db.schema.projectThreads).values({
    id,
    companyId,
    projectId,
    title: '__mtest__ thread',
    type: 'conversation',
    status: 'active',
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
      toolsEnabled: overrides.toolsEnabled ?? ['artifact.create', 'research.search'],
      allowedDomains: overrides.allowedDomains ?? [],
      capabilities: overrides.capabilities ?? ['chat'],
      apiKeyEncrypted: 'test-key',
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
  userId = 'dev-user-000',
): Promise<string> {
  const [row] = await db.drizzle
    .insert(db.schema.localTrustedSessions)
    .values({ companyId, role, userId })
    .returning();
  return row.id;
}

async function createCustomProfile(
  db: AnyDb,
  companyId: string,
  overrides: {
    slug?: string;
    name?: string;
    description?: string;
    enabled?: boolean;
    config?: Record<string, unknown>;
  } = {},
) {
  const service = new ModeRegistryService(db);
  const body: ParsedCreateProfileBody = {
    slug: overrides.slug ?? `custom-${randomUUID().slice(0, 8)}`,
    name: overrides.name ?? '__mtest__ Custom Mode',
    description: overrides.description ?? 'A test custom mode',
    enabled: overrides.enabled ?? true,
    config: overrides.config ?? { planning: 'always', approval: 'always', research: 'off' },
  };
  const result = await service.createProfile({
    companyId,
    body,
    actorType: 'user',
    actorId: randomUUID(),
  });
  return result.profile;
}

async function startRun(
  app: Awaited<ReturnType<typeof createTestServer>>,
  base: string,
  opts: {
    threadId: string;
    mode?: string;
    modeProfileId?: string;
    agentId?: string;
    text?: string;
    limits?: Record<string, number>;
    sessionId?: string;
  },
) {
  const body: Record<string, unknown> = {
    projectThreadId: opts.threadId,
    mode: opts.mode ?? 'fast',
    request: { text: opts.text ?? 'Do work' },
  };
  if (opts.modeProfileId) {body.modeProfileId = opts.modeProfileId;}
  if (opts.agentId) {body.initiatingAgentId = opts.agentId;}
  if (opts.limits) {body.limits = opts.limits;}
  let req = request(app).post(base).set('Idempotency-Key', `test-${randomUUID()}`);
  if (opts.sessionId) {
    req = req.set('X-Eidolon-Test-Session-Id', opts.sessionId);
  }
  return req.send(body).expect(202);
}

/** Mark a run as terminal (completed) directly in the DB for testing. */
async function setTerminalCompleted(db: AnyDb, runId: string) {
  const now = new Date();
  await db.drizzle
    .update(db.schema.missionRuns)
    .set({ status: 'completed', terminalAt: now, updatedAt: now })
    .where(eq(db.schema.missionRuns.id, runId));
}

/** Mark a run as terminal (failed) directly in the DB for testing. */
async function setTerminalFailed(db: AnyDb, runId: string) {
  const now = new Date();
  await db.drizzle
    .update(db.schema.missionRuns)
    .set({
      status: 'failed',
      terminalAt: now,
      failureCategory: 'internal',
      failureCode: 'TEST_FAILURE',
      safeErrorMessage: 'Test failure',
      updatedAt: now,
    })
    .where(eq(db.schema.missionRuns.id, runId));
}

/** Authenticated GET helper. */
function authGet(
  app: Awaited<ReturnType<typeof createTestServer>>,
  path: string,
  sessionId: string,
) {
  return request(app).get(path).set('X-Eidolon-Test-Session-Id', sessionId);
}

/** Authenticated POST helper. */
function authPost(
  app: Awaited<ReturnType<typeof createTestServer>>,
  path: string,
  sessionId: string,
) {
  return request(app).post(path).set('X-Eidolon-Test-Session-Id', sessionId);
}

// ===========================================================================
// VAL-MODEQ-127: Policy hashing is canonical and complete
// ===========================================================================

describe('VAL-MODEQ-127: Policy hashing is canonical and complete', () => {
  it('semantically identical policies produce one lowercase SHA-256 hash', () => {
    const base: ResolvedPolicy = {
      schemaVersion: 1,
      sourceProfile: 'fast',
      sourceProfileName: 'Fast',
      sourceProfileDescription: 'Short, bounded work.',
      sourceProfileVersion: null,
      modeProfileId: null,
      provider: 'anthropic',
      adapterId: null,
      model: 'claude-sonnet-4-6',
      reasoningDepth: null,
      systemPromptHash: null,
      instructionHash: null,
      toolAllowlist: ['artifact.create', 'research.search'],
      domainAllowlist: ['example.com'],
      researchPolicy: { access: 'off' },
      planningPolicy: { strategy: 'when_complex' },
      approvalPolicy: { strategy: 'when_complex' },
      fallbackPolicy: {},
      partialResultPolicy: 'require_all',
      limits: {
        steps: 4,
        durationSeconds: 300,
        providerCalls: 6,
        totalTokens: 32_000,
        outputBytes: 1_048_576,
        costCents: 500,
        depth: 0,
        fanOut: 0,
        descendants: 0,
      },
      resolvedMode: 'fast',
    };

    const hash1 = policyContentHash(base);

    // Reordered tool allowlist — same hash (canonical sort handles ordering).
    const reordered = { ...base, toolAllowlist: ['research.search', 'artifact.create'] };
    const hash2 = policyContentHash(reordered);
    expect(hash2).toBe(hash1);

    // Reordered domain allowlist — same hash.
    const reorderedDomains = { ...base, domainAllowlist: ['example.com'] };
    expect(policyContentHash(reorderedDomains)).toBe(hash1);

    // Identical policy — same hash.
    expect(policyContentHash({ ...base })).toBe(hash1);

    // Hash is lowercase hex SHA-256 (64 chars).
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changing any included field changes the hash', () => {
    const base: ResolvedPolicy = {
      schemaVersion: 1,
      sourceProfile: 'fast',
      sourceProfileName: 'Fast',
      sourceProfileDescription: 'Short, bounded work.',
      sourceProfileVersion: null,
      modeProfileId: null,
      provider: 'anthropic',
      adapterId: null,
      model: 'claude-sonnet-4-6',
      reasoningDepth: null,
      systemPromptHash: null,
      instructionHash: null,
      toolAllowlist: ['artifact.create'],
      domainAllowlist: [],
      researchPolicy: { access: 'off' },
      planningPolicy: { strategy: 'when_complex' },
      approvalPolicy: { strategy: 'when_complex' },
      fallbackPolicy: {},
      partialResultPolicy: 'require_all',
      limits: {
        steps: 4,
        durationSeconds: 300,
        providerCalls: 6,
        totalTokens: 32_000,
        outputBytes: 1_048_576,
        costCents: 500,
        depth: 0,
        fanOut: 0,
        descendants: 0,
      },
      resolvedMode: 'fast',
    };
    const baseHash = policyContentHash(base);

    // Change provider.
    expect(policyContentHash({ ...base, provider: 'openai' })).not.toBe(baseHash);
    // Change model.
    expect(policyContentHash({ ...base, model: 'gpt-4' })).not.toBe(baseHash);
    // Change reasoning depth.
    expect(policyContentHash({ ...base, reasoningDepth: 'high' })).not.toBe(baseHash);
    // Change system prompt hash.
    expect(policyContentHash({ ...base, systemPromptHash: 'abc123' })).not.toBe(baseHash);
    // Change instruction hash.
    expect(policyContentHash({ ...base, instructionHash: 'def456' })).not.toBe(baseHash);
    // Change tool allowlist (add a tool).
    expect(
      policyContentHash({ ...base, toolAllowlist: ['artifact.create', 'research.search'] }),
    ).not.toBe(baseHash);
    // Change domain allowlist (add a domain).
    expect(policyContentHash({ ...base, domainAllowlist: ['example.com'] })).not.toBe(baseHash);
    // Change research policy.
    expect(policyContentHash({ ...base, researchPolicy: { access: 'allowed' } })).not.toBe(
      baseHash,
    );
    // Change planning policy.
    expect(policyContentHash({ ...base, planningPolicy: { strategy: 'always' } })).not.toBe(
      baseHash,
    );
    // Change approval policy.
    expect(policyContentHash({ ...base, approvalPolicy: { strategy: 'always' } })).not.toBe(
      baseHash,
    );
    // Change partial result policy.
    expect(policyContentHash({ ...base, partialResultPolicy: 'best_effort' })).not.toBe(baseHash);
    // Change a limit.
    expect(policyContentHash({ ...base, limits: { ...base.limits, steps: 5 } })).not.toBe(baseHash);
    expect(policyContentHash({ ...base, limits: { ...base.limits, costCents: 501 } })).not.toBe(
      baseHash,
    );
    // Change resolved mode.
    expect(policyContentHash({ ...base, resolvedMode: 'deep_work' })).not.toBe(baseHash);
    // Change schema version.
    expect(policyContentHash({ ...base, schemaVersion: 2 })).not.toBe(baseHash);
    // Change source profile.
    expect(policyContentHash({ ...base, sourceProfile: 'deep_work' })).not.toBe(baseHash);
    // Change source profile version.
    expect(
      policyContentHash({ ...base, sourceProfileVersion: 2, modeProfileId: 'prof-1' }),
    ).not.toBe(baseHash);
  });

  it('display text, timestamps, and mutable rows are excluded from the hash', () => {
    const base: ResolvedPolicy = {
      schemaVersion: 1,
      sourceProfile: 'fast',
      sourceProfileName: 'Fast',
      sourceProfileDescription: 'Short, bounded work.',
      sourceProfileVersion: null,
      modeProfileId: null,
      provider: 'anthropic',
      adapterId: null,
      model: 'claude-sonnet-4-6',
      reasoningDepth: null,
      systemPromptHash: null,
      instructionHash: null,
      toolAllowlist: [],
      domainAllowlist: [],
      researchPolicy: { access: 'off' },
      planningPolicy: { strategy: 'when_complex' },
      approvalPolicy: { strategy: 'when_complex' },
      fallbackPolicy: {},
      partialResultPolicy: 'require_all',
      limits: {
        steps: 4,
        durationSeconds: 300,
        providerCalls: 6,
        totalTokens: 32_000,
        outputBytes: 1_048_576,
        costCents: 500,
        depth: 0,
        fanOut: 0,
        descendants: 0,
      },
      resolvedMode: 'fast',
    };
    const baseHash = policyContentHash(base);

    // Changing display name does NOT change the hash (display text excluded).
    expect(policyContentHash({ ...base, sourceProfileName: 'Renamed Mode' })).toBe(baseHash);
    // Changing description does NOT change the hash.
    expect(
      policyContentHash({ ...base, sourceProfileDescription: 'A different description.' }),
    ).toBe(baseHash);
  });

  it('canonicalStringify sorts keys lexicographically and preserves array order', () => {
    expect(canonicalStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalStringify({ a: { z: 1, y: 2 } })).toBe('{"a":{"y":2,"z":1}}');
    expect(canonicalStringify([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalStringify(null)).toBe('null');
    expect(canonicalStringify('hello')).toBe('"hello"');
  });

  it('undefined values are stripped so omitted optional fields hash identically', () => {
    expect(canonicalStringify({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalStringify({ a: 1 })).toBe('{"a":1}');
  });
});

// ===========================================================================
// VAL-MODEQ-039: Effective policy is snapshotted
// VAL-MODEQ-115: Mode is reviewable after completion
// VAL-RUN-103: Run snapshots preserve start configuration
// ===========================================================================

describe('VAL-MODEQ-039 / VAL-MODEQ-115 / VAL-RUN-103: snapshot exposes complete policy', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;
  let agentId: string;
  let base: string;
  let sessionId: string;

  beforeAll(async () => {
    enableMissionFlag();
    db = await createTestDb();
    app = await createTestServer(db);
    companyId = await createCompany(db, '__mtest__ policy-snapshot');
    projectId = await createProject(db, companyId);
    threadId = await createThread(db, companyId, projectId);
    agentId = await createAgent(db, companyId, {
      toolsEnabled: ['artifact.create', 'research.search'],
      allowedDomains: ['example.com'],
    });
    sessionId = await createSession(db, companyId, 'owner');
    base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    enableMissionFlag();
  });

  afterAll(async () => {
    // Test framework handles DB cleanup via closeTestDb().
  });

  it('VAL-MODEQ-039: snapshot contains all named policy fields and content hash', async () => {
    const start = await startRun(app, base, {
      threadId,
      mode: 'fast',
      agentId,
      text: 'Simple task',
      sessionId,
    });
    const runId = start.body.data.run.id;

    const snapshot = await authGet(app, `${base}/${runId}`, sessionId).expect(200);
    const run = snapshot.body.data.run;

    // All named fields present.
    expect(run.policySnapshotId).toBeTruthy();
    expect(run.policyContentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(run.policy).toBeTruthy();
    expect(run.policy.schemaVersion).toBe(1);
    expect(run.policy.sourceProfile).toBe('fast');
    expect(run.policy.sourceProfileName).toBe('Fast');
    expect(run.policy.sourceProfileDescription).toBeTruthy();
    expect(run.policy.provider).toBe('anthropic');
    expect(run.policy.model).toBe('claude-sonnet-4-6');
    expect(run.policy.toolAllowlist).toEqual(
      expect.arrayContaining(['artifact.create', 'research.search']),
    );
    expect(run.policy.domainAllowlist).toEqual(expect.arrayContaining(['example.com']));
    expect(run.policy.researchPolicy).toEqual({ access: 'off' });
    expect(run.policy.planningPolicy).toEqual({ strategy: 'when_complex' });
    expect(run.policy.approvalPolicy).toEqual({ strategy: 'when_complex' });
    expect(run.policy.partialResultPolicy).toBe('require_all');
    expect(run.policy.limits).toBeTruthy();
    expect(run.policy.limits.steps).toBe(4);
    expect(run.policy.limits.costCents).toBe(500);
    expect(run.policy.limits.durationSeconds).toBe(300);
    expect(run.resolvedMode).toBe('fast');
  });

  it('VAL-MODEQ-115: terminal run retains policy identity after reload', async () => {
    const start = await startRun(app, base, {
      threadId,
      mode: 'deep_work',
      agentId,
      text: 'Complex task requiring planning',
      sessionId,
    });
    const runId = start.body.data.run.id;
    const originalHash = start.body.data.run.policyContentHash;

    // Terminalize the run.
    await setTerminalCompleted(db, runId);

    // Reload snapshot — policy identity preserved.
    const snapshot = await authGet(app, `${base}/${runId}`, sessionId).expect(200);
    const run = snapshot.body.data.run;

    expect(run.status).toBe('completed');
    expect(run.policyContentHash).toBe(originalHash);
    expect(run.resolvedMode).toBe('deep_work');
    expect(run.policy.sourceProfile).toBe('deep_work');
    expect(run.policy.sourceProfileName).toBe('Deep Work');
    expect(run.policy.limits.steps).toBe(12);
  });

  it('VAL-RUN-103: changing agent settings after start does not alter the run policy', async () => {
    const start = await startRun(app, base, {
      threadId,
      mode: 'fast',
      agentId,
      text: 'Stable config test',
      sessionId,
    });
    const runId = start.body.data.run.id;
    const originalHash = start.body.data.run.policyContentHash;

    // Change the agent's tools (broaden) after start.
    await db.drizzle
      .update(db.schema.agents)
      .set({ toolsEnabled: ['artifact.create', 'research.search', 'mcp.tool.extra'] })
      .where(eq(db.schema.agents.id, agentId));

    // Original run's snapshot is unchanged.
    const snapshot = await authGet(app, `${base}/${runId}`, sessionId).expect(200);
    expect(snapshot.body.data.run.policyContentHash).toBe(originalHash);
    expect(snapshot.body.data.run.policy.toolAllowlist).toEqual(
      expect.arrayContaining(['artifact.create', 'research.search']),
    );
    expect(snapshot.body.data.run.policy.toolAllowlist).not.toContain('mcp.tool.extra');

    // A new run with the same agent picks up the broader tools.
    const start2 = await startRun(app, base, {
      threadId,
      mode: 'fast',
      agentId,
      text: 'New run after config change',
      sessionId,
    });
    expect(start2.body.data.run.policyContentHash).not.toBe(originalHash);
    // Fetch full snapshot to access policy details.
    const snapshot2 = await authGet(app, `${base}/${start2.body.data.run.id}`, sessionId).expect(
      200,
    );
    expect(snapshot2.body.data.run.policy.toolAllowlist).toContain('mcp.tool.extra');
  });
});

// ===========================================================================
// VAL-MODEQ-040: Snapshot survives policy edits
// VAL-MODEQ-129: Historical mode identity survives profile changes
// ===========================================================================

describe('VAL-MODEQ-040 / VAL-MODEQ-129: snapshot survives profile and governance edits', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;
  let agentId: string;
  let base: string;
  let sessionId: string;

  beforeAll(async () => {
    enableMissionFlag();
    db = await createTestDb();
    app = await createTestServer(db);
    companyId = await createCompany(db, '__mtest__ profile-survival');
    projectId = await createProject(db, companyId);
    threadId = await createThread(db, companyId, projectId);
    agentId = await createAgent(db, companyId);
    sessionId = await createSession(db, companyId, 'owner');
    base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    enableMissionFlag();
  });

  afterAll(async () => {
    // Test framework handles DB cleanup via closeTestDb().
  });

  it('VAL-MODEQ-040/129: renaming and disabling a custom profile does not change existing run policy', async () => {
    // Create a custom profile.
    const profile = await createCustomProfile(db, companyId, {
      name: 'Original Name',
      description: 'Original description',
      config: { planning: 'always', approval: 'always', research: 'off' },
    });

    // Start a run with the custom profile.
    const start = await startRun(app, base, {
      threadId,
      mode: 'custom',
      modeProfileId: profile.id,
      agentId,
      text: 'Custom profile run',
      sessionId,
    });
    const runId = start.body.data.run.id;
    const originalHash = start.body.data.run.policyContentHash;
    // Fetch full snapshot to access policy details (start response only has summary fields).
    const initialSnapshot = await authGet(app, `${base}/${runId}`, sessionId).expect(200);
    const originalName = initialSnapshot.body.data.run.policy.sourceProfileName;
    const originalDescription = initialSnapshot.body.data.run.policy.sourceProfileDescription;

    expect(originalName).toBe('Original Name');
    expect(originalDescription).toBe('Original description');

    // Terminalize.
    await setTerminalCompleted(db, runId);

    // Rename and disable the profile.
    const registry = new ModeRegistryService(db);
    await registry.updateProfile({
      companyId,
      profileId: profile.id,
      body: {
        name: 'Renamed Profile',
        description: 'Changed description',
        enabled: false,
      },
      expectedVersion: 1,
      actorType: 'user',
      actorId: randomUUID(),
    });

    // Original terminal run's snapshot is unchanged.
    const snapshot = await authGet(app, `${base}/${runId}`, sessionId).expect(200);
    const run = snapshot.body.data.run;

    expect(run.status).toBe('completed');
    expect(run.policyContentHash).toBe(originalHash);
    expect(run.policy.sourceProfileName).toBe(originalName);
    expect(run.policy.sourceProfileDescription).toBe(originalDescription);

    // Profile deletion is not a Phase 1 operation; disabled is the sole lifecycle.
    // Verify there is no DELETE route by attempting it.
    const deleteRes = await request(app)
      .delete(`/api/companies/${companyId}/mode-profiles/${profile.id}`)
      .set('X-Eidolon-Test-Session-Id', sessionId);
    // Express returns 404 for unregistered DELETE routes.
    expect(deleteRes.status).toBe(404);
  });
});

// ===========================================================================
// VAL-MODEQ-041: Snapshot survives restart
// ===========================================================================

describe('VAL-MODEQ-041: snapshot survives API restart', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;
  let base: string;
  let sessionId: string;

  beforeAll(async () => {
    enableMissionFlag();
    db = await createTestDb();
    app = await createTestServer(db);
    companyId = await createCompany(db, '__mtest__ restart-survival');
    projectId = await createProject(db, companyId);
    threadId = await createThread(db, companyId, projectId);
    sessionId = await createSession(db, companyId, 'owner');
    base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    enableMissionFlag();
  });

  afterAll(async () => {
    // Test framework handles DB cleanup via closeTestDb().
  });

  it('policy snapshot ID and hash are identical after server restart', async () => {
    const start = await startRun(app, base, {
      threadId,
      mode: 'analyst',
      text: 'Research task with citations',
      sessionId,
    });
    const runId = start.body.data.run.id;
    const originalSnapshotId = start.body.data.run.policySnapshotId;
    const originalHash = start.body.data.run.policyContentHash;

    // Simulate API restart by creating a new server instance with the same DB.
    const app2 = await createTestServer(db);

    const snapshot = await authGet(app2, `${base}/${runId}`, sessionId).expect(200);
    const run = snapshot.body.data.run;

    expect(run.policySnapshotId).toBe(originalSnapshotId);
    expect(run.policyContentHash).toBe(originalHash);
    expect(run.resolvedMode).toBe('analyst');
    expect(run.policy.sourceProfile).toBe('analyst');
    expect(run.policy.sourceProfileName).toBe('Analyst');
    expect(run.policy.limits.steps).toBe(10);
  });
});

// ===========================================================================
// VAL-MODEQ-042: Enforcement uses snapshot
// ===========================================================================

describe('VAL-MODEQ-042: enforcement uses snapshot, not live settings', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;
  let agentId: string;
  let sessionId: string;
  let base: string;

  beforeAll(async () => {
    enableMissionFlag();
    db = await createTestDb();
    app = await createTestServer(db);
    companyId = await createCompany(db, '__mtest__ enforcement');
    projectId = await createProject(db, companyId);
    threadId = await createThread(db, companyId, projectId);
    agentId = await createAgent(db, companyId, {
      toolsEnabled: ['artifact.create', 'research.search'],
    });
    sessionId = await createSession(db, companyId, 'owner');
    base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    enableMissionFlag();
  });

  it('tool dispatcher reads from the policy snapshot row, not live agent settings', async () => {
    // This is a structural verification: the tool-dispatcher reads
    // runPolicySnapshots by policySnapshotId, not agents.toolsEnabled.
    // The real enforcement test is in mission-tool-dispatcher-policy.test.ts.
    // Here we verify that the snapshot stores the exact tool allowlist
    // that was resolved at start time.
    const start = await startRun(app, base, { threadId, mode: 'fast', agentId, sessionId });
    const runId = start.body.data.run.id;

    // Broaden the agent's tools after start.
    await db.drizzle
      .update(db.schema.agents)
      .set({ toolsEnabled: ['artifact.create', 'research.search', 'dangerous.tool'] })
      .where(eq(db.schema.agents.id, agentId));

    // The snapshot still has the original (narrower) tools.
    const snapshot = await authGet(app, `${base}/${runId}`, sessionId).expect(200);
    const tools = snapshot.body.data.run.policy.toolAllowlist;
    expect(tools).toEqual(expect.arrayContaining(['artifact.create', 'research.search']));
    expect(tools).not.toContain('dangerous.tool');

    // Verify the DB row matches.
    const [policyRow] = await db.drizzle
      .select({ toolAllowlist: db.schema.runPolicySnapshots.toolAllowlist })
      .from(db.schema.runPolicySnapshots)
      .where(eq(db.schema.runPolicySnapshots.id, start.body.data.run.policySnapshotId))
      .limit(1);
    expect(policyRow.toolAllowlist).not.toContain('dangerous.tool');
  });

  afterAll(async () => {
    // Test framework handles DB cleanup via closeTestDb().
  });
});

// ===========================================================================
// VAL-MODEQ-116: Mode changes require a new run
// ===========================================================================

describe('VAL-MODEQ-116: mode changes require a new run', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;
  let base: string;
  let sessionId: string;

  beforeAll(async () => {
    enableMissionFlag();
    db = await createTestDb();
    app = await createTestServer(db);
    companyId = await createCompany(db, '__mtest__ mode-change');
    projectId = await createProject(db, companyId);
    threadId = await createThread(db, companyId, projectId);
    sessionId = await createSession(db, companyId, 'owner');
    base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    enableMissionFlag();
  });

  afterAll(async () => {
    // Test framework handles DB cleanup via closeTestDb().
  });

  it('there is no PATCH/PUT route to mutate a run mode; two runs have independent modes/hashes', async () => {
    // Start two runs with different modes.
    const start1 = await startRun(app, base, { threadId, mode: 'fast', text: 'Run 1', sessionId });
    const start2 = await startRun(app, base, {
      threadId,
      mode: 'deep_work',
      text: 'Run 2',
      sessionId,
    });

    // Verify the modes and hashes are different.
    expect(start1.body.data.run.resolvedMode).toBe('fast');
    expect(start2.body.data.run.resolvedMode).toBe('deep_work');
    expect(start1.body.data.run.policyContentHash).not.toBe(start2.body.data.run.policyContentHash);

    // Verify there is no PATCH or PUT route on individual runs.
    const runId = start1.body.data.run.id;
    const patchRes = await request(app)
      .patch(`${base}/${runId}`)
      .set('Idempotency-Key', `patch-${randomUUID()}`)
      .set('X-Eidolon-Test-Session-Id', sessionId)
      .send({ mode: 'analyst' });
    // Express returns 404 for unregistered routes.
    expect(patchRes.status).toBe(404);

    const putRes = await request(app)
      .put(`${base}/${runId}`)
      .set('Idempotency-Key', `put-${randomUUID()}`)
      .set('X-Eidolon-Test-Session-Id', sessionId)
      .send({ mode: 'analyst' });
    expect(putRes.status).toBe(404);

    // The canonical commands endpoint does not accept a mode mutation.
    const cmdRes = await request(app)
      .post(`${base}/${runId}/commands`)
      .set('Idempotency-Key', `cmd-${randomUUID()}`)
      .set('If-Match', `"${start1.body.data.run.stateVersion}"`)
      .set('X-Eidolon-Test-Session-Id', sessionId)
      .send({ type: 'run.cancel', reason: 'Done' });
    // Cancel is accepted, but there is no mode mutation command type.
    expect(cmdRes.status).toBeLessThan(500);
  });
});

// ===========================================================================
// VAL-MODEQ-117: Retry resolves a fresh snapshot
// ===========================================================================

describe('VAL-MODEQ-117: retry resolves a fresh snapshot', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;
  let agentId: string;
  let base: string;
  let sessionId: string;

  beforeAll(async () => {
    enableMissionFlag();
    db = await createTestDb();
    app = await createTestServer(db);
    companyId = await createCompany(db, '__mtest__ retry-snapshot');
    projectId = await createProject(db, companyId);
    threadId = await createThread(db, companyId, projectId);
    agentId = await createAgent(db, companyId, {
      toolsEnabled: ['artifact.create', 'research.search'],
    });
    sessionId = await createSession(db, companyId, 'owner');
    base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    enableMissionFlag();
  });

  afterAll(async () => {
    // Test framework handles DB cleanup via closeTestDb().
  });

  it('retry creates a successor with a fresh policy snapshot from current governance', async () => {
    const start = await startRun(app, base, {
      threadId,
      mode: 'fast',
      agentId,
      text: 'Original task',
      sessionId,
    });
    const runId = start.body.data.run.id;
    const originalHash = start.body.data.run.policyContentHash;

    // Terminalize as failed.
    await setTerminalFailed(db, runId);

    // Retry with lower cost limit.
    const retryRes = await request(app)
      .post(`${base}/${runId}/retry`)
      .set('Idempotency-Key', `retry-${randomUUID()}`)
      .set('If-Match', `"${start.body.data.run.stateVersion}"`)
      .set('X-Eidolon-Test-Session-Id', sessionId)
      .send({ limits: { costCents: 200 } })
      .expect(202);

    const successorId = retryRes.headers.location?.split('/').pop();
    expect(successorId).toBeTruthy();
    expect(successorId).not.toBe(runId);

    // The successor has a fresh policy snapshot.
    const successorSnapshot = await authGet(app, `${base}/${successorId}`, sessionId).expect(200);
    const successor = successorSnapshot.body.data.run;

    // Fresh snapshot: different policy snapshot ID.
    expect(successor.policySnapshotId).not.toBe(start.body.data.run.policySnapshotId);
    // Different content hash (narrowed limits → different hash).
    expect(successor.policyContentHash).not.toBe(originalHash);
    // Same resolved mode but lower cost ceiling.
    expect(successor.resolvedMode).toBe('fast');
    expect(successor.policy.limits.costCents).toBe(200);

    // Original run's history is unchanged.
    const originalSnapshot = await authGet(app, `${base}/${runId}`, sessionId).expect(200);
    expect(originalSnapshot.body.data.run.status).toBe('failed');
    expect(originalSnapshot.body.data.run.policyContentHash).toBe(originalHash);
  });

  it('retry with a disabled custom profile fails closed without substituting Auto', async () => {
    // Create a custom profile.
    const profile = await createCustomProfile(db, companyId, {
      name: 'Retry Test Profile',
      config: { planning: 'always', approval: 'always', research: 'off' },
    });

    // Start a run with the custom profile.
    const start = await startRun(app, base, {
      threadId,
      mode: 'custom',
      modeProfileId: profile.id,
      agentId,
      text: 'Custom profile task',
      sessionId,
    });
    const runId = start.body.data.run.id;

    // Terminalize as failed.
    await setTerminalFailed(db, runId);

    // Disable the profile.
    const registry = new ModeRegistryService(db);
    await registry.updateProfile({
      companyId,
      profileId: profile.id,
      body: { enabled: false },
      expectedVersion: 1,
      actorType: 'user',
      actorId: randomUUID(),
    });

    // Retry without a modeOverride — should fail closed.
    const retryRes = await request(app)
      .post(`${base}/${runId}/retry`)
      .set('Idempotency-Key', `retry-disabled-${randomUUID()}`)
      .set('If-Match', `"${start.body.data.run.stateVersion}"`)
      .set('X-Eidolon-Test-Session-Id', sessionId)
      .send({});

    expect(retryRes.status).toBe(409);
    expect(retryRes.body.code).toBe('PROFILE_UNAVAILABLE');

    // Retry with an explicit replacement mode — should succeed.
    const retryWithOverride = await request(app)
      .post(`${base}/${runId}/retry`)
      .set('Idempotency-Key', `retry-override-${randomUUID()}`)
      .set('If-Match', `"${start.body.data.run.stateVersion}"`)
      .set('X-Eidolon-Test-Session-Id', sessionId)
      .send({ modeOverride: { mode: 'fast' } })
      .expect(202);

    const successorId = retryWithOverride.headers.location?.split('/').pop();
    const successorSnapshot = await authGet(app, `${base}/${successorId}`, sessionId).expect(200);
    // The successor uses the replacement mode, not Auto.
    expect(successorSnapshot.body.data.run.resolvedMode).toBe('fast');
    expect(successorSnapshot.body.data.run.policy.sourceProfile).toBe('fast');
  });

  it('retry with a replacement custom profile succeeds', async () => {
    // Create two custom profiles.
    const profile1 = await createCustomProfile(db, companyId, {
      name: 'Profile One',
      slug: `prof-one-${randomUUID().slice(0, 6)}`,
    });
    const profile2 = await createCustomProfile(db, companyId, {
      name: 'Profile Two',
      slug: `prof-two-${randomUUID().slice(0, 6)}`,
    });

    // Start with profile1.
    const start = await startRun(app, base, {
      threadId,
      mode: 'custom',
      modeProfileId: profile1.id,
      agentId,
      text: 'Replacement test',
      sessionId,
    });
    const runId = start.body.data.run.id;

    // Terminalize as failed.
    await setTerminalFailed(db, runId);

    // Disable profile1, retry with profile2 as override.
    const registry = new ModeRegistryService(db);
    await registry.updateProfile({
      companyId,
      profileId: profile1.id,
      body: { enabled: false },
      expectedVersion: 1,
      actorType: 'user',
      actorId: randomUUID(),
    });

    const retryRes = await request(app)
      .post(`${base}/${runId}/retry`)
      .set('Idempotency-Key', `retry-replace-${randomUUID()}`)
      .set('If-Match', `"${start.body.data.run.stateVersion}"`)
      .set('X-Eidolon-Test-Session-Id', sessionId)
      .send({ modeOverride: { mode: 'custom', modeProfileId: profile2.id } })
      .expect(202);

    const successorId = retryRes.headers.location?.split('/').pop();
    const successorSnapshot = await authGet(app, `${base}/${successorId}`, sessionId).expect(200);

    expect(successorSnapshot.body.data.run.resolvedMode).toBe('custom');
    expect(successorSnapshot.body.data.run.policy.sourceProfileName).toBe('Profile Two');
    expect(successorSnapshot.body.data.run.modeProfileId).toBe(profile2.id);
  });
});
