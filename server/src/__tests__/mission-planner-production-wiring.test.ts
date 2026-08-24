import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer, closeTestServers, closeTestDb } from '../test-utils.js';
import { PlannerService } from '../services/mission/planner.js';
import {
  ProductionPlanGenerator,
  isTestHarnessEnabled,
  HARNESS_ENV_FLAG,
} from '../services/mission/planner-harness.js';
import { RunCoordinator } from '../services/mission/coordinator.js';
import { RunProcessor } from '../services/mission/run-processor.js';
import { PLAN_CONTENT_SCHEMA_VERSION } from '../services/mission/plan-schema.js';
import type { ChatMessage, CompletionResult, ProviderConfig } from '../providers/types.js';

/**
 * Production planner wiring (fix-ut-m3-planner-production-wiring).
 *
 * Verifies that the production worker path — `RunProcessor(db, { planner })`
 * where `planner = new PlannerService(db, { generator: new ProductionPlanGenerator() })`
 * — actually invokes the planner for runs entering the `planning` state and
 * produces `plan.proposed` events with a transition to `awaiting_approval`.
 *
 * The 224 existing integration tests prove the planning/approval logic works
 * with the nonproduction `PlannerTestHarness`; these tests prove the
 * production wiring and the real `ProductionPlanGenerator` parsing path.
 *
 * Covers VAL-PLAN-003..009 (production planner invocation), and the
 * MISSION_PLANNER_HARNESS env gate remaining closed in production.
 */

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

function enableMissionFlag() {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify({ missionAgentIntelligence: { enabled: true } }),
  );
}

async function seedScope(db: AnyDb, label: string) {
  const companyId = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "companies" ("id", "name", "status", "budget_monthly_cents", "spent_monthly_cents", "settings", "created_at", "updated_at")
    VALUES (${companyId}, ${label}, 'active', 100000, 0, '{"testFixture": true}'::jsonb, ${now}, ${now})
  `);
  const projectId = randomUUID();
  await db.drizzle.execute(sql`
    INSERT INTO "projects" ("id", "company_id", "name", "status", "created_at", "updated_at")
    VALUES (${projectId}, ${companyId}, 'P', 'active', ${now}, ${now})
  `);
  const threadId = randomUUID();
  await db.drizzle.execute(sql`
    INSERT INTO "project_threads" ("id", "company_id", "project_id", "title", "type", "status", "created_at", "updated_at")
    VALUES (${threadId}, ${companyId}, ${projectId}, 'T', 'conversation', 'active', ${now}, ${now})
  `);
  return { companyId, projectId, threadId };
}

/** Build a valid minimal PlanContentV1 for testing. */
function validPlanContent(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: PLAN_CONTENT_SCHEMA_VERSION,
    objective: 'Analyze the quarterly report',
    steps: [
      {
        stepKey: 'step-1',
        parentStepKey: null,
        childOrdinal: 0,
        nodeKind: 'root',
        title: 'Gather data',
        description: 'Collect the quarterly data',
        dependencies: [],
        inputBindings: [],
        routing: {
          kind: 'requirements',
          routingRequirements: {
            capabilities: ['analysis'],
            requiredTools: ['research.search'],
            requiredDomains: [],
            ephemeralAllowed: true,
          },
        },
        toolAllowlist: ['research.search'],
        replayClass: 'read_only',
        sideEffecting: false,
        expectedOutputs: ['report-data'],
        evidenceRequirements: { citationsRequired: false },
        completionCriteria: 'Data collected',
        budgetCents: 100,
        limits: {},
      },
    ],
    synthesis: {
      instructions: 'Synthesize the report',
      declaredInputs: [{ kind: 'stepOutput', stepKey: 'step-1', output: 'report-data' }],
      declaredOutput: 'final-report',
      evidenceRequirements: { citationsRequired: false },
      completionCriteria: 'Report complete',
      budgetCents: 100,
    },
    planningBudgetCents: 100,
    partialResultPolicy: 'require_all',
    limits: {
      steps: 4,
      durationSeconds: 300,
      providerCalls: 6,
      totalTokens: 32000,
      outputBytes: 1048576,
      costCents: 500,
      depth: 0,
      fanOut: 0,
      descendants: 0,
    },
    presentationMetadata: { cardTitle: 'Quarterly Analysis', summary: 'Analyze Q3 data' },
    ...overrides,
  };
}

async function startPlanningRun(
  app: Awaited<ReturnType<typeof createTestServer>>,
  base: string,
  threadId: string,
  text = 'Analyze the quarterly report with multiple deliverables and dependencies',
) {
  return request(app)
    .post(base)
    .set('Idempotency-Key', `plan-${randomUUID()}`)
    .send({ projectThreadId: threadId, mode: 'deep_work', request: { text } })
    .expect(202);
}

async function getRunRow(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "status", "state_version", "last_event_sequence", "current_plan_revision_id",
           "approved_plan_revision_id", "terminal_at", "failure_category", "failure_code"
    FROM "mission_runs" WHERE "id" = ${runId}
  `)) as unknown as Array<Record<string, unknown>>;
  if (!rows[0]) {
    return null;
  }
  const row = rows[0];
  return {
    status: row['status'] as string,
    stateVersion: Number(row['state_version']),
    lastEventSequence: Number(row['last_event_sequence']),
    currentPlanRevisionId: (row['current_plan_revision_id'] as string) ?? null,
    approvedPlanRevisionId: (row['approved_plan_revision_id'] as string) ?? null,
    terminalAt: (row['terminal_at'] as string | Date) ?? null,
    failureCategory: (row['failure_category'] as string) ?? null,
    failureCode: (row['failure_code'] as string) ?? null,
  };
}

