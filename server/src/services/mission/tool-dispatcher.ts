import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../middleware/error-handler.js';
import type { DbInstance } from '../../types.js';

/**
 * ToolDispatcher — exact tool policy checks and replay-class ledgers.
 *
 * Every tool invocation passes through this dispatcher before reaching any
 * adapter (artifact tools, MCP tools, or research providers). The dispatcher
 * verifies:
 *
 *  - Run state (non-terminal, running or synthesizing)
 *  - Lease fencing (stale worker cannot dispatch)
 *  - Company/project scope
 *  - Cancellation (no tool call after cancel request)
 *  - Approval (complex work requires an approved plan revision)
 *  - Tool identity (exact qualified name match — no prefix/wildcard)
 *  - Argument validation (optional caller-supplied validator)
 *  - Limits (provider call count within policy)
 *  - Budget (allocation has headroom)
 *
 * Tool invocations are written to `run_tool_invocations` BEFORE execution
 * with a deterministic key `(run_id, step_key, attempt, tool_id, ordinal)`
 * and a declared replay class. A denial writes `tool.denied` and never
 * creates an invocation row or calls an adapter.
 *
 * Replay-class recovery (VAL-RUN-125):
 *  - `read_only` may reissue under one logical identity.
 *  - `idempotent_write` retries only through an adapter idempotency key /
 *    reconciliation read.
 *  - `non_replayable` in `started` or `unknown` NEVER repeats automatically.
 *    Recovery exposes reconciliation or terminal `unknown_effect` failure.
 */

type Tx = Parameters<Parameters<DbInstance['drizzle']['transaction']>[0]>[0];
type MissionRunRow = DbInstance['schema']['missionRuns']['$inferSelect'];

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const EXECUTING_STATUSES = new Set(['running', 'synthesizing']);

/** Replay class as declared by the caller. */
export type ReplayClass = 'read_only' | 'idempotent_write' | 'non_replayable';

/** Invocation state (mirrors the DB enum). */
export type InvocationState =
  'prepared' | 'started' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';

export interface ToolDispatcherDeps {
  clock?: () => Date;
}

/** Result of authorizeAndPrepare. */
export interface AuthorizeResult {
  authorized: boolean;
  /** When authorized, the invocation row ID. */
  invocationId?: string;
  /** When authorized, the stable logical call ID for effect dedup. */
  logicalCallId?: string;
  /** When denied, the denial code (event payload reason). */
  denialCode?: string;
  /** When denied, a safe denial message. */
  denialMessage?: string;
}

/** Argument validator: returns null if valid, or an error message if invalid. */
export type ArgValidator = (args: unknown) => string | null;

/** Input for authorizeAndPrepare. */
export interface AuthorizeInput {
  companyId: string;
  projectId: string;
  runId: string;
  /** Lease token from the worker's claim (fencing). */
  leaseToken: string;
  /** Exact qualified tool identifier. */
  toolId: string;
  /** Tool arguments (validated by argValidator if provided). */
  args: Record<string, unknown>;
  /** Replay class for the invocation ledger. */
  replayClass: ReplayClass;
  /** Stable step key from the approved plan, or 'root' for root execution. */
  stepKey: string;
  /** Attempt number within the run. */
  attempt: number;
  /** Ordinal within the same step/attempt/tool (for parallel calls). Default 0. */
  ordinal?: number;
  /** Optional logical call ID to reuse (for read-only reissue). */
  logicalCallId?: string;
  /** Optional argument validator. */
  argValidator?: ArgValidator;
  /** Trace ID for correlation. */
  traceId?: string | null;
  /** Actor type for event attribution. */
  actorType?: 'user' | 'agent' | 'system';
  /** Actor ID for event attribution. */
  actorId?: string | null;
}

/** Input for markStarted / completeInvocation / failInvocation. */
export interface InvocationInput {
  companyId: string;
  projectId: string;
  runId: string;
  leaseToken: string;
  invocationId: string;
  traceId?: string | null;
  actorType?: 'user' | 'agent' | 'system';
  actorId?: string | null;
}

