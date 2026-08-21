import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../middleware/error-handler.js';
import type { DbInstance } from '../../types.js';
import { resolvePolicy, policyContentHash, canonicalHash, type ResolvedPolicy } from './policy.js';
// requestContentHash is no longer used; start hashes the complete canonical
// request body (mode, limits, projectThreadId, initiatingAgentId, request)
// so different mode/limits with the same request text conflict.
import type { BuiltInMode } from './modes.js';
import { BudgetService } from './budget.js';
import {
  incrementMissionRunStarted,
  incrementMissionBudgetDenial,
} from '../../middleware/observability.js';

/**
 * Mission start service.
 *
 * Atomically commits one complete durable aggregate in a single Postgres
 * transaction: the run, immutable request + policy snapshots, finite root
 * budget reservation + allocation, the applied start command, and the
 * ordered initial creation/mode/policy/budget events. A failure after any
 * internal write rolls back the entire aggregate so no partial run, command,
 * reservation, projection, or spend is ever visible.
 */

export interface StartRequestBody {
  projectThreadId: string;
  mode: BuiltInMode;
  initiatingAgentId?: string;
  request: {
    text: string;
    attachments?: string[];
    context?: Record<string, unknown>;
  };
  limits?: {
    costCents?: number;
    totalTokens?: number;
    durationSeconds?: number;
    providerCalls?: number;
    steps?: number;
    outputBytes?: number;
  };
}

export interface StartInput {
  companyId: string;
  projectId: string;
  /** Idempotency key from the Idempotency-Key header (1-128 safe chars). */
  idempotencyKey: string;
  body: StartRequestBody;
  actorType: 'user' | 'agent' | 'system';
  actorId: string | null;
  traceId?: string | null;
}

export interface StartResult {
  run: RunSnapshot;
  command: CommandSummary;
}

export interface RunSnapshot {
  id: string;
  companyId: string;
  projectId: string;
  projectThreadId: string;
  status: string;
  stateVersion: number;
  lastEventSequence: number;
  resolvedMode: string;
  policySnapshotId: string | null;
  policyContentHash: string | null;
  requestContentHash: string;
  createdAt: string;
  updatedAt: string;
  budget: {
    reservedCents: number;
    settledCents: number;
    releasedCents: number;
    costCentsCeiling: number;
  };
}

export interface CommandSummary {
  id: string;
  type: string;
  idempotencyKey: string;
  status: string;
  resultStatusCode: number;
  createdAt: string;
  appliedAt: string;
  traceId: string | null;
}

/** Test-only failpoint hook. Throwing aborts the transaction. */
export type FailpointHook =
  'after_policy' | 'after_run' | 'after_reservation' | 'after_command' | 'after_events';

export interface MissionStartDeps {
  clock?: () => Date;
  /** Test-only: throw from the named hook to prove atomic rollback. */
  failpoint?: { at: FailpointHook; throw: () => Error };
}

