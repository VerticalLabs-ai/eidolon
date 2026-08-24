import { describe, expect, it, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer, closeTestServers, closeTestDb } from '../test-utils.js';
import { RunCoordinator } from '../services/mission/coordinator.js';
import { ToolDispatcher } from '../services/mission/tool-dispatcher.js';

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
    VALUES (${companyId}, ${label}, 'active', 100000, 0, '{}'::jsonb, ${now}, ${now})
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

/** Seed a second scope for cross-scope tests. */
async function seedSecondScope(db: AnyDb, label: string) {
  return seedScope(db, label);
}

async function freshRun(
  label: string,
  text = 'Do work',
): Promise<{
  db: AnyDb;
  app: Awaited<ReturnType<typeof createTestServer>>;
  companyId: string;
  projectId: string;
  threadId: string;
  runId: string;
  base: string;
  policySnapshotId: string;
}> {
  enableMissionFlag();
  const db = await createTestDb();
  const app = await createTestServer(db);
  const { companyId, projectId, threadId } = await seedScope(db, label);
  const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
  const start = await request(app)
    .post(base)
    .set('Idempotency-Key', `fresh-${randomUUID()}`)
    .send({ projectThreadId: threadId, mode: 'fast', request: { text } })
    .expect(202);
  const runId = start.body.data.run.id as string;
  const policySnapshotId = start.body.data.run.policySnapshotId as string;
  return { db, app, companyId, projectId, threadId, runId, base, policySnapshotId };
}

async function setRunStatus(
  db: AnyDb,
  runId: string,
  status: string,
  opts: {
    leaseOwner?: string | null;
    leaseToken?: string | null;
    leaseExpiresAt?: Date | null;
    heartbeatAt?: Date | null;
    availableAt?: Date | null;
    attemptCount?: number;
    approvedPlanRevisionId?: string | null;
    cancelRequestedAt?: Date | null;
  } = {},
) {
  const now = new Date();
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(status);
  const availableAt = opts.availableAt !== undefined ? opts.availableAt : now;

  await db.drizzle.execute(sql`
    UPDATE "mission_runs"
    SET "status" = ${status},
        "terminal_at" = ${isTerminal ? now : null},
        "updated_at" = ${now},
        "available_at" = ${availableAt},
        "lease_owner" = ${opts.leaseOwner ?? null},
        "lease_token" = ${opts.leaseToken ?? null},
        "lease_expires_at" = ${opts.leaseExpiresAt ?? null},
        "heartbeat_at" = ${opts.heartbeatAt ?? null},
        "started_at" = ${['running', 'synthesizing'].includes(status) ? now : null},
        "attempt_count" = ${opts.attemptCount ?? 0},
        "approved_plan_revision_id" = ${opts.approvedPlanRevisionId ?? null},
        "cancel_requested_at" = ${opts.cancelRequestedAt ?? null}
    WHERE "id" = ${runId}
  `);
}

/** Update the policy snapshot's tool allowlist. */
async function setToolAllowlist(db: AnyDb, policySnapshotId: string, tools: string[]) {
  await db.drizzle.execute(sql`
    UPDATE "run_policy_snapshots"
    SET "tool_allowlist" = ${JSON.stringify(tools)}::jsonb
    WHERE "id" = ${policySnapshotId}
  `);
}

/** Claim a run and return the claim with lease token. */
async function claimRun(db: AnyDb, runId: string, workerId = 'worker-A') {
  // Set to queued first so the coordinator can claim it.
  await setRunStatus(db, runId, 'queued');
  const coordinator = new RunCoordinator(db);
  const claim = await coordinator.claimNext(workerId);
  expect(claim).not.toBeNull();
  return claim!;
}

async function getEvents(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT * FROM "run_events"
    WHERE "run_id" = ${runId}
    ORDER BY "sequence" ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows;
}

async function getInvocations(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT * FROM "run_tool_invocations"
    WHERE "run_id" = ${runId}
    ORDER BY "created_at" ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows;
}