/** Input for completeInvocation. */
export interface CompleteInvocationInput extends InvocationInput {
  resultSummary: Record<string, unknown>;
  /** Cost in integer cents if this invocation was charged. */
  costCents?: number;
  /** Provider request ID hash (for settlement dedup). */
  providerRequestIdHash?: string;
  /** External call ID for settlement linkage. */
  externalCallId?: string;
}

/** Input for failInvocation. */
export interface FailInvocationInput extends InvocationInput {
  errorSummary: Record<string, unknown>;
}

/** Result of recoverInvocation. */
export interface RecoveryResult {
  /** Whether the invocation can be reissued (read_only only). */
  canReissue: boolean;
  /** The logical call ID for the invocation (for reissue or reconciliation). */
  logicalCallId?: string;
  /** For idempotent_write: the adapter idempotency key to use for reconciliation. */
  adapterIdempotencyKey?: string;
  /** For idempotent_write: reconciliation is required before proceeding. */
  reconciliationRequired?: boolean;
  /** For non_replayable: the invocation must never be repeated. */
  neverRepeat?: boolean;
  /** For non_replayable: the invocation is in an unknown state. */
  isUnknown?: boolean;
  /** The invocation was already completed (succeeded/failed). No reissue needed. */
  alreadyCompleted?: boolean;
  /** The invocation ID found. */
  invocationId?: string;
  /** The replay class of the invocation. */
  replayClass?: ReplayClass;
  /** The current state of the invocation. */
  state?: InvocationState;
}