export class MissionStartService {
  constructor(
    private db: DbInstance,
    private deps: MissionStartDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  private fireFailpoint(at: FailpointHook): void {
    if (this.deps.failpoint?.at === at) {
      throw this.deps.failpoint.throw();
    }
  }

  async start(input: StartInput): Promise<StartResult> {
    const { companyId, projectId, body, actorType, actorId, traceId } = input;
    const schema = this.db.schema;
    const now = this.now();
    const idempotencyKey = input.idempotencyKey;

    // 1. Idempotency replay/conflict check (start is scoped by project).
    const existing = await this.lookupStartCommand(companyId, projectId, idempotencyKey);
    if (existing) {
      return await this.replayOrConflict(existing, body);
    }

    // 2. Validate thread ownership (same company + project). Non-enumerating 404.
    await this.validateThread(companyId, projectId, body.projectThreadId);

    // 3. Resolve the initiating agent (provider/model/tools) if provided.
    const agent = body.initiatingAgentId
      ? await this.lookupAgent(companyId, body.initiatingAgentId)
      : undefined;

    // 4. Resolve the effective policy.
    const policy = resolvePolicy({
      mode: body.mode,
      agent: agent
        ? {
            provider: agent.provider,
            adapterId: agent.adapterId ?? undefined,
            model: agent.model,
            toolAllowlist: agent.toolsEnabled ?? [],
            domainAllowlist: agent.allowedDomains ?? [],
          }
        : undefined,
      userLimits: body.limits,
    });

    // Hash the COMPLETE canonical request body (mode, limits, projectThreadId,
    // initiatingAgentId, request) so that different mode/limits with the same
    // request text conflict (HIGH-RISK REPAIR: complete-body start hash).
    const reqHash = canonicalHash({
      mode: body.mode,
      projectThreadId: body.projectThreadId,
      initiatingAgentId: body.initiatingAgentId ?? null,
      request: body.request,
      limits: body.limits ?? null,
    });
    const policyHash = policyContentHash(policy);
    const ceiling = policy.limits.costCents;

    // 5. One atomic transaction committing the entire aggregate.
    try {
      const result = await this.db.drizzle.transaction(async (tx) => {
        // 5a. Immutable policy snapshot.
        const [policyRow] = await tx
          .insert(schema.runPolicySnapshots)
          .values({
            companyId,
            schemaVersion: policy.schemaVersion,
            sourceProfile: policy.sourceProfile,
            provider: policy.provider,
            adapterId: policy.adapterId,
            model: policy.model,
            reasoningDepth: policy.reasoningDepth,
            systemPromptHash: policy.systemPromptHash,
            instructionHash: policy.instructionHash,
            toolAllowlist: policy.toolAllowlist,
            domainAllowlist: policy.domainAllowlist,
            researchPolicy: policy.researchPolicy,
            planningPolicy: policy.planningPolicy,
            approvalPolicy: policy.approvalPolicy,
            fallbackPolicy: policy.fallbackPolicy,
            partialResultPolicy: policy.partialResultPolicy,
            limits: policy.limits as unknown as Record<string, number>,
            contentHash: policyHash,
            createdAt: now,
          })
          .returning({ id: schema.runPolicySnapshots.id });
        const policySnapshotId = policyRow.id;

        this.fireFailpoint('after_policy');

        // 5b. Run row. root_run_id equals its own id for a root run; the id is
        // generated up front so the root-self check constraint holds on insert.
        const runId = randomUUID();
        await tx.insert(schema.missionRuns).values({
          id: runId,
          companyId,
          projectId,
          projectThreadId: body.projectThreadId,
          rootRunId: runId,
          depth: 0,
          initiatingUserId: actorType === 'user' ? actorId : null,
          initiatingAgentId: body.initiatingAgentId ?? null,
          billingAgentId: body.initiatingAgentId ?? null,
          routingKind: 'company_agent',
          requestEnvelope: body.request as Record<string, unknown>,
          requestContentHash: reqHash,
          resolvedMode: policy.resolvedMode,
          policySnapshotId,
          status: 'draft',
          stateVersion: 1,
          lastEventSequence: 0,
          partialResultPolicy: policy.partialResultPolicy,
          createdAt: now,
          updatedAt: now,
        });

        this.fireFailpoint('after_run');

        // 5c. Finite root budget reservation + initial allocation. The
        //     budget module locks company + billing agent in stable order,
        //     checks headroom, and creates the reservation + allocation
        //     atomically. Throws 409 BUDGET_UNAVAILABLE when headroom is
        //     insufficient (VAL-RUN-061, VAL-CROSS-061).
        const periodKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
        const budgetService = new BudgetService(this.db, { clock: () => now });
        const budgetResult = await budgetService.reserveRoot(tx, {
          companyId,
          runId,
          billingAgentId: body.initiatingAgentId ?? null,
          requestedCents: ceiling,
          periodKey,
        });
        const reservedCents = budgetResult.reservedCents;

        this.fireFailpoint('after_reservation');

        // 5d. Applied start command with a placeholder result_body; the
        //     exact replayable result is stored at the end of the tx after
        //     all writes are committed (HIGH-RISK REPAIR: atomic replay
        //     persistence — the result_body is persisted atomically with the
        //     initial aggregate, not after the tx commits).
        const [commandRow] = await tx
          .insert(schema.runCommands)
          .values({
            companyId,
            projectId,
            runId,
            type: 'run.start',
            idempotencyKey,
            requestHash: reqHash,
            payload: {
              request: body.request,
              mode: body.mode,
              limits: body.limits ?? null,
            } as Record<string, unknown>,
            actorType,
            actorId: actorId ?? null,
            status: 'applied',
            resultStatusCode: 202,
            resultBody: { runId } as Record<string, unknown>,
            traceId: traceId ?? null,
            createdAt: now,
            appliedAt: now,
          })
          .returning();

        this.fireFailpoint('after_command');

        // 5e. Ordered initial events: creation, mode, policy, budget.
        const events = [
          { type: 'run.created', payload: { runId, status: 'draft' } },
          {
            type: 'mode.resolved',
            payload: { mode: body.mode, resolvedMode: policy.resolvedMode },
          },
          { type: 'policy.snapshotted', payload: { policySnapshotId, contentHash: policyHash } },
          { type: 'budget.reserved', payload: { reservedCents, periodKey } },
        ];
        let seq = 0;
        for (const event of events) {
          seq += 1;
          await tx.insert(schema.runEvents).values({
            companyId,
            projectId,
            runId,
            sequence: seq,
            type: event.type,
            schemaVersion: 1,
            payload: event.payload,
            commandId: commandRow.id,
            actorType,
            actorId: actorId ?? null,
            traceId: traceId ?? null,
            occurredAt: now,
          });
        }

        // 5f. Advance the run's event counter.
        await tx
          .update(schema.missionRuns)
          .set({ lastEventSequence: seq, updatedAt: now })
          .where(eq(schema.missionRuns.id, runId));

        this.fireFailpoint('after_events');

        // 5g. Build the exact replayable result snapshot from the
        //     in-transaction data and persist it in the command's
        //     result_body within the same transaction. This ensures the
        //     replayable status, headers, and body are committed atomically
        //     with the initial aggregate (HIGH-RISK REPAIR: atomic replay
        //     persistence). A crash between the tx commit and a post-tx
        //     update can no longer leave a command without its replayable
        //     result.
        const built = this.buildStartResultFromTx({
          runId,
          commandId: commandRow.id,
          companyId,
          projectId,
          projectThreadId: body.projectThreadId,
          policySnapshotId,
          policyHash,
          reqHash,
          resolvedMode: policy.resolvedMode,
          ceiling,
          reservedCents,
          lastEventSequence: seq,
          now,
          commandCreatedAt: commandRow.createdAt,
          commandIdempotencyKey: idempotencyKey,
          traceId: traceId ?? null,
        });
        await tx
          .update(schema.runCommands)
          .set({ resultBody: built as unknown as Record<string, unknown> })
          .where(eq(schema.runCommands.id, commandRow.id));

        return built;
      });

      // Increment the run-started counter only for new runs, not replays
      // (VAL-RUN-078: idempotent replay must not count as a second run).
      incrementMissionRunStarted(policy.resolvedMode);
      return result;
    } catch (err) {
      // Increment budget denial counter when budget is unavailable
      // (VAL-RUN-078). The error propagates after the counter is incremented.
      if (err instanceof AppError && err.code === 'BUDGET_UNAVAILABLE') {
        incrementMissionBudgetDenial();
      }
      // A unique-violation on the start idempotency index means a concurrent
      // identical start won; re-read and replay/conflict.
      if (this.isUniqueViolation(err)) {
        const existing = await this.lookupStartCommand(companyId, projectId, idempotencyKey);
        if (existing) {
          return await this.replayOrConflict(existing, body);
        }
      }
      throw err;
    }
  }

  /**
   * Build the exact replayable StartResult from in-transaction data without
   * re-reading from the database. This is called inside the start
   * transaction so the result_body is persisted atomically with the
   * initial aggregate (HIGH-RISK REPAIR: atomic replay persistence).
   */
  private buildStartResultFromTx(input: {
    runId: string;
    commandId: string;
    companyId: string;
    projectId: string;
    projectThreadId: string;
    policySnapshotId: string;
    policyHash: string;
    reqHash: string;
    resolvedMode: string;
    ceiling: number;
    reservedCents: number;
    lastEventSequence: number;
    now: Date;
    commandCreatedAt: Date;
    commandIdempotencyKey: string;
    traceId: string | null;
  }): StartResult {
    const nowIso = input.now.toISOString();
    return {
      run: {
        id: input.runId,
        companyId: input.companyId,
        projectId: input.projectId,
        projectThreadId: input.projectThreadId,
        status: 'draft',
        stateVersion: 1,
        lastEventSequence: input.lastEventSequence,
        resolvedMode: input.resolvedMode,
        policySnapshotId: input.policySnapshotId,
        policyContentHash: input.policyHash,
        requestContentHash: input.reqHash,
        createdAt: nowIso,
        updatedAt: nowIso,
        budget: {
          reservedCents: input.reservedCents,
          settledCents: 0,
          releasedCents: 0,
          costCentsCeiling: input.ceiling,
        },
      },
      command: {
        id: input.commandId,
        type: 'run.start',
        idempotencyKey: input.commandIdempotencyKey,
        status: 'applied',
        resultStatusCode: 202,
        createdAt: input.commandCreatedAt.toISOString(),
        appliedAt: input.commandCreatedAt.toISOString(),
        traceId: input.traceId,
      },
    };
  }

  private async lookupStartCommand(companyId: string, projectId: string, key: string) {
    const schema = this.db.schema;
    const [row] = await this.db.drizzle
      .select()
      .from(schema.runCommands)
      .where(
        and(
          eq(schema.runCommands.companyId, companyId),
          eq(schema.runCommands.projectId, projectId),
          eq(schema.runCommands.idempotencyKey, key),
          eq(schema.runCommands.type, 'run.start'),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  private async replayOrConflict(
    existing: {
      requestHash: string;
      runId: string | null;
      id: string;
      idempotencyKey: string;
      createdAt: Date;
      appliedAt: Date | null;
      resultBody: Record<string, unknown> | null;
      traceId: string | null;
    },
    body: StartRequestBody,
  ): Promise<StartResult> {
    const reqHash = canonicalHash({
      mode: body.mode,
      projectThreadId: body.projectThreadId,
      initiatingAgentId: body.initiatingAgentId ?? null,
      request: body.request,
      limits: body.limits ?? null,
    });
    if (existing.requestHash !== reqHash) {
      throw new AppError(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency key already used for different content',
      );
    }
    if (!existing.runId) {
      throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key already used');
    }
    // Durable replay: return the exact stored result so a replay (even after
    // the run advanced) returns the original status, headers, and body
    // (VAL-RUN-052, VAL-RUN-116). Fall back to re-reading only if a legacy
    // command row predates stored results.
    const stored = existing.resultBody as {
      run?: StartResult['run'];
      command?: StartResult['command'];
    } | null;
    if (stored?.run && stored?.command) {
      return { run: stored.run, command: { ...stored.command, traceId: existing.traceId ?? null } };
    }
    const [run] = await this.db.drizzle
      .select()
      .from(this.db.schema.missionRuns)
      .where(eq(this.db.schema.missionRuns.id, existing.runId))
      .limit(1);
    const [reservation] = await this.db.drizzle
      .select()
      .from(this.db.schema.budgetReservations)
      .where(eq(this.db.schema.budgetReservations.runId, existing.runId))
      .limit(1);
    let policyContentHash: string | null = null;
    if (run.policySnapshotId) {
      const [policy] = await this.db.drizzle
        .select({ contentHash: this.db.schema.runPolicySnapshots.contentHash })
        .from(this.db.schema.runPolicySnapshots)
        .where(eq(this.db.schema.runPolicySnapshots.id, run.policySnapshotId))
        .limit(1);
      policyContentHash = policy?.contentHash ?? null;
    }
    return {
      run: {
        id: run.id,
        companyId: run.companyId,
        projectId: run.projectId,
        projectThreadId: run.projectThreadId,
        status: run.status,
        stateVersion: run.stateVersion,
        lastEventSequence: Number(run.lastEventSequence),
        resolvedMode: run.resolvedMode,
        policySnapshotId: run.policySnapshotId,
        policyContentHash,
        requestContentHash: run.requestContentHash,
        createdAt: run.createdAt.toISOString(),
        updatedAt: run.updatedAt.toISOString(),
        budget: {
          reservedCents: reservation.reservedCents,
          settledCents: reservation.settledCents,
          releasedCents: reservation.releasedCents,
          costCentsCeiling: reservation.reservedCents,
        },
      },
      command: {
        id: existing.id,
        type: 'run.start',
        idempotencyKey: existing.idempotencyKey,
        status: 'applied',
        resultStatusCode: 202,
        createdAt: existing.createdAt.toISOString(),
        appliedAt: existing.appliedAt
          ? existing.appliedAt.toISOString()
          : existing.createdAt.toISOString(),
        traceId: existing.traceId ?? null,
      },
    };
  }

  private async validateThread(
    companyId: string,
    projectId: string,
    threadId: string,
  ): Promise<void> {
    const schema = this.db.schema;
    const [thread] = await this.db.drizzle
      .select({ id: schema.projectThreads.id })
      .from(schema.projectThreads)
      .where(
        and(
          eq(schema.projectThreads.id, threadId),
          eq(schema.projectThreads.companyId, companyId),
          eq(schema.projectThreads.projectId, projectId),
        ),
      )
      .limit(1);
    if (!thread) {
      throw new AppError(404, 'THREAD_NOT_FOUND', 'Choose a thread from this project.');
    }
  }

  private async lookupAgent(companyId: string, agentId: string) {
    const schema = this.db.schema;
    const [agent] = await this.db.drizzle
      .select({
        id: schema.agents.id,
        provider: schema.agents.provider,
        adapterId: schema.agents.adapterId,
        model: schema.agents.model,
        toolsEnabled: schema.agents.toolsEnabled,
        allowedDomains: schema.agents.allowedDomains,
      })
      .from(schema.agents)
      .where(and(eq(schema.agents.id, agentId), eq(schema.agents.companyId, companyId)))
      .limit(1);
    if (!agent) {
      throw new AppError(404, 'AGENT_NOT_FOUND', 'Choose an agent from this company.');
    }
    return agent;
  }

  private isUniqueViolation(err: unknown): boolean {
    const code = (err as { code?: string })?.code;
    return code === '23505';
  }
}

/** Re-export for route/test use. */
export type { ResolvedPolicy };
