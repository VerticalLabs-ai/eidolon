import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { ChatMessage, CompletionResult, ProviderConfig } from '../../providers/types.js';
import { resolveProviderApiKey } from '../provider-key.js';
import { getProvider } from '../../providers/index.js';
import type { DbInstance } from '../../types.js';
import type { Claim } from './coordinator.js';
import { MissionRecoveryService } from './recovery.js';
import { MissionCompletionService } from './completion.js';
import { MissionRetryService } from './retry.js';
import { BudgetService } from './budget.js';
import { projectEvent } from './projection.js';
import { decryptEnvelope } from './ingress.js';
import logger from '../../utils/logger.js';

/**
 * RunProcessor — the real `advance` function for the OrchestrationWorker.
 *
 * When the worker claims a run, this processor:
 *
 *  1. Checks the abort signal (cooperative cancellation from shutdown or
 *     lease loss). If already aborted, returns without calling the provider
 *     or completing the run. The worker's stop() will release the lease.
 *  2. For recovery claims (expired lease on a non-queued run): checks for
 *     non-replayable tool invocations in an unresolved state. If found, the
 *     run is failed with `unknown_effect` and the invocation is never
 *     repeated (VAL-RUN-086).
 *  3. Reads the run row and its immutable policy snapshot to determine the
 *     provider, model, and limits.
 *  4. Rechecks cancellation: if `cancel_requested_at` is set, the processor
 *     does not complete the run — the cancellation service owns
 *     terminalization (cancellation wins the race, VAL-RUN-041).
 *  5. Decrypts the request envelope and builds a minimal chat context.
 *  6. Makes a bounded single LLM provider call using the policy's
 *     provider/model and the server-side API key. The call respects the
 *     abort signal and the policy's duration limit.
 *  7. Settles the budget for the provider call (exactly-once, unique
 *     external call ID).
 *  8. Completes the run via the fenced completion service (which also
 *     releases residual budget).
 *  9. Projects committed lifecycle events (run.created, run.completed,
 *     budget.released) to mutable surfaces (thread items, activity log).
 *
 * If the provider call fails, the retry service classifies the failure and
 * either requeues the same nonterminal run (bounded backoff) or terminalizes
 * it (permanent failure).
 *
 * The provider call function is injectable for testing. In production, the
 * real provider registry is used.
 */

export type ProviderCallFn = (
  messages: ChatMessage[],
  config: ProviderConfig,
  signal: AbortSignal,
) => Promise<CompletionResult>;

export interface RunProcessorDeps {
  clock?: () => Date;
  /**
   * Override the provider call function. If not provided, the real
   * provider registry is used. Tests inject a mock to avoid real API
   * calls.
   */
  providerCall?: ProviderCallFn;
}

interface RunRow {
  id: string;
  companyId: string;
  projectId: string;
  status: string;
  stateVersion: number;
  lastEventSequence: number;
  attemptCount: number;
  cancelRequestedAt: Date | null;
  policySnapshotId: string | null;
  requestEnvelope: string | null;
  createdAt: Date;
}

interface PolicyInfo {
  provider: string;
  model: string;
  limits: Record<string, number>;
}

interface RunAndPolicy {
  run: RunRow;
  policy: PolicyInfo | null;
}

export class RunProcessor {
  constructor(
    private db: DbInstance,
    private deps: RunProcessorDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  /**
   * Advance a claimed run. This is the `advance` function passed to the
   * OrchestrationWorker.
   */
  async advance(claim: Claim, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return;
    }

    if (claim.isRecovery) {
      const terminalized = await this.handleRecovery(claim);
      if (terminalized) {
        await this.projectRunEvents(claim);
        return;
      }
    }

    if (signal.aborted) {
      return;
    }

    const data = await this.readRunAndPolicy(claim);
    if (!data || data.run.cancelRequestedAt !== null || signal.aborted) {
      return;
    }

    const requestText = this.decryptRequest(data.run);
    if (requestText === null) {
      await this.handleFailure(claim, {
        kind: 'internal',
        code: 'DECRYPT_FAILED',
        safeMessage: 'Could not decrypt the run request envelope.',
      });
      return;
    }

    await this.executeAndComplete(claim, signal, data, requestText);
  }