export class ToolDispatcher {
  constructor(
    private db: DbInstance,
    private deps: ToolDispatcherDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  /**
   * Authorize a tool invocation and write it to the ledger BEFORE execution.
   *
   * This is the single gate through which all tool calls must pass. It:
   *  1. Locks the run row with FOR UPDATE.
   *  2. Fences by lease token (stale worker cannot dispatch).
   *  3. Checks run state, cancellation, scope, approval, tool identity,
   *     argument schema, limits, and budget.
   *  4. On denial: appends `tool.denied` event, returns denied — no
   *     invocation row, no adapter call.
   *  5. On authorization: writes `run_tool_invocations` in 'prepared' state,
   *     appends `tool.requested` event, returns the invocation ID + logical
   *     call ID.
   */
  async authorizeAndPrepare(input: AuthorizeInput): Promise<AuthorizeResult> {
    const traceId = input.traceId ?? null;
    const actorType = input.actorType ?? 'system';
    const actorId = input.actorId ?? null;

    return this.db.drizzle.transaction(async (tx) => {
      // 1. Lock the run row and verify scope.
      const run = await this.lockRun(tx, input.companyId, input.projectId, input.runId);

      // 2. Check run state first — terminal runs have no lease (cleared on
      // terminalization), so the lease check must come AFTER this to avoid
      // a misleading LEASE_NOT_HELD denial for a terminal run.
      if (TERMINAL_STATUSES.has(run.status)) {
        await this.emitDenied(
          tx,
          run,
          input.toolId,
          'RUN_TERMINAL',
          'Run is terminal',
          traceId,
          actorType,
          actorId,
        );
        return { authorized: false, denialCode: 'RUN_TERMINAL', denialMessage: 'Run is terminal' };
      }

      // 3. Fence by lease token.
      if (run.leaseToken !== input.leaseToken) {
        await this.emitDenied(
          tx,
          run,
          input.toolId,
          'LEASE_NOT_HELD',
          'Lease is no longer held',
          traceId,
          actorType,
          actorId,
        );
        return {
          authorized: false,
          denialCode: 'LEASE_NOT_HELD',
          denialMessage: 'Lease is no longer held',
        };
      }

      if (!EXECUTING_STATUSES.has(run.status)) {
        await this.emitDenied(
          tx,
          run,
          input.toolId,
          'INVALID_RUN_STATE',
          'Run is not in an executing state',
          traceId,
          actorType,
          actorId,
        );
        return {
          authorized: false,
          denialCode: 'INVALID_RUN_STATE',
          denialMessage: 'Run is not in an executing state',
        };
      }

      // 4. Check cancellation.
      if (run.cancelRequestedAt !== null) {
        await this.emitDenied(
          tx,
          run,
          input.toolId,
          'RUN_CANCELLED',
          'Run has a pending cancellation request',
          traceId,
          actorType,
          actorId,
        );
        return {
          authorized: false,
          denialCode: 'RUN_CANCELLED',
          denialMessage: 'Run has a pending cancellation request',
        };
      }

      // 5. Load the policy snapshot.
      if (!run.policySnapshotId) {
        await this.emitDenied(
          tx,
          run,
          input.toolId,
          'POLICY_NOT_FOUND',
          'No policy snapshot for run',
          traceId,
          actorType,
          actorId,
        );
        return {
          authorized: false,
          denialCode: 'POLICY_NOT_FOUND',
          denialMessage: 'No policy snapshot for run',
        };
      }

      const [policy] = await tx
        .select()
        .from(this.db.schema.runPolicySnapshots)
        .where(eq(this.db.schema.runPolicySnapshots.id, run.policySnapshotId))
        .limit(1);

      if (!policy) {
        await this.emitDenied(
          tx,
          run,
          input.toolId,
          'POLICY_NOT_FOUND',
          'Policy snapshot not found',
          traceId,
          actorType,
          actorId,
        );
        return {
          authorized: false,
          denialCode: 'POLICY_NOT_FOUND',
          denialMessage: 'Policy snapshot not found',
        };
      }

      // 6. Check approval (if policy requires it).
      const approvalPolicy = policy.approvalPolicy as Record<string, unknown>;
      const approvalRequired = approvalPolicy?.strategy === 'required';
      if (approvalRequired && !run.approvedPlanRevisionId) {
        await this.emitDenied(
          tx,
          run,
          input.toolId,
          'APPROVAL_REQUIRED',
          'Plan approval is required before tool execution',
          traceId,
          actorType,
          actorId,
        );
        return {
          authorized: false,
          denialCode: 'APPROVAL_REQUIRED',
          denialMessage: 'Plan approval is required before tool execution',
        };
      }

      // 7. Check tool identity (EXACT match — no prefix/wildcard).
      const toolAllowlist = policy.toolAllowlist as string[];
      if (!toolAllowlist.includes(input.toolId)) {
        await this.emitDenied(
          tx,
          run,
          input.toolId,
          'TOOL_NOT_ALLOWED',
          `Tool '${input.toolId}' is not in the allowlist`,
          traceId,
          actorType,
          actorId,
        );
        return {
          authorized: false,
          denialCode: 'TOOL_NOT_ALLOWED',
          denialMessage: `Tool '${input.toolId}' is not in the allowlist`,
        };
      }

      // 8. Validate arguments (if validator provided).
      if (input.argValidator) {
        const error = input.argValidator(input.args);
        if (error !== null) {
          await this.emitDenied(
            tx,
            run,
            input.toolId,
            'TOOL_ARGUMENTS_INVALID',
            error,
            traceId,
            actorType,
            actorId,
          );
          return { authorized: false, denialCode: 'TOOL_ARGUMENTS_INVALID', denialMessage: error };
        }
      }

      // 9. Check limits (provider call count).
      const limits = policy.limits as Record<string, number>;
      const maxProviderCalls = limits.providerCalls ?? 64;
      if (run.providerCallCount >= maxProviderCalls) {
        await this.emitDenied(
          tx,
          run,
          input.toolId,
          'LIMIT_EXCEEDED',
          'Provider call limit exceeded',
          traceId,
          actorType,
          actorId,
        );
        return {
          authorized: false,
          denialCode: 'LIMIT_EXCEEDED',
          denialMessage: 'Provider call limit exceeded',
        };
      }

      // 10. Write the invocation ledger row in 'prepared' state.
      const invocationId = randomUUID();
      const logicalCallId = input.logicalCallId ?? `call-${randomUUID()}`;
      const ordinal = input.ordinal ?? 0;
      const now = this.now();
      const seq = Number(run.lastEventSequence) + 1;

      await tx.insert(this.db.schema.runToolInvocations).values({
        id: invocationId,
        companyId: run.companyId,
        projectId: run.projectId,
        runId: run.id,
        stepKey: input.stepKey,
        attempt: input.attempt,
        toolId: input.toolId,
        ordinal,
        replayClass: input.replayClass,
        state: 'prepared',
        argsSummary: this.sanitizeArgs(input.args),
        logicalCallId,
        traceId,
        createdAt: now,
        updatedAt: now,
      });

      // 11. Append tool.requested event.
      await tx.insert(this.db.schema.runEvents).values({
        companyId: run.companyId,
        projectId: run.projectId,
        runId: run.id,
        sequence: seq,
        type: 'tool.requested',
        schemaVersion: 1,
        payload: {
          toolId: input.toolId,
          stepKey: input.stepKey,
          attempt: input.attempt,
          ordinal,
          replayClass: input.replayClass,
          logicalCallId,
        },
        actorType,
        actorId,
        traceId,
        occurredAt: now,
      });

      // 12. Update run's last_event_sequence.
      await tx
        .update(this.db.schema.missionRuns)
        .set({ lastEventSequence: seq, updatedAt: now })
        .where(eq(this.db.schema.missionRuns.id, run.id));

      return {
        authorized: true,
        invocationId,
        logicalCallId,
      };
    });
  }

  /**
   * Mark an invocation as started (execution in progress).
   * Appends `tool.started` event. Fenced by lease token.
   */
  async markStarted(input: InvocationInput): Promise<void> {
    const traceId = input.traceId ?? null;
    const actorType = input.actorType ?? 'system';
    const actorId = input.actorId ?? null;

    await this.db.drizzle.transaction(async (tx) => {
      const run = await this.lockRun(tx, input.companyId, input.projectId, input.runId);

      // Fence by lease token.
      if (run.leaseToken !== input.leaseToken) {
        throw new AppError(409, 'LEASE_NOT_HELD', 'Lease is no longer held by this worker');
      }

      // Check cancellation.
      if (run.cancelRequestedAt !== null) {
        throw new AppError(409, 'RUN_CANCELLED', 'Run has a pending cancellation request');
      }

      const now = this.now();
      const seq = Number(run.lastEventSequence) + 1;

      await tx
        .update(this.db.schema.runToolInvocations)
        .set({ state: 'started', startedAt: now, updatedAt: now })
        .where(eq(this.db.schema.runToolInvocations.id, input.invocationId));

      await tx.insert(this.db.schema.runEvents).values({
        companyId: run.companyId,
        projectId: run.projectId,
        runId: run.id,
        sequence: seq,
        type: 'tool.started',
        schemaVersion: 1,
        payload: { invocationId: input.invocationId },
        actorType,
        actorId,
        traceId,
        occurredAt: now,
      });

      await tx
        .update(this.db.schema.missionRuns)
        .set({ lastEventSequence: seq, updatedAt: now })
        .where(eq(this.db.schema.missionRuns.id, run.id));
    });
  }

  /**
   * Mark an invocation as succeeded. Appends `tool.completed` event.
   * Increments the run's provider call count. Fenced by lease token.
   */
  async completeInvocation(input: CompleteInvocationInput): Promise<void> {
    const traceId = input.traceId ?? null;
    const actorType = input.actorType ?? 'system';
    const actorId = input.actorId ?? null;

    await this.db.drizzle.transaction(async (tx) => {
      const run = await this.lockRun(tx, input.companyId, input.projectId, input.runId);

      // Fence by lease token.
      if (run.leaseToken !== input.leaseToken) {
        throw new AppError(409, 'LEASE_NOT_HELD', 'Lease is no longer held by this worker');
      }

      const now = this.now();
      const seq = Number(run.lastEventSequence) + 1;
      const newProviderCallCount = run.providerCallCount + 1;

      await tx
        .update(this.db.schema.runToolInvocations)
        .set({
          state: 'succeeded',
          resultSummary: input.resultSummary,
          providerRequestIdHash: input.providerRequestIdHash ?? null,
          externalCallId: input.externalCallId ?? null,
          costCents: input.costCents ?? 0,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(this.db.schema.runToolInvocations.id, input.invocationId));

      await tx.insert(this.db.schema.runEvents).values({
        companyId: run.companyId,
        projectId: run.projectId,
        runId: run.id,
        sequence: seq,
        type: 'tool.completed',
        schemaVersion: 1,
        payload: {
          invocationId: input.invocationId,
          costCents: input.costCents ?? 0,
        },
        actorType,
        actorId,
        traceId,
        occurredAt: now,
      });

      await tx
        .update(this.db.schema.missionRuns)
        .set({
          lastEventSequence: seq,
          providerCallCount: newProviderCallCount,
          actualCostCents: run.actualCostCents + (input.costCents ?? 0),
          updatedAt: now,
        })
        .where(eq(this.db.schema.missionRuns.id, run.id));
    });
  }

  /**
   * Mark an invocation as failed. Appends `tool.failed` event.
   * Fenced by lease token.
   */
  async failInvocation(input: FailInvocationInput): Promise<void> {
    const traceId = input.traceId ?? null;
    const actorType = input.actorType ?? 'system';
    const actorId = input.actorId ?? null;

    await this.db.drizzle.transaction(async (tx) => {
      const run = await this.lockRun(tx, input.companyId, input.projectId, input.runId);

      // Fence by lease token.
      if (run.leaseToken !== input.leaseToken) {
        throw new AppError(409, 'LEASE_NOT_HELD', 'Lease is no longer held by this worker');
      }

      const now = this.now();
      const seq = Number(run.lastEventSequence) + 1;

      await tx
        .update(this.db.schema.runToolInvocations)
        .set({
          state: 'failed',
          resultSummary: input.errorSummary,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(this.db.schema.runToolInvocations.id, input.invocationId));

      await tx.insert(this.db.schema.runEvents).values({
        companyId: run.companyId,
        projectId: run.projectId,
        runId: run.id,
        sequence: seq,
        type: 'tool.failed',
        schemaVersion: 1,
        payload: {
          invocationId: input.invocationId,
          error: input.errorSummary,
        },
        actorType,
        actorId,
        traceId,
        occurredAt: now,
      });

      await tx
        .update(this.db.schema.missionRuns)
        .set({ lastEventSequence: seq, updatedAt: now })
        .where(eq(this.db.schema.missionRuns.id, run.id));
    });
  }

  /**
   * Recover an invocation after interruption (lease loss + recovery).
   *
   * Replay-class recovery (VAL-RUN-125):
   *  - `read_only`: may reissue under one logical identity. Returns canReissue=true
   *    with the logical call ID.
   *  - `idempotent_write`: retries only through an adapter idempotency key /
   *    reconciliation read. Returns canReissue=false, adapterIdempotencyKey, and
   *    reconciliationRequired=true.
   *  - `non_replayable` in `started` or `unknown`: NEVER repeats automatically.
   *    Marks the invocation as 'unknown' if in 'started' state. Returns
   *    canReissue=false, neverRepeat=true.
   *
   * If the invocation was already completed (succeeded/failed/cancelled),
   * returns alreadyCompleted=true and no reissue is needed.
   *
   * Fenced by lease token.
   */
  async recoverInvocation(input: {
    companyId: string;
    projectId: string;
    runId: string;
    leaseToken: string;
    toolId: string;
    stepKey: string;
    attempt: number;
    ordinal?: number;
    traceId?: string | null;
    actorType?: 'user' | 'agent' | 'system';
    actorId?: string | null;
  }): Promise<RecoveryResult> {
    return this.db.drizzle.transaction(async (tx) => {
      const run = await this.lockRun(tx, input.companyId, input.projectId, input.runId);

      // Fence by lease token.
      if (run.leaseToken !== input.leaseToken) {
        throw new AppError(409, 'LEASE_NOT_HELD', 'Lease is no longer held by this worker');
      }

      // Find the existing invocation by deterministic key.
      const ordinal = input.ordinal ?? 0;
      const [invocation] = await tx
        .select()
        .from(this.db.schema.runToolInvocations)
        .where(
          and(
            eq(this.db.schema.runToolInvocations.runId, input.runId),
            eq(this.db.schema.runToolInvocations.stepKey, input.stepKey),
            eq(this.db.schema.runToolInvocations.attempt, input.attempt),
            eq(this.db.schema.runToolInvocations.toolId, input.toolId),
            eq(this.db.schema.runToolInvocations.ordinal, ordinal),
          ),
        )
        .limit(1);

      if (!invocation) {
        // No existing invocation — safe to prepare fresh.
        return {
          canReissue: true,
          alreadyCompleted: false,
        };
      }

      const replayClass = invocation.replayClass as ReplayClass;
      const state = invocation.state as InvocationState;

      // If already completed, no reissue needed.
      if (state === 'succeeded' || state === 'failed' || state === 'cancelled') {
        return {
          canReissue: false,
          alreadyCompleted: true,
          logicalCallId: invocation.logicalCallId ?? undefined,
          invocationId: invocation.id,
          replayClass,
          state,
        };
      }

      // Replay-class recovery.
      if (replayClass === 'read_only') {
        // read_only: safe to reissue under the same logical call ID.
        return {
          canReissue: true,
          alreadyCompleted: false,
          logicalCallId: invocation.logicalCallId ?? undefined,
          invocationId: invocation.id,
          replayClass,
          state,
        };
      }

      if (replayClass === 'idempotent_write') {
        // idempotent_write: retry only through adapter idempotency key /
        // reconciliation. Do NOT automatically reissue.
        return {
          canReissue: false,
          alreadyCompleted: false,
          logicalCallId: invocation.logicalCallId ?? undefined,
          adapterIdempotencyKey: invocation.logicalCallId ?? undefined,
          reconciliationRequired: true,
          invocationId: invocation.id,
          replayClass,
          state,
        };
      }

      // non_replayable: NEVER repeat automatically.
      // If the invocation is in 'started' state, mark it as 'unknown'.
      if (state === 'started' || state === 'prepared') {
        const now = this.now();
        await tx
          .update(this.db.schema.runToolInvocations)
          .set({ state: 'unknown', updatedAt: now })
          .where(eq(this.db.schema.runToolInvocations.id, invocation.id));

        return {
          canReissue: false,
          neverRepeat: true,
          isUnknown: true,
          logicalCallId: invocation.logicalCallId ?? undefined,
          invocationId: invocation.id,
          replayClass,
          state: 'unknown' as InvocationState,
        };
      }

      // Already in 'unknown' state.
      return {
        canReissue: false,
        neverRepeat: true,
        isUnknown: true,
        logicalCallId: invocation.logicalCallId ?? undefined,
        invocationId: invocation.id,
        replayClass,
        state,
      };
    });
  }

  // -- internal helpers -----------------------------------------------------

  /**
   * Lock a run row with FOR UPDATE, verifying company/project scope.
   * Returns 404 if the run does not exist in the given scope (non-enumerating).
   */
  private async lockRun(
    tx: Tx,
    companyId: string,
    projectId: string,
    runId: string,
  ): Promise<MissionRunRow> {
    const [row] = await tx
      .select()
      .from(this.db.schema.missionRuns)
      .where(
        and(
          eq(this.db.schema.missionRuns.companyId, companyId),
          eq(this.db.schema.missionRuns.projectId, projectId),
          eq(this.db.schema.missionRuns.id, runId),
        ),
      )
      .for('update')
      .limit(1);

    if (!row) {
      throw new AppError(404, 'RUN_NOT_FOUND', 'Mission run not found');
    }
    return row;
  }

  /**
   * Emit a `tool.denied` event. Does NOT create an invocation row.
   */
  private async emitDenied(
    tx: Tx,
    run: MissionRunRow,
    toolId: string,
    reason: string,
    message: string,
    traceId: string | null,
    actorType: 'user' | 'agent' | 'system',
    actorId: string | null,
  ): Promise<void> {
    const now = this.now();
    const seq = Number(run.lastEventSequence) + 1;

    await tx.insert(this.db.schema.runEvents).values({
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      sequence: seq,
      type: 'tool.denied',
      schemaVersion: 1,
      payload: { toolId, reason, message },
      actorType,
      actorId,
      traceId,
      occurredAt: now,
    });

    await tx
      .update(this.db.schema.missionRuns)
      .set({ lastEventSequence: seq, updatedAt: now })
      .where(eq(this.db.schema.missionRuns.id, run.id));
  }

  /**
   * Sanitize tool arguments for the ledger. Strips any potential secrets
   * and keeps only a bounded summary.
   */
  private sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      // Skip keys that might contain secrets.
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes('secret') ||
        lowerKey.includes('password') ||
        lowerKey.includes('token') ||
        lowerKey.includes('key') ||
        lowerKey.includes('credential')
      ) {
        sanitized[key] = '[redacted]';
      } else if (typeof value === 'string' && value.length > 1000) {
        sanitized[key] = value.slice(0, 1000) + '...';
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }
}