async function getEvents(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "sequence", "type", "payload"
    FROM "run_events" WHERE "run_id" = ${runId}
    ORDER BY "sequence" ASC
  `)) as unknown as Array<{
    sequence: string | number;
    type: string;
    payload: Record<string, unknown>;
  }>;
  return rows.map((r) => ({ ...r, sequence: Number(r.sequence) }));
}

async function getPlanRevisions(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "id", "revision", "status", "content_hash"
    FROM "run_plan_revisions" WHERE "run_id" = ${runId}
    ORDER BY "revision" ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r['id'] as string,
    revision: r['revision'] as number,
    status: r['status'] as string,
    contentHash: r['content_hash'] as string,
  }));
}

/** Build a stub provider call returning a JSON plan string. */
function stubPlanProviderCall(
  plan: unknown,
  capture?: { messages?: ChatMessage[]; config?: ProviderConfig },
): (messages: ChatMessage[], config: ProviderConfig) => Promise<CompletionResult> {
  return async (messages, config) => {
    if (capture) {
      capture.messages = messages;
      capture.config = config;
    }
    return {
      provider: 'anthropic',
      model: config.model,
      content: JSON.stringify(plan),
      inputTokens: 120,
      outputTokens: 480,
      costCents: 3,
      finishReason: 'end_turn',
      latencyMs: 42,
    };
  };
}

afterEach(async () => {
  await closeTestServers();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// MISSION_PLANNER_HARNESS env gate stays closed in production
// ---------------------------------------------------------------------------

describe('MISSION_PLANNER_HARNESS env gate (production)', () => {
  beforeEach(() => {
    // Ensure the harness flag is NOT set — production never sets it.
    vi.stubEnv(HARNESS_ENV_FLAG, '0');
  });

  it('is closed in production: isTestHarnessEnabled() is false', () => {
    expect(isTestHarnessEnabled()).toBe(false);
  });

  it('ProductionPlanGenerator can be constructed without the harness flag', () => {
    expect(() => new ProductionPlanGenerator()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ProductionPlanGenerator unit tests
// ---------------------------------------------------------------------------

describe('ProductionPlanGenerator', () => {
  beforeEach(() => {
    // Provide a fake server-level key so resolveProviderApiKey() succeeds
    // without depending on real credentials or network.
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic-key');
  });

  it('calls the Anthropic provider with a planning-specific system prompt and parses JSON into a plan outcome', async () => {
    const captured: { messages?: ChatMessage[]; config?: ProviderConfig } = {};
    const gen = new ProductionPlanGenerator({
      providerCall: stubPlanProviderCall(validPlanContent(), captured),
    });

    const outcome = await gen.generate(
      {
        runId: 'r-1',
        companyId: 'c-1',
        projectId: 'p-1',
        requestText: 'Analyze the quarterly report',
        resolvedMode: 'deep_work',
        policySnapshotId: null,
      },
      new AbortController().signal,
    );

    expect(outcome.kind).toBe('plan');
    if (outcome.kind !== 'plan') {
      return;
    }
    expect((outcome.content as { objective: string }).objective).toBe(
      'Analyze the quarterly report',
    );
    expect(outcome.generatedBy['source']).toBe('production-plan-generator');
    expect(outcome.generatedBy['provider']).toBe('anthropic');
    expect(outcome.generatedBy['schemaVersion']).toBe(PLAN_CONTENT_SCHEMA_VERSION);

    // A planning-specific system prompt is sent with the PlanContentV1 contract.
    const messages = captured.messages!;
    const system = messages.find((m) => m.role === 'system');
    expect(system).toBeDefined();
    expect(system!.content).toContain('PlanContentV1');
    expect(system!.content).toContain(String(PLAN_CONTENT_SCHEMA_VERSION));

    // The user turn carries the request text and resolved mode.
    const user = messages.find((m) => m.role === 'user');
    expect(user).toBeDefined();
    expect(user!.content).toContain('deep_work');
    expect(user!.content).toContain('Analyze the quarterly report');

    expect(captured.config?.apiKey).toBe('test-anthropic-key');
    expect(captured.config?.model).toBe('claude-sonnet-4-6');
  });

  it('parses a fenced ```json response into a plan outcome', async () => {
    const fenced = '```json\n' + JSON.stringify(validPlanContent()) + '\n```';
    const gen = new ProductionPlanGenerator({
      providerCall: async () => ({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        content: fenced,
        inputTokens: 10,
        outputTokens: 20,
        costCents: 1,
        finishReason: 'end_turn',
        latencyMs: 5,
      }),
    });

    const outcome = await gen.generate(
      {
        runId: 'r-2',
        companyId: 'c-1',
        projectId: 'p-1',
        requestText: 'req',
        resolvedMode: 'deep_work',
        policySnapshotId: null,
      },
      new AbortController().signal,
    );

    expect(outcome.kind).toBe('plan');
  });

  it('returns a malformed outcome when the response is not parseable JSON', async () => {
    const gen = new ProductionPlanGenerator({
      providerCall: async () => ({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        content: 'Sorry, I cannot produce a plan here.',
        inputTokens: 10,
        outputTokens: 20,
        costCents: 1,
        finishReason: 'end_turn',
        latencyMs: 5,
      }),
    });

    const outcome = await gen.generate(
      {
        runId: 'r-3',
        companyId: 'c-1',
        projectId: 'p-1',
        requestText: 'req',
        resolvedMode: 'deep_work',
        policySnapshotId: null,
      },
      new AbortController().signal,
    );

    expect(outcome.kind).toBe('malformed');
    if (outcome.kind !== 'malformed') {
      return;
    }
    expect(outcome.code).toBe('PLANNER_MALFORMED');
  });

  it('returns a malformed outcome for empty output', async () => {
    const gen = new ProductionPlanGenerator({
      providerCall: async () => ({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        content: '   ',
        inputTokens: 1,
        outputTokens: 0,
        costCents: 0,
        finishReason: 'end_turn',
        latencyMs: 1,
      }),
    });

    const outcome = await gen.generate(
      {
        runId: 'r-4',
        companyId: 'c-1',
        projectId: 'p-1',
        requestText: 'req',
        resolvedMode: 'deep_work',
        policySnapshotId: null,
      },
      new AbortController().signal,
    );

    expect(outcome.kind).toBe('malformed');
  });

  it('classifies an authentication failure as permanent', async () => {
    const gen = new ProductionPlanGenerator({
      providerCall: async () => {
        throw new Error('Anthropic authentication failed: invalid API key');
      },
    });

    const outcome = await gen.generate(
      {
        runId: 'r-5',
        companyId: 'c-1',
        projectId: 'p-1',
        requestText: 'req',
        resolvedMode: 'deep_work',
        policySnapshotId: null,
      },
      new AbortController().signal,
    );

    expect(outcome.kind).toBe('failure');
    if (outcome.kind !== 'failure') {
      return;
    }
    expect(outcome.category).toBe('provider_permanent');
    expect(outcome.code).toBe('PLANNER_AUTH_FAILED');
  });

  it('classifies a rate-limit error as transient', async () => {
    const gen = new ProductionPlanGenerator({
      providerCall: async () => {
        throw new Error('Anthropic rate limit exceeded (429)');
      },
    });

    const outcome = await gen.generate(
      {
        runId: 'r-6',
        companyId: 'c-1',
        projectId: 'p-1',
        requestText: 'req',
        resolvedMode: 'deep_work',
        policySnapshotId: null,
      },
      new AbortController().signal,
    );

    expect(outcome.kind).toBe('failure');
    if (outcome.kind !== 'failure') {
      return;
    }
    expect(outcome.category).toBe('provider_transient');
  });

  it('returns a permanent failure when no Anthropic API key is configured', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    let called = false;
    const gen = new ProductionPlanGenerator({
      providerCall: async () => {
        called = true;
        return {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          content: '{}',
          inputTokens: 0,
          outputTokens: 0,
          costCents: 0,
          finishReason: 'stop',
          latencyMs: 0,
        };
      },
    });

    const outcome = await gen.generate(
      {
        runId: 'r-7',
        companyId: 'c-1',
        projectId: 'p-1',
        requestText: 'req',
        resolvedMode: 'deep_work',
        policySnapshotId: null,
      },
      new AbortController().signal,
    );

    expect(called).toBe(false);
    expect(outcome.kind).toBe('failure');
    if (outcome.kind !== 'failure') {
      return;
    }
    expect(outcome.category).toBe('provider_permanent');
    expect(outcome.code).toBe('PLANNER_NO_API_KEY');
  });

  it('returns a timeout failure when the signal is already aborted', async () => {
    const gen = new ProductionPlanGenerator({
      providerCall: async () => ({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        content: '{}',
        inputTokens: 0,
        outputTokens: 0,
        costCents: 0,
        finishReason: 'stop',
        latencyMs: 0,
      }),
    });
    const ac = new AbortController();
    ac.abort();

    const outcome = await gen.generate(
      {
        runId: 'r-8',
        companyId: 'c-1',
        projectId: 'p-1',
        requestText: 'req',
        resolvedMode: 'deep_work',
        policySnapshotId: null,
      },
      ac.signal,
    );

    expect(outcome.kind).toBe('failure');
    if (outcome.kind !== 'failure') {
      return;
    }
    expect(outcome.category).toBe('timeout');
    expect(outcome.code).toBe('PLANNER_ABORTED');
  });
});