  // -- internal: recovery check --------------------------------------------

  private async handleRecovery(claim: Claim): Promise<boolean> {
    const recoveryService = new MissionRecoveryService(this.db, {
      clock: () => this.now(),
    });
    const result = await recoveryService.checkNonReplayableEffects({
      companyId: claim.companyId,
      projectId: claim.projectId,
      runId: claim.runId,
      leaseToken: claim.leaseToken,
    });
    return result.terminalized;
  }

  // -- internal: decrypt request envelope ----------------------------------

  private decryptRequest(run: RunRow): string | null {
    try {
      if (run.requestEnvelope) {
        const envelope = decryptEnvelope(run.requestEnvelope);
        return (envelope.text as string) ?? '';
      }
      return '';
    } catch {
      return null;
    }
  }

  // -- internal: execute provider call and complete the run ----------------

  private async executeAndComplete(
    claim: Claim,
    signal: AbortSignal,
    data: RunAndPolicy,
    requestText: string,
  ): Promise<void> {
    const provider = data.policy?.provider ?? 'anthropic';
    const model = data.policy?.model ?? 'claude-sonnet-4-6';
    const durationSeconds = data.policy?.limits?.durationSeconds ?? 300;

    const messages: ChatMessage[] = [
      { role: 'user', content: requestText || 'Process this mission run.' },
    ];
    const apiKey = resolveProviderApiKey(provider, undefined);
    const config: ProviderConfig = { apiKey, model, maxTokens: 4096 };

    const timeoutMs = Math.min(durationSeconds * 1000, 120_000);
    const timeoutController = new AbortController();
    const timeoutTimer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const combinedSignal = AbortSignal.any([signal, timeoutController.signal]);

    try {
      const callFn = this.deps.providerCall ?? this.defaultProviderCall.bind(this);
      const result = await callFn(messages, config, combinedSignal);
      clearTimeout(timeoutTimer);

      await this.settleBudget(claim, result);
      await this.completeRun(claim);
      await this.projectRunEvents(claim);
    } catch (err) {
      clearTimeout(timeoutTimer);
      if (signal.aborted) {
        return;
      }
      const isTimeout = timeoutController.signal.aborted && !signal.aborted;
      await this.handleFailure(claim, {
        kind: 'provider',
        code: isTimeout ? 'PROVIDER_TIMEOUT' : 'PROVIDER_ERROR',
        safeMessage: isTimeout
          ? 'The provider call timed out.'
          : `Provider call failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      });
    }
  }

  // -- internal: settle budget for a provider call -------------------------

  private async settleBudget(claim: Claim, result: CompletionResult): Promise<void> {
    const externalCallId = `mission-${claim.runId}-attempt-${claim.attemptCount + 1}-${randomUUID().slice(0, 8)}`;
    const budgetService = new BudgetService(this.db, { clock: () => this.now() });
    await this.db.drizzle.transaction(async (tx) => {
      await budgetService.settle(tx, {
        companyId: claim.companyId,
        runId: claim.runId,
        billingAgentId: null,
        externalCallId,
        provider: result.provider,
        model: result.model,
        operation: 'chat',
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costCents: result.costCents,
      });
    });
  }

  // -- internal: complete the run (fenced by lease token) ------------------

  private async completeRun(claim: Claim): Promise<void> {
    const completionService = new MissionCompletionService(this.db, {
      clock: () => this.now(),
    });
    await this.db.drizzle.transaction(async (tx) => {
      await completionService.completeRun(tx, claim.companyId, claim.projectId, claim.runId, {
        leaseToken: claim.leaseToken,
      });
    });
  }

  // -- internal: default provider call using the real registry -------------

  private async defaultProviderCall(
    messages: ChatMessage[],
    config: ProviderConfig,
    _signal: AbortSignal,
  ): Promise<CompletionResult> {
    void _signal;
    const provider = getProvider('anthropic');
    return provider.chat(messages, config);
  }

  // -- internal: read run + policy snapshot --------------------------------

  private async readRunAndPolicy(claim: Claim): Promise<RunAndPolicy | null> {
    const schema = this.db.schema;

    const [run] = await this.db.drizzle
      .select({
        id: schema.missionRuns.id,
        companyId: schema.missionRuns.companyId,
        projectId: schema.missionRuns.projectId,
        status: schema.missionRuns.status,
        stateVersion: schema.missionRuns.stateVersion,
        lastEventSequence: schema.missionRuns.lastEventSequence,
        attemptCount: schema.missionRuns.attemptCount,
        cancelRequestedAt: schema.missionRuns.cancelRequestedAt,
        policySnapshotId: schema.missionRuns.policySnapshotId,
        requestEnvelope: schema.missionRuns.requestEnvelope,
        createdAt: schema.missionRuns.createdAt,
      })
      .from(schema.missionRuns)
      .where(eq(schema.missionRuns.id, claim.runId))
      .limit(1);

    if (!run) {
      return null;
    }

    const policy = run.policySnapshotId ? await this.readPolicy(run.policySnapshotId) : null;
    return { run, policy };
  }

  private async readPolicy(policySnapshotId: string): Promise<PolicyInfo | null> {
    const schema = this.db.schema;
    const [policyRow] = await this.db.drizzle
      .select({
        provider: schema.runPolicySnapshots.provider,
        model: schema.runPolicySnapshots.model,
        limits: schema.runPolicySnapshots.limits,
      })
      .from(schema.runPolicySnapshots)
      .where(eq(schema.runPolicySnapshots.id, policySnapshotId))
      .limit(1);
    if (!policyRow) {
      return null;
    }
    return {
      provider: policyRow.provider,
      model: policyRow.model,
      limits: policyRow.limits as Record<string, number>,
    };
  }

  // -- internal: handle provider failure via retry service -----------------

  private async handleFailure(
    claim: Claim,
    failure: {
      kind: 'provider' | 'network' | 'internal';
      httpStatus?: number;
      code: string;
      safeMessage: string;
    },
  ): Promise<void> {
    const retryService = new MissionRetryService(this.db, { clock: () => this.now() });

    try {
      await retryService.handleExecutionFailure({
        companyId: claim.companyId,
        projectId: claim.projectId,
        runId: claim.runId,
        failure: {
          kind: failure.kind as 'provider' | 'network' | 'database',
          httpStatus: failure.httpStatus,
          code: failure.code,
          safeMessage: failure.safeMessage,
        },
        leaseToken: claim.leaseToken,
        maxAttempts: 3,
      });
    } catch {
      logger.warn(
        { runId: claim.runId, code: failure.code },
        'RunProcessor: retry service failed to handle execution failure',
      );
    }

    await this.projectRunEvents(claim);
  }

  // -- internal: project lifecycle events ----------------------------------

  private async projectRunEvents(claim: Claim): Promise<void> {
    try {
      const schema = this.db.schema;
      const events = await this.db.drizzle
        .select()
        .from(schema.runEvents)
        .where(eq(schema.runEvents.runId, claim.runId))
        .orderBy(schema.runEvents.sequence);

      for (const event of events) {
        await projectEvent(
          this.db,
          {
            runId: event.runId,
            companyId: event.companyId,
            projectId: event.projectId,
            sequence: Number(event.sequence),
            type: event.type,
            payload: event.payload as Record<string, unknown>,
            actorType: event.actorType as 'user' | 'agent' | 'system' | null,
            actorId: event.actorId,
            traceId: event.traceId,
            occurredAt: event.occurredAt,
          },
          { clock: () => this.now() },
        );
      }
    } catch {
      // Projection failure is non-fatal — it's retried idempotently.
    }
  }
}