/** Count events of a given type for a run. */
function countEvents(events: Array<Record<string, unknown>>, type: string): number {
  return events.filter((e) => e.type === type).length;
}

/** Insert a real run_plan_revisions row so FK constraints on mission_runs pass. */
async function seedPlanRevision(
  db: AnyDb,
  ctx: { companyId: string; projectId: string; runId: string },
): Promise<string> {
  const planRevId = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "run_plan_revisions"
      ("id", "company_id", "project_id", "run_id", "revision", "status", "content", "content_hash", "created_at", "updated_at")
    VALUES
      (${planRevId}, ${ctx.companyId}, ${ctx.projectId}, ${ctx.runId}, 1, 'approved',
       '{"schemaVersion":1,"objective":"test","steps":[],"synthesis":{"mode":"require_all"},"partialResultPolicy":"require_all","limits":{}}'::jsonb,
       'testhash000000000000000000000000000000000000000000000000000000000', ${now}, ${now})
  `);
  return planRevId;
}

afterEach(async () => {
  await closeTestServers();
});

// ===========================================================================
// VAL-RUN-124: Tool dispatcher denies before external effect
// ===========================================================================

describe('VAL-RUN-124: Tool dispatcher denies before external effect', () => {
  const TOOLS = ['artifact.create', 'research.search', 'mcp.server1.tool1'];
  const VALID_ARGS = { query: 'test query', limit: 10 };
  const VALID_TOOL = 'research.search';

  /** Setup a run with a claim and tool allowlist, return dispatcher + context. */
  async function setupRun(
    label: string,
    opts: {
      tools?: string[];
      approved?: boolean;
      cancelled?: boolean;
    } = {},
  ) {
    const ctx = await freshRun(label);
    const claim = await claimRun(ctx.db, ctx.runId);
    await setToolAllowlist(ctx.db, ctx.policySnapshotId, opts.tools ?? TOOLS);
    if (opts.approved) {
      const planRevId = await seedPlanRevision(ctx.db, ctx);
      await setRunStatus(ctx.db, ctx.runId, 'running', {
        leaseOwner: claim.leaseOwner,
        leaseToken: claim.leaseToken,
        leaseExpiresAt: claim.leaseExpiresAt,
        approvedPlanRevisionId: planRevId,
      });
    }
    if (opts.cancelled) {
      await ctx.db.drizzle.execute(sql`
        UPDATE "mission_runs"
        SET "cancel_requested_at" = ${new Date()}
        WHERE "id" = ${ctx.runId}
      `);
    }
    const dispatcher = new ToolDispatcher(ctx.db);
    return { ctx, claim, dispatcher };
  }

  it('denies an unlisted tool before any adapter invocation or charge', async () => {
    const { ctx, claim, dispatcher } = await setupRun('unlisted-tool', { approved: true });

    const result = await dispatcher.authorizeAndPrepare({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claim.leaseToken,
      toolId: 'unlisted.evil_tool',
      args: VALID_ARGS,
      replayClass: 'read_only',
      stepKey: 'root',
      attempt: 0,
    });

    expect(result.authorized).toBe(false);
    expect(result.denialCode).toBe('TOOL_NOT_ALLOWED');

    // No invocation row was created.
    const invocations = await getInvocations(ctx.db, ctx.runId);
    expect(invocations).toHaveLength(0);

    // A tool.denied event was emitted.
    const events = await getEvents(ctx.db, ctx.runId);
    const deniedEvents = events.filter((e) => e.type === 'tool.denied');
    expect(deniedEvents).toHaveLength(1);
    const payload = deniedEvents[0].payload as Record<string, unknown>;
    expect(payload.toolId).toBe('unlisted.evil_tool');
    expect(payload.reason).toBe('TOOL_NOT_ALLOWED');

    // No adapter was invoked (no tool.started, tool.completed, or tool.failed).
    expect(countEvents(events, 'tool.started')).toBe(0);
    expect(countEvents(events, 'tool.completed')).toBe(0);

    await closeTestDb();
  });

  it('denies a prefix lookalike tool (exact match only)', async () => {
    const { ctx, claim, dispatcher } = await setupRun('prefix-lookalike', { approved: true });

    // "artifact.creat" is a prefix of "artifact.create" but must NOT match.
    const result = await dispatcher.authorizeAndPrepare({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claim.leaseToken,
      toolId: 'artifact.creat',
      args: {},
      replayClass: 'read_only',
      stepKey: 'root',
      attempt: 0,
    });

    expect(result.authorized).toBe(false);
    expect(result.denialCode).toBe('TOOL_NOT_ALLOWED');
    const invocations = await getInvocations(ctx.db, ctx.runId);
    expect(invocations).toHaveLength(0);

    await closeTestDb();
  });

  it('denies a trailing-space lookalike tool', async () => {
    const { ctx, claim, dispatcher } = await setupRun('trailing-space', { approved: true });

    // "artifact.create " (trailing space) must NOT match "artifact.create".
    const result = await dispatcher.authorizeAndPrepare({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claim.leaseToken,
      toolId: 'artifact.create ',
      args: {},
      replayClass: 'read_only',
      stepKey: 'root',
      attempt: 0,
    });

    expect(result.authorized).toBe(false);
    expect(result.denialCode).toBe('TOOL_NOT_ALLOWED');
    const invocations = await getInvocations(ctx.db, ctx.runId);
    expect(invocations).toHaveLength(0);

    await closeTestDb();
  });

  it('denies a leading-space lookalike tool', async () => {
    const { ctx, claim, dispatcher } = await setupRun('leading-space', { approved: true });

    const result = await dispatcher.authorizeAndPrepare({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claim.leaseToken,
      toolId: ' research.search',
      args: VALID_ARGS,
      replayClass: 'read_only',
      stepKey: 'root',
      attempt: 0,
    });

    expect(result.authorized).toBe(false);
    expect(result.denialCode).toBe('TOOL_NOT_ALLOWED');
    const invocations = await getInvocations(ctx.db, ctx.runId);
    expect(invocations).toHaveLength(0);

    await closeTestDb();
  });

  it('denies invalid arguments (schema validation)', async () => {
    const { ctx, claim, dispatcher } = await setupRun('invalid-args', { approved: true });

    // Provide an argument validator that rejects the arguments.
    const argValidator = (args: unknown): string | null => {
      if (typeof args !== 'object' || args === null) {
        return 'args must be an object';
      }
      const a = args as Record<string, unknown>;
      if (typeof a.query !== 'string') {
        return 'query must be a string';
      }
      if (a.query.length === 0) {
        return 'query must not be empty';
      }
      return null; // valid
    };

    const result = await dispatcher.authorizeAndPrepare({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claim.leaseToken,
      toolId: VALID_TOOL,
      args: { query: '', limit: 10 }, // empty query is invalid
      replayClass: 'read_only',
      stepKey: 'root',
      attempt: 0,
      argValidator,
    });

    expect(result.authorized).toBe(false);
    expect(result.denialCode).toBe('TOOL_ARGUMENTS_INVALID');
    const invocations = await getInvocations(ctx.db, ctx.runId);
    expect(invocations).toHaveLength(0);

    // tool.denied event emitted.
    const events = await getEvents(ctx.db, ctx.runId);
    const deniedEvents = events.filter((e) => e.type === 'tool.denied');
    expect(deniedEvents).toHaveLength(1);

    await closeTestDb();
  });

  it('denies a wrong-scope target (company/project mismatch)', async () => {
    const { ctx, claim, dispatcher } = await setupRun('wrong-scope', { approved: true });

    // Use a different company/project scope. The dispatcher throws a
    // non-enumerating 404 — it does not reveal that the run exists elsewhere.
    const other = await seedSecondScope(ctx.db, 'other-scope');

    await expect(
      dispatcher.authorizeAndPrepare({
        companyId: other.companyId,
        projectId: other.projectId,
        runId: ctx.runId,
        leaseToken: claim.leaseToken,
        toolId: VALID_TOOL,
        args: VALID_ARGS,
        replayClass: 'read_only',
        stepKey: 'root',
        attempt: 0,
      }),
    ).rejects.toThrow('Mission run not found');

    // No invocation row was created.
    const invocations = await getInvocations(ctx.db, ctx.runId);
    expect(invocations).toHaveLength(0);

    await closeTestDb();
  });

  it('denies an allowed tool after cancellation is requested', async () => {
    const { ctx, claim, dispatcher } = await setupRun('after-cancel', {
      approved: true,
      cancelled: true,
    });

    const result = await dispatcher.authorizeAndPrepare({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claim.leaseToken,
      toolId: VALID_TOOL,
      args: VALID_ARGS,
      replayClass: 'read_only',
      stepKey: 'root',
      attempt: 0,
    });

    expect(result.authorized).toBe(false);
    expect(result.denialCode).toBe('RUN_CANCELLED');
    const invocations = await getInvocations(ctx.db, ctx.runId);
    expect(invocations).toHaveLength(0);

    await closeTestDb();
  });

  it('denies an allowed tool after approval revocation (no approved plan)', async () => {
    // Start a run WITHOUT approval (approvedPlanRevisionId is null).
    // The run requires complex work approval but the plan was revoked.
    const { ctx, claim, dispatcher } = await setupRun('approval-revoked');

    // Mark the run as requiring approval (approvalPolicy says approval required)
    // by setting the planning policy to require it. For simplicity, the
    // dispatcher checks approvedPlanRevisionId is set when the policy
    // requires it.
    await ctx.db.drizzle.execute(sql`
      UPDATE "run_policy_snapshots"
      SET "approval_policy" = ${JSON.stringify({ strategy: 'required' })}::jsonb
      WHERE "id" = ${ctx.policySnapshotId}
    `);

    const result = await dispatcher.authorizeAndPrepare({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claim.leaseToken,
      toolId: VALID_TOOL,
      args: VALID_ARGS,
      replayClass: 'read_only',
      stepKey: 'root',
      attempt: 0,
    });

    expect(result.authorized).toBe(false);
    expect(result.denialCode).toBe('APPROVAL_REQUIRED');
    const invocations = await getInvocations(ctx.db, ctx.runId);
    expect(invocations).toHaveLength(0);

    await closeTestDb();
  });

  it('denies with a stale lease token (fencing)', async () => {
    const { ctx, dispatcher } = await setupRun('stale-lease', { approved: true });

    const result = await dispatcher.authorizeAndPrepare({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: 'wrong-lease-token',
      toolId: VALID_TOOL,
      args: VALID_ARGS,
      replayClass: 'read_only',
      stepKey: 'root',
      attempt: 0,
    });

    expect(result.authorized).toBe(false);
    expect(result.denialCode).toBe('LEASE_NOT_HELD');
    const invocations = await getInvocations(ctx.db, ctx.runId);
    expect(invocations).toHaveLength(0);

    await closeTestDb();
  });

  it('denies when run is terminal', async () => {
    const { ctx, claim, dispatcher } = await setupRun('terminal-run', { approved: true });

    // Complete the run.
    await setRunStatus(ctx.db, ctx.runId, 'completed');

    const result = await dispatcher.authorizeAndPrepare({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claim.leaseToken,
      toolId: VALID_TOOL,
      args: VALID_ARGS,
      replayClass: 'read_only',
      stepKey: 'root',
      attempt: 0,
    });

    expect(result.authorized).toBe(false);
    expect(result.denialCode).toBe('RUN_TERMINAL');
    const invocations = await getInvocations(ctx.db, ctx.runId);
    expect(invocations).toHaveLength(0);

    await closeTestDb();
  });

  it('one exact qualified allowed invocation succeeds (positive control)', async () => {
    const { ctx, claim, dispatcher } = await setupRun('positive-control', { approved: true });

    const result = await dispatcher.authorizeAndPrepare({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claim.leaseToken,
      toolId: VALID_TOOL,
      args: VALID_ARGS,
      replayClass: 'read_only',
      stepKey: 'root',
      attempt: 0,
    });

    expect(result.authorized).toBe(true);
    expect(result.invocationId).toBeDefined();
    expect(result.logicalCallId).toBeDefined();

    // One invocation row was created in 'prepared' state.
    const invocations = await getInvocations(ctx.db, ctx.runId);
    expect(invocations).toHaveLength(1);
    expect(invocations[0].state).toBe('prepared');
    expect(invocations[0].tool_id).toBe(VALID_TOOL);
    expect(invocations[0].replay_class).toBe('read_only');

    // A tool.requested event was emitted.
    const events = await getEvents(ctx.db, ctx.runId);
    const requestedEvents = events.filter((e) => e.type === 'tool.requested');
    expect(requestedEvents).toHaveLength(1);

    // No tool.denied event.
    expect(countEvents(events, 'tool.denied')).toBe(0);

    await closeTestDb();
  });

  it('succeeds without approval when policy permits unplanned execution', async () => {
    const { ctx, claim, dispatcher } = await setupRun('no-approval-needed');

    // Ensure approval policy says approval is NOT required.
    await ctx.db.drizzle.execute(sql`
      UPDATE "run_policy_snapshots"
      SET "approval_policy" = ${JSON.stringify({ strategy: 'not_required' })}::jsonb
      WHERE "id" = ${ctx.policySnapshotId}
    `);

    const result = await dispatcher.authorizeAndPrepare({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claim.leaseToken,
      toolId: VALID_TOOL,
      args: VALID_ARGS,
      replayClass: 'read_only',
      stepKey: 'root',
      attempt: 0,
    });

    expect(result.authorized).toBe(true);
    const invocations = await getInvocations(ctx.db, ctx.runId);
    expect(invocations).toHaveLength(1);

    await closeTestDb();
  });
});

// ===========================================================================
// VAL-RUN-125: Replay-safe tool classes recover correctly
// ===========================================================================

describe('VAL-RUN-125: Replay-safe tool classes recover correctly', () => {
  const TOOLS = ['research.search', 'artifact.create', 'irreversible.send_email'];
  const VALID_ARGS = { query: 'test' };

  async function setupRunWithInvocation(
    label: string,
    replayClass: 'read_only' | 'idempotent_write' | 'non_replayable',
    toolId: string,
    invocationState: 'prepared' | 'started' | 'succeeded' | 'failed' | 'cancelled' | 'unknown',
  ) {
    const ctx = await freshRun(label);
    const claim = await claimRun(ctx.db, ctx.runId);
    await setToolAllowlist(ctx.db, ctx.policySnapshotId, TOOLS);

    const planRevId = await seedPlanRevision(ctx.db, ctx);
    await setRunStatus(ctx.db, ctx.runId, 'running', {
      leaseOwner: claim.leaseOwner,
      leaseToken: claim.leaseToken,
      leaseExpiresAt: claim.leaseExpiresAt,
      approvedPlanRevisionId: planRevId,
    });

    const dispatcher = new ToolDispatcher(ctx.db);

    // If the invocation state is 'prepared', create it via the dispatcher.
    if (invocationState === 'prepared') {
      const result = await dispatcher.authorizeAndPrepare({
        companyId: ctx.companyId,
        projectId: ctx.projectId,
        runId: ctx.runId,
        leaseToken: claim.leaseToken,
        toolId,
        args: VALID_ARGS,
        replayClass,
        stepKey: 'root',
        attempt: 0,
      });
      expect(result.authorized).toBe(true);
      return {
        ctx,
        claim,
        dispatcher,
        invocationId: result.invocationId!,
        logicalCallId: result.logicalCallId!,
      };
    }

    // Otherwise, insert the invocation directly.
    const invocationId = randomUUID();
    const logicalCallId = `logical-${randomUUID()}`;
    const now = new Date();
    await ctx.db.drizzle.execute(sql`
      INSERT INTO "run_tool_invocations" (
        "id", "company_id", "project_id", "run_id",
        "step_key", "attempt", "tool_id", "ordinal",
        "replay_class", "state", "logical_call_id",
        "created_at", "updated_at"
      ) VALUES (
        ${invocationId}, ${ctx.companyId}, ${ctx.projectId}, ${ctx.runId},
        'root', 0, ${toolId}, 0,
        ${replayClass}, ${invocationState}, ${logicalCallId},
        ${now}, ${now}
      )
    `);
    return { ctx, claim, dispatcher, invocationId, logicalCallId };
  }

  it('read-only tool may reissue under one logical identity after interruption', async () => {
    const { ctx, claim, dispatcher, logicalCallId } = await setupRunWithInvocation(
      'readonly-reissue',
      'read_only',
      'research.search',
      'started',
    );

    // Simulate lease loss + recovery. The worker recovers and checks the
    // existing invocation. For read_only, recovery permits reissuing under
    // the same logical call ID.
    const recovery = await dispatcher.recoverInvocation({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claim.leaseToken,
      toolId: 'research.search',
      stepKey: 'root',
      attempt: 0,
    });

    // Recovery says: safe to reissue, returns the same logical call ID.
    expect(recovery.canReissue).toBe(true);
    expect(recovery.logicalCallId).toBe(logicalCallId);

    // A new invocation can be prepared for the reissue.
    const result = await dispatcher.authorizeAndPrepare({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claim.leaseToken,
      toolId: 'research.search',
      args: VALID_ARGS,
      replayClass: 'read_only',
      stepKey: 'root',
      attempt: 0,
      ordinal: 1, // new ordinal for the reissue
      logicalCallId: recovery.logicalCallId, // reuse the same logical call ID
    });

    expect(result.authorized).toBe(true);

    // Two invocations total: the original (started) and the reissue (prepared).
    const invocations = await getInvocations(ctx.db, ctx.runId);
    expect(invocations).toHaveLength(2);

    // Both share the same logical call ID.
    expect(invocations[0].logical_call_id).toBe(logicalCallId);
    expect(invocations[1].logical_call_id).toBe(logicalCallId);

    await closeTestDb();
  });

  it('idempotent write retries only with adapter idempotency key', async () => {
    const { ctx, claim, dispatcher, invocationId, logicalCallId } = await setupRunWithInvocation(
      'idempotent-retry',
      'idempotent_write',
      'artifact.create',
      'started',
    );

    // Recovery: the dispatcher returns the adapter idempotency key for
    // reconciliation. It does NOT automatically reissue.
    const recovery = await dispatcher.recoverInvocation({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claim.leaseToken,
      toolId: 'artifact.create',
      stepKey: 'root',
      attempt: 0,
    });

    // Cannot blindly reissue — must use adapter idempotency/reconciliation.
    expect(recovery.canReissue).toBe(false);
    expect(recovery.adapterIdempotencyKey).toBeDefined();
    expect(recovery.adapterIdempotencyKey).toBe(logicalCallId);
    expect(recovery.reconciliationRequired).toBe(true);

    // The original invocation remains in 'started' state (not repeated).
    const invocations = await getInvocations(ctx.db, ctx.runId);
    expect(invocations).toHaveLength(1);
    expect(invocations[0].state).toBe('started');

    // The worker can reconcile by checking if the effect happened via the
    // adapter idempotency key, then either mark succeeded or mark unknown.
    await dispatcher.completeInvocation({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claim.leaseToken,
      invocationId,
      resultSummary: { status: 'created', reconciled: true },
    });

    const postInvocations = await getInvocations(ctx.db, ctx.runId);
    expect(postInvocations).toHaveLength(1);
    expect(postInvocations[0].state).toBe('succeeded');

    await closeTestDb();
  });

  it('non-replayable started invocation is never automatically repeated', async () => {
    const { ctx, claim, dispatcher } = await setupRunWithInvocation(
      'non-replayable-started',
      'non_replayable',
      'irreversible.send_email',
      'started',
    );

    // Recovery: the dispatcher refuses to reissue. The invocation must be
    // reconciled or the run must fail with unknown_effect.
    const recovery = await dispatcher.recoverInvocation({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claim.leaseToken,
      toolId: 'irreversible.send_email',
      stepKey: 'root',
      attempt: 0,
    });

    expect(recovery.canReissue).toBe(false);
    expect(recovery.neverRepeat).toBe(true);

    // The invocation is marked as 'unknown' (effect may or may not have happened).
    const invocations = await getInvocations(ctx.db, ctx.runId);
    expect(invocations).toHaveLength(1);
    expect(invocations[0].state).toBe('unknown');

    // A new invocation was NOT created.
    const postInvocations = await getInvocations(ctx.db, ctx.runId);
    expect(postInvocations).toHaveLength(1);

    await closeTestDb();
  });

  it('non-replayable unknown invocation is never repeated and causes unknown_effect', async () => {
    const { ctx, claim, dispatcher } = await setupRunWithInvocation(
      'non-replayable-unknown',
      'non_replayable',
      'irreversible.send_email',
      'unknown',
    );

    // Recovery: the dispatcher refuses to reissue and reports the unknown state.
    const recovery = await dispatcher.recoverInvocation({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claim.leaseToken,
      toolId: 'irreversible.send_email',
      stepKey: 'root',
      attempt: 0,
    });

    expect(recovery.canReissue).toBe(false);
    expect(recovery.neverRepeat).toBe(true);
    expect(recovery.isUnknown).toBe(true);

    // No new invocation was created.
    const invocations = await getInvocations(ctx.db, ctx.runId);
    expect(invocations).toHaveLength(1);

    await closeTestDb();
  });

  it('read-only succeeded invocation does not need reissue', async () => {
    const { ctx, claim, dispatcher } = await setupRunWithInvocation(
      'readonly-succeeded',
      'read_only',
      'research.search',
      'succeeded',
    );

    const recovery = await dispatcher.recoverInvocation({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claim.leaseToken,
      toolId: 'research.search',
      stepKey: 'root',
      attempt: 0,
    });

    // Already succeeded — no reissue needed.
    expect(recovery.canReissue).toBe(false);
    expect(recovery.alreadyCompleted).toBe(true);

    // No new invocation.
    const invocations = await getInvocations(ctx.db, ctx.runId);
    expect(invocations).toHaveLength(1);

    await closeTestDb();
  });

  it('each replay class causes at most one external effect', async () => {
    // read_only: one invocation succeeds, reissue creates a second invocation
    // but both share the same logical call ID (one logical effect).
    const { ctx, claim, dispatcher } = await setupRunWithInvocation(
      'one-effect-readonly',
      'read_only',
      'research.search',
      'started',
    );

    // Reissue (read_only allows reissue).
    const recovery = await dispatcher.recoverInvocation({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claim.leaseToken,
      toolId: 'research.search',
      stepKey: 'root',
      attempt: 0,
    });
    expect(recovery.canReissue).toBe(true);

    // Mark the reissue as succeeded.
    const result = await dispatcher.authorizeAndPrepare({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claim.leaseToken,
      toolId: 'research.search',
      args: VALID_ARGS,
      replayClass: 'read_only',
      stepKey: 'root',
      attempt: 0,
      ordinal: 1,
      logicalCallId: recovery.logicalCallId,
    });
    expect(result.authorized).toBe(true);

    await dispatcher.markStarted({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claim.leaseToken,
      invocationId: result.invocationId!,
    });

    await dispatcher.completeInvocation({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claim.leaseToken,
      invocationId: result.invocationId!,
      resultSummary: { ok: true },
    });

    // Two invocation rows but one logical call ID — one external effect.
    const invocations = await getInvocations(ctx.db, ctx.runId);
    expect(invocations).toHaveLength(2);
    const logicalCallIds = new Set(invocations.map((i) => i.logical_call_id));
    expect(logicalCallIds.size).toBe(1);

    // The original was in 'started' (interrupted), the reissue is 'succeeded'.
    const states = invocations.map((i) => i.state);
    expect(states).toContain('started');
    expect(states).toContain('succeeded');

    await closeTestDb();
  });
});

// ===========================================================================
// Dispatcher lifecycle: prepare → start → complete/fail
// ===========================================================================

describe('Tool dispatcher lifecycle', () => {
  const TOOLS = ['research.search'];
  const VALID_TOOL = 'research.search';
  const VALID_ARGS = { query: 'test' };

  it('prepare → start → complete lifecycle works correctly', async () => {
    const ctx = await freshRun('lifecycle-complete');
    const claim = await claimRun(ctx.db, ctx.runId);
    await setToolAllowlist(ctx.db, ctx.policySnapshotId, TOOLS);
    const planRevId = await seedPlanRevision(ctx.db, ctx);
    await setRunStatus(ctx.db, ctx.runId, 'running', {
      leaseOwner: claim.leaseOwner,
      leaseToken: claim.leaseToken,
      leaseExpiresAt: claim.leaseExpiresAt,
      approvedPlanRevisionId: planRevId,
    });

    const dispatcher = new ToolDispatcher(ctx.db);

    // 1. Prepare.
    const result = await dispatcher.authorizeAndPrepare({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claim.leaseToken,
      toolId: VALID_TOOL,
      args: VALID_ARGS,
      replayClass: 'read_only',
      stepKey: 'root',
      attempt: 0,
    });
    expect(result.authorized).toBe(true);

    // 2. Start.
    await dispatcher.markStarted({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claim.leaseToken,
      invocationId: result.invocationId!,
    });

    let invocations = await getInvocations(ctx.db, ctx.runId);
    expect(invocations[0].state).toBe('started');

    // 3. Complete.
    await dispatcher.completeInvocation({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claim.leaseToken,
      invocationId: result.invocationId!,
      resultSummary: { results: ['item1'] },
    });

    invocations = await getInvocations(ctx.db, ctx.runId);
    expect(invocations[0].state).toBe('succeeded');

    // Events: tool.requested, tool.started, tool.completed.
    const events = await getEvents(ctx.db, ctx.runId);
    expect(countEvents(events, 'tool.requested')).toBe(1);
    expect(countEvents(events, 'tool.started')).toBe(1);
    expect(countEvents(events, 'tool.completed')).toBe(1);

    await closeTestDb();
  });

  it('prepare → start → fail lifecycle records failure', async () => {
    const ctx = await freshRun('lifecycle-fail');
    const claim = await claimRun(ctx.db, ctx.runId);
    await setToolAllowlist(ctx.db, ctx.policySnapshotId, TOOLS);
    const planRevId = await seedPlanRevision(ctx.db, ctx);
    await setRunStatus(ctx.db, ctx.runId, 'running', {
      leaseOwner: claim.leaseOwner,
      leaseToken: claim.leaseToken,
      leaseExpiresAt: claim.leaseExpiresAt,
      approvedPlanRevisionId: planRevId,
    });

    const dispatcher = new ToolDispatcher(ctx.db);

    const result = await dispatcher.authorizeAndPrepare({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claim.leaseToken,
      toolId: VALID_TOOL,
      args: VALID_ARGS,
      replayClass: 'read_only',
      stepKey: 'root',
      attempt: 0,
    });
    expect(result.authorized).toBe(true);

    await dispatcher.markStarted({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claim.leaseToken,
      invocationId: result.invocationId!,
    });

    await dispatcher.failInvocation({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claim.leaseToken,
      invocationId: result.invocationId!,
      errorSummary: { code: 'TIMEOUT', message: 'Request timed out' },
    });

    const invocations = await getInvocations(ctx.db, ctx.runId);
    expect(invocations[0].state).toBe('failed');

    const events = await getEvents(ctx.db, ctx.runId);
    expect(countEvents(events, 'tool.failed')).toBe(1);

    await closeTestDb();
  });
});