// ---------------------------------------------------------------------------
// Production worker path: RunProcessor delegates planning runs to the planner
// and produces plan.proposed events (VAL-PLAN-007/008/009)
// ---------------------------------------------------------------------------

describe('Production worker path invokes the planner (VAL-PLAN-007)', () => {
  beforeEach(() => {
    enableMissionFlag();
    // Harness gate must stay CLOSED — production wiring uses
    // ProductionPlanGenerator, never PlannerTestHarness.
    vi.stubEnv(HARNESS_ENV_FLAG, '0');
    // Fake server-level Anthropic key so ProductionPlanGenerator's key
    // resolution succeeds; the provider call itself is stubbed (no network).
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic-key');
  });

  it('a planning run advanced through RunProcessor({ planner }) produces plan.proposed and awaiting_approval', async () => {
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ prod-planner-wire');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;

    // The run should be in `planning` status (deep_work planningPolicy always).
    let row = await getRunRow(db, runId);
    expect(row!.status).toBe('planning');

    // Construct the production wiring exactly as worker.ts does, but stub the
    // provider call so no real Anthropic API request is made.
    let providerCalled = false;
    const generator = new ProductionPlanGenerator({
      providerCall: async () => {
        providerCalled = true;
        return {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          content: JSON.stringify(validPlanContent()),
          inputTokens: 100,
          outputTokens: 400,
          costCents: 2,
          finishReason: 'end_turn',
          latencyMs: 30,
        };
      },
    });
    const planner = new PlannerService(db, { generator });
    const processor = new RunProcessor(db, { planner });

    const coordinator = new RunCoordinator(db);
    const claim = await coordinator.claimNext('prod-worker-test');
    expect(claim).not.toBeNull();
    expect(claim!.runId).toBe(runId);

    await processor.advance(claim!, new AbortController().signal);

    // The production plan generator was actually invoked.
    expect(providerCalled).toBe(true);

    // The run transitioned to awaiting_approval with a proposed revision.
    row = await getRunRow(db, runId);
    expect(row!.status).toBe('awaiting_approval');
    expect(row!.currentPlanRevisionId).not.toBeNull();
    expect(row!.approvedPlanRevisionId).toBeNull();
    expect(row!.terminalAt).toBeNull();

    // A plan.proposed event was committed.
    const events = await getEvents(db, runId);
    const proposed = events.find((e) => e.type === 'plan.proposed');
    expect(proposed).toBeDefined();
    expect(proposed!.sequence).toBeGreaterThan(0);

    // No execution-start event precedes approval.
    const executionStart = events.find(
      (e) => e.type === 'run.status_changed' && (e.payload as { to?: string }).to === 'running',
    );
    expect(executionStart).toBeUndefined();

    // One proposed plan revision exists.
    const revisions = await getPlanRevisions(db, runId);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].status).toBe('proposed');

    await coordinator.release(claim!);
    await closeTestDb();
  });

  it('without deps.planner a planning run does NOT invoke a generator (guards the wiring)', async () => {
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ prod-no-planner');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;

    // No planner injected — mirrors the pre-fix worker.ts construction.
    let generatorCalled = false;
    const generator = new ProductionPlanGenerator({
      providerCall: async () => {
        generatorCalled = true;
        return {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          content: JSON.stringify(validPlanContent()),
          inputTokens: 1,
          outputTokens: 1,
          costCents: 0,
          finishReason: 'end_turn',
          latencyMs: 1,
        };
      },
    });
    // The generator exists but is NOT injected into RunProcessor.
    void generator;
    const processor = new RunProcessor(db);

    const coordinator = new RunCoordinator(db);
    const claim = await coordinator.claimNext('prod-worker-noplanner');
    expect(claim).not.toBeNull();
    expect(claim!.runId).toBe(runId);

    await processor.advance(claim!, new AbortController().signal);

    // Without deps.planner, the planning dispatch guard never fires and no
    // generator is invoked. The run stays in planning (no completion).
    expect(generatorCalled).toBe(false);
    const row = await getRunRow(db, runId);
    expect(row!.status).toBe('planning');
    const events = await getEvents(db, runId);
    expect(events.find((e) => e.type === 'plan.proposed')).toBeUndefined();

    await coordinator.release(claim!);
    await closeTestDb();
  });
});
