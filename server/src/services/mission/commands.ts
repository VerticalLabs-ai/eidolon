import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../middleware/error-handler.js';
import type { DbInstance } from '../../types.js';
import { commandRequestHash } from './idempotency.js';
import { canonicalHash } from './policy.js';
import { BudgetService } from './budget.js';
import { MissionCancellationService } from './cancellation.js';
import { encryptReason } from './reason-security.js';
import { validateAndEncryptIngress, decryptEnvelope, generateSafeSummary } from './ingress.js';
import {
  incrementMissionCommand,
  incrementMissionIdempotentReplay,
} from '../../middleware/observability.js';

/**
 * Canonical command ingress and shared idempotency for run-scoped Mission
 * mutations.
 *
 * One `MissionCommandService.submit` path owns idempotency replay/conflict,
 * the `If-Match` precondition, state-transition validation, the locked
 * transaction that appends the journal event and bumps `state_version`, and
 * the durable replayable result. The canonical `POST /:runId/commands`
 * endpoint and every convenience route map to the same logical
 * `{type, body}` and share one `(company_id, run_id, idempotency_key)`
 * namespace, so identical logical content replays the original result and
 * changed discriminated content under the same key returns
 * `409 IDEMPOTENCY_KEY_REUSED` (VAL-RUN-115).
 *
 * Phase 1 implements `run.cancel` (command-level cancellation) and
 * `run.retry` (a fresh linked successor run). Other stable command types
 * are declared in the mutation matrix but owned by later features.
 */

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const RETRY_LEGAL = new Set(['failed', 'cancelled']);

/**
 * Internal sentinel thrown inside the locked transaction when a concurrent
 * duplicate command is detected after locking. The catch block in `submit`
 * converts it to a replay/conflict response. This ensures no uniqueness
 * error escapes (HIGH-RISK REPAIR: recheck durable idempotency after
 * locking).
 */
class IdempotencyReplayError extends Error {
  constructor(readonly row: MissionCommandRow) {
    super('Concurrent idempotent command detected after locking');
    this.name = 'IdempotencyReplayError';
  }
}

/** Sentinel for stale version (412) inside tx; catch records rejected row (VAL-RUN-075). */
class StaleVersionSentinel extends Error {
  constructor() {
    super('Stale version detected inside transaction');
    this.name = 'StaleVersionSentinel';
  }
}

/** Sentinel for invalid state (409) inside tx; same pattern as StaleVersionSentinel. */
class InvalidStateSentinel extends Error {
  constructor() {
    super('Invalid run state detected inside transaction');
    this.name = 'InvalidStateSentinel';
  }
}

export type RunCommandType = 'run.cancel' | 'run.retry';

export interface CancelBody {
  reason?: string;
}

export interface RetryBody {
  limits?: {
    costCents?: number;
    totalTokens?: number;
    durationSeconds?: number;
    providerCalls?: number;
    steps?: number;
    outputBytes?: number;
  };
  request?: { text?: string; attachments?: string[]; context?: Record<string, unknown> };
}

export interface CommandInput {
  companyId: string;
  projectId: string;
  runId: string;
  type: RunCommandType;
  body: unknown;
  idempotencyKey: string;
  /** Parsed `If-Match` state version, or null when absent. */
  ifMatch: number | null;
  actorType: 'user' | 'agent' | 'system';
  actorId: string | null;
  traceId?: string | null;
}

/** Lean run snapshot returned in a command response. */
export interface CommandRunSnapshot {
  id: string;
  companyId: string;
  projectId: string;
  status: string;
  stateVersion: number;
  lastEventSequence: number;
  resolvedMode: string;
  policyContentHash: string | null;
  requestContentHash: string;
  cancelRequestedAt: string | null;
  cancelRequestedBy: string | null;
  cancellationDeadlineAt: string | null;
  retryOfRunId: string | null;
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

export interface CommandResult {
  statusCode: number;
  /** State version for the strong ETag. */
  etag: number;
  run: CommandRunSnapshot;
  command: CommandSummary;
  /** Successor run id for retry (used to build the Location header). */
  successorRunId?: string;
}

/**
 * The replayable result stored in `run_commands.result_body`. The command
 * summary is reconstructed from the command row on replay, so only the
 * response run snapshot + status + etag (+ successor for retry) are stored.
 */
interface StoredResult {
  statusCode: number;
  etag: number;
  run: CommandRunSnapshot;
  successorRunId?: string;
}

/** Internal result from an apply method, before the command summary. */
interface ApplyOutcome {
  statusCode: number;
  etag: number;
  run: CommandRunSnapshot;
  commandRow: MissionCommandRow;
  successorRunId?: string;
}

/**
 * Pre-computed ingress hardening result for the retry branch. When a new
 * request is provided, the envelope is validated (reference isolation +
 * structural bounds), encrypted, and a safe summary is generated. When no
 * new request is provided, the existing encrypted envelope and safe summary
 * are copied from the original run (VAL-RUN-133, VAL-RUN-134, VAL-RUN-135,
 * Normative Boundary 3).
 */
interface RetryIngressResult {
  encryptedEnvelope: string;
  safeSummary: string;
  reqHash: string;
}

export interface MissionCommandDeps {
  clock?: () => Date;
}

type MissionRunRow = DbInstance['schema']['missionRuns']['$inferSelect'];
type MissionCommandRow = DbInstance['schema']['runCommands']['$inferSelect'];
type Tx = Parameters<Parameters<DbInstance['drizzle']['transaction']>[0]>[0];

export class MissionCommandService {
  constructor(
    private db: DbInstance,
    private deps: MissionCommandDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  async submit(input: CommandInput): Promise<CommandResult> {
    const { companyId, projectId, runId, type, body, idempotencyKey, ifMatch, actorType, actorId } =
      input;
    const traceId = input.traceId ?? null;

    // 1. Idempotency replay takes first precedence: a same-key replay wins
    //    even after the run advanced (VAL-RUN-137). Scope check includes
    //    projectId so a command from a different project cannot replay
    //    (HIGH-RISK REPAIR: company + project + run scope).
    const existing = await this.lookupCommand(companyId, projectId, runId, idempotencyKey);
    if (existing) {
      return this.replayOrConflict(existing, type, body);
    }

    // 2. Load the run with a scope check (company + project + run).
    //    Non-enumerating 404 for absent or cross-scope ids.
    const run = await this.loadRun(companyId, projectId, runId);

    // 3. Precondition presence + state guard (before the transaction so a
    //    rejection leaves no state or event change). Domain-rejected
    //    commands are recorded as rejected rows so they remain visible in
    //    history without changing state, events, budget, or output
    //    (VAL-RUN-075).
    let retryIngress: RetryIngressResult | undefined;
    if (type === 'run.cancel') {
      if (TERMINAL_STATUSES.has(run.status)) {
        // Already-terminal: return 200 with the current snapshot, no event,
        // no state change (matrix alreadyTerminalBehavior).
        // Already-terminal cancel is a new applied command (200, no state change).
        incrementMissionCommand('run.cancel', 'applied');
        return this.toResult(
          await this.applyCancelAlreadyTerminal(
            run,
            body,
            idempotencyKey,
            actorType,
            actorId,
            traceId,
          ),
        );
      }
      if (ifMatch === null) {
        await this.recordRejected(
          run,
          type,
          body,
          idempotencyKey,
          428,
          'PRECONDITION_REQUIRED',
          'If-Match is required for this action',
          actorType,
          actorId,
          ifMatch,
        );
        throw new AppError(428, 'PRECONDITION_REQUIRED', 'If-Match is required for this action');
      }
    } else if (type === 'run.retry') {
      if (ifMatch === null) {
        await this.recordRejected(
          run,
          type,
          body,
          idempotencyKey,
          428,
          'PRECONDITION_REQUIRED',
          'If-Match is required for this action',
          actorType,
          actorId,
          ifMatch,
        );
        throw new AppError(428, 'PRECONDITION_REQUIRED', 'If-Match is required for this action');
      }
      if (!RETRY_LEGAL.has(run.status)) {
        await this.recordRejected(
          run,
          type,
          body,
          idempotencyKey,
          409,
          'INVALID_RUN_STATE',
          'Retry is only allowed from a failed or cancelled run',
          actorType,
          actorId,
          ifMatch,
        );
        throw new AppError(
          409,
          'INVALID_RUN_STATE',
          'Retry is only allowed from a failed or cancelled run',
        );
      }
      // Ingress hardening: route the retry request envelope through
      // validateAndEncryptIngress so retry successors get reference
      // isolation, structural bounds, NFC-normalized safe summary, and
      // encryption-at-rest — matching MissionStartService.start
      // (VAL-RUN-133, VAL-RUN-134, Normative Boundary 3). A validation
      // failure throws before the transaction so no successor, command,
      // reservation, or projection is created.
      retryIngress = await this.validateRetryIngress(run, body);
    }

    // 4. Locked transaction: re-check durable idempotency under the lock,
    //    re-check the version, apply, and record the replayable result.
    //    Rechecking idempotency after locking ensures concurrent duplicate
    //    commands replay one outcome, changed requests conflict, and no
    //    stale-version or uniqueness error escapes (HIGH-RISK REPAIR).
    try {
      const outcome = await this.db.drizzle.transaction(async (tx) => {
        const locked = await this.lockRun(tx, companyId, projectId, runId);

        // Recheck durable idempotency after locking: a concurrent duplicate
        // may have inserted between the pre-lock lookup and the lock
        // acquisition. If found, replay/conflict from within the tx so no
        // uniqueness error escapes.
        const concurrent = await this.lookupCommandInTx(
          tx,
          companyId,
          projectId,
          runId,
          idempotencyKey,
        );
        if (concurrent) {
          // Throw a special sentinel that the catch block converts to
          // replay/conflict. This avoids a unique violation.
          throw new IdempotencyReplayError(concurrent);
        }

        if (type === 'run.cancel') {
          if (locked.stateVersion !== ifMatch) {
            throw new StaleVersionSentinel();
          }
          // A concurrent cancel already recorded the request: idempotent
          // no-op (no duplicate cancellation event).
          if (locked.cancelRequestedAt !== null) {
            return this.recordCancelNoop(
              tx,
              locked,
              body,
              idempotencyKey,
              actorType,
              actorId,
              traceId,
            );
          }
          return this.applyCancel(tx, locked, body, idempotencyKey, actorType, actorId, traceId);
        }
        // run.retry
        if (locked.stateVersion !== ifMatch) {
          throw new StaleVersionSentinel();
        }
        if (!RETRY_LEGAL.has(locked.status)) {
          throw new InvalidStateSentinel();
        }
        // run.retry — retryIngress is guaranteed to be set here because it
        // was computed in the pre-transaction retry block above.
        if (!retryIngress) {
          throw new Error('retryIngress not computed for run.retry');
        }
        return this.applyRetry(
          tx,
          locked,
          body,
          idempotencyKey,
          actorType,
          actorId,
          traceId,
          retryIngress,
        );
      });
      // Increment command counter for a newly applied command (not a replay).
      incrementMissionCommand(type, 'applied');
      return this.toResult(outcome);
    } catch (err) {
      if (err instanceof IdempotencyReplayError) {
        return this.replayOrConflict(err.row, type, body);
      }
      if (err instanceof StaleVersionSentinel) {
        await this.recordRejected(
          run,
          type,
          body,
          idempotencyKey,
          412,
          'RUN_VERSION_MISMATCH',
          'Run state version mismatch',
          actorType,
          actorId,
          ifMatch,
        );
        throw new AppError(412, 'RUN_VERSION_MISMATCH', 'Run state version mismatch');
      }
      if (err instanceof InvalidStateSentinel) {
        await this.recordRejected(
          run,
          type,
          body,
          idempotencyKey,
          409,
          'INVALID_RUN_STATE',
          'Retry is only allowed from a failed or cancelled run',
          actorType,
          actorId,
          ifMatch,
        );
        throw new AppError(
          409,
          'INVALID_RUN_STATE',
          'Retry is only allowed from a failed or cancelled run',
        );
      }
      if (this.isUniqueViolation(err)) {
        const ex = await this.lookupCommand(companyId, projectId, runId, idempotencyKey);
        if (ex) {
          return this.replayOrConflict(ex, type, body);
        }
      }
      throw err;
    }
  }

  // -- cancel ---------------------------------------------------------------

  private async applyCancel(
    tx: Tx,
    run: MissionRunRow,
    body: unknown,
    idempotencyKey: string,
    actorType: 'user' | 'agent' | 'system',
    actorId: string | null,
    traceId: string | null,
  ): Promise<ApplyOutcome> {
    // Delegate to the cancellation service which records the request,
    // computes the bounded deadline, cascades to descendants, and
    // terminalizes immediately for non-lease states (VAL-RUN-117,
    // VAL-RUN-136).
    const cancelService = new MissionCancellationService(this.db, {
      clock: () => this.now(),
    });
    const cancelResult = await cancelService.requestCancellation(tx, run, {
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      actorType,
      actorId,
      traceId,
    });

    // Build the response snapshot AFTER the cancellation service has
    // applied all state/event/budget changes.
    const snapshot = await this.buildSnapshot(tx, run.id);

    const stored: StoredResult = {
      statusCode: cancelResult.statusCode,
      etag: snapshot.stateVersion,
      run: snapshot,
    };
    const commandRow = await this.insertCommand(tx, {
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      type: 'run.cancel',
      idempotencyKey,
      requestHash: commandRequestHash('run.cancel', body),
      payload: this.encryptCancelPayload(body),
      actorType,
      actorId,
      expectedStateVersion: run.stateVersion,
      resultStatusCode: cancelResult.statusCode,
      stored,
      traceId,
    });

    return {
      statusCode: cancelResult.statusCode,
      etag: snapshot.stateVersion,
      run: snapshot,
      commandRow,
    };
  }

  private async recordCancelNoop(
    tx: Tx,
    run: MissionRunRow,
    body: unknown,
    idempotencyKey: string,
    actorType: 'user' | 'agent' | 'system',
    actorId: string | null,
    traceId?: string | null,
  ): Promise<ApplyOutcome> {
    // A cancel was already requested; record this command as an applied,
    // inert 200 with the current snapshot and no new event.
    const snapshot = await this.buildSnapshot(tx, run.id);
    const stored: StoredResult = { statusCode: 200, etag: snapshot.stateVersion, run: snapshot };
    const commandRow = await this.insertCommand(tx, {
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      type: 'run.cancel',
      idempotencyKey,
      requestHash: commandRequestHash('run.cancel', body),
      payload: this.encryptCancelPayload(body),
      actorType,
      actorId,
      expectedStateVersion: run.stateVersion,
      resultStatusCode: 200,
      stored,
      traceId,
    });
    return { statusCode: 200, etag: snapshot.stateVersion, run: snapshot, commandRow };
  }

  private async applyCancelAlreadyTerminal(
    run: MissionRunRow,
    body: unknown,
    idempotencyKey: string,
    actorType: 'user' | 'agent' | 'system',
    actorId: string | null,
    traceId?: string | null,
  ): Promise<ApplyOutcome> {
    const now = this.now();
    const snapshot = await this.buildSnapshot(this.db.drizzle, run.id);
    const stored: StoredResult = { statusCode: 200, etag: snapshot.stateVersion, run: snapshot };
    const commandRow = await this.insertCommand(this.db.drizzle, {
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      type: 'run.cancel',
      idempotencyKey,
      requestHash: commandRequestHash('run.cancel', body),
      payload: this.encryptCancelPayload(body),
      actorType,
      actorId,
      expectedStateVersion: run.stateVersion,
      resultStatusCode: 200,
      stored,
      now,
      traceId,
    });
    return { statusCode: 200, etag: snapshot.stateVersion, run: snapshot, commandRow };
  }

  /**
   * Validate and encrypt the retry request envelope, or copy the existing
   * encrypted envelope + safe summary when no new request is provided
   * (VAL-RUN-133, VAL-RUN-134, VAL-RUN-135, Normative Boundary 3).
   *
   * When a new request is provided, this routes through
   * `validateAndEncryptIngress` so the successor gets the same reference
   * isolation, structural bounds, NFC-normalized safe summary, and
   * encryption-at-rest as `MissionStartService.start`. A validation failure
   * throws before the transaction so no successor, command, reservation, or
   * projection is created.
   *
   * When no new request is provided, the original encrypted envelope is
   * copied directly (it is already encrypted at rest) and the safe summary
   * is copied from the original run's `request_safe_summary` column. If the
   * original run predates the safe summary column (legacy), the envelope is
   * decrypted and a fresh safe summary is generated.
   */
  private async validateRetryIngress(
    run: MissionRunRow,
    body: unknown,
  ): Promise<RetryIngressResult> {
    const retryBody = (body ?? {}) as RetryBody;

    if (retryBody.request) {
      // New request: validate reference isolation + structural bounds,
      // generate a safe summary, and encrypt at rest.
      const ingress = await validateAndEncryptIngress(this.db, {
        companyId: run.companyId,
        projectId: run.projectId,
        text: retryBody.request.text ?? '',
        attachments: retryBody.request.attachments,
        context: retryBody.request.context,
      });
      // Hash the original (pre-normalization) request for the run's
      // request_content_hash, consistent with the existing retry hash
      // semantics.
      const reqHash = canonicalHash({
        text: retryBody.request.text ?? '',
        attachments: retryBody.request.attachments ?? [],
        context: retryBody.request.context ?? {},
      });
      return {
        encryptedEnvelope: ingress.encryptedEnvelope,
        safeSummary: ingress.safeSummary,
        reqHash,
      };
    }

    // No new request: copy the existing encrypted envelope and safe summary.
    const encryptedEnvelope = run.requestEnvelope as unknown as string;
    let safeSummary = run.requestSafeSummary;
    if (!safeSummary) {
      // Legacy run without a safe summary: decrypt and regenerate.
      const envelope = decryptEnvelope(encryptedEnvelope);
      safeSummary = generateSafeSummary(envelope.text as string);
    }
    return {
      encryptedEnvelope,
      safeSummary,
      reqHash: run.requestContentHash,
    };
  }

  // -- retry ----------------------------------------------------------------

  private async applyRetry(
    tx: Tx,
    run: MissionRunRow,
    body: unknown,
    idempotencyKey: string,
    actorType: 'user' | 'agent' | 'system',
    actorId: string | null,
    traceId: string | null,
    retryIngress: RetryIngressResult,
  ): Promise<ApplyOutcome> {
    const schema = this.db.schema;
    const now = this.now();

    // Copy the original immutable policy snapshot to a fresh row so the
    // successor has its own snapshot identity ("fresh snapshot").
    const [origPolicy] = await tx
      .select()
      .from(schema.runPolicySnapshots)
      .where(eq(schema.runPolicySnapshots.id, run.policySnapshotId ?? ''))
      .limit(1);
    if (!origPolicy) {
      throw new AppError(500, 'INTERNAL_SERVER_ERROR', 'Original policy snapshot missing');
    }
    const successorPolicyId = randomUUID();
    await tx.insert(schema.runPolicySnapshots).values({
      id: successorPolicyId,
      companyId: origPolicy.companyId,
      schemaVersion: origPolicy.schemaVersion,
      sourceProfile: origPolicy.sourceProfile,
      sourceProfileVersion: origPolicy.sourceProfileVersion,
      provider: origPolicy.provider,
      adapterId: origPolicy.adapterId,
      model: origPolicy.model,
      reasoningDepth: origPolicy.reasoningDepth,
      systemPromptHash: origPolicy.systemPromptHash,
      instructionHash: origPolicy.instructionHash,
      toolAllowlist: origPolicy.toolAllowlist,
      domainAllowlist: origPolicy.domainAllowlist,
      researchPolicy: origPolicy.researchPolicy,
      planningPolicy: origPolicy.planningPolicy,
      approvalPolicy: origPolicy.approvalPolicy,
      fallbackPolicy: origPolicy.fallbackPolicy,
      partialResultPolicy: origPolicy.partialResultPolicy,
      limits: origPolicy.limits,
      contentHash: origPolicy.contentHash,
      createdAt: now,
    });

    const retryBody = (body ?? {}) as RetryBody;
    // The retry request envelope has already been validated and encrypted
    // (or copied from the original) by validateRetryIngress in the
    // pre-transaction phase (VAL-RUN-133, VAL-RUN-134, VAL-RUN-135,
    // Normative Boundary 3). Use the pre-computed encrypted envelope,
    // safe summary, and request hash directly.
    const encryptedEnvelope = retryIngress.encryptedEnvelope;
    const reqHash = retryIngress.reqHash;

    // Narrow the original policy limits with the retry body's limits
    // (minimum wins — retry may only lower, never raise). Recompute the
    // policy content hash so the narrowed snapshot has a distinct identity
    // (HIGH-RISK REPAIR: retry narrows limits and recomputes policy hash).
    const origLimits = origPolicy.limits as Record<string, number>;
    const retryLimits = retryBody.limits ?? {};
    const narrowedLimits: Record<string, number> = { ...origLimits };
    for (const key of [
      'costCents',
      'totalTokens',
      'durationSeconds',
      'providerCalls',
      'steps',
      'outputBytes',
    ]) {
      const override = retryLimits[key as keyof typeof retryLimits];
      if (override !== undefined) {
        narrowedLimits[key] = Math.min(origLimits[key] ?? override, override);
      }
    }
    const narrowedPolicyContentHash = canonicalHash({
      schemaVersion: origPolicy.schemaVersion,
      sourceProfile: origPolicy.sourceProfile,
      provider: origPolicy.provider,
      adapterId: origPolicy.adapterId,
      model: origPolicy.model,
      reasoningDepth: origPolicy.reasoningDepth,
      systemPromptHash: origPolicy.systemPromptHash,
      instructionHash: origPolicy.instructionHash,
      toolAllowlist: origPolicy.toolAllowlist,
      domainAllowlist: origPolicy.domainAllowlist,
      researchPolicy: origPolicy.researchPolicy,
      planningPolicy: origPolicy.planningPolicy,
      approvalPolicy: origPolicy.approvalPolicy,
      fallbackPolicy: origPolicy.fallbackPolicy,
      partialResultPolicy: origPolicy.partialResultPolicy,
      limits: narrowedLimits,
      resolvedMode: run.resolvedMode,
    });

    // Re-insert the policy snapshot with the narrowed limits and recomputed
    // hash (replace the verbatim copy above).
    await tx
      .update(schema.runPolicySnapshots)
      .set({
        limits: narrowedLimits as unknown as Record<string, number>,
        contentHash: narrowedPolicyContentHash,
      })
      .where(eq(schema.runPolicySnapshots.id, successorPolicyId));

    const successorId = randomUUID();
    await tx.insert(schema.missionRuns).values({
      id: successorId,
      companyId: run.companyId,
      projectId: run.projectId,
      projectThreadId: run.projectThreadId,
      rootRunId: successorId,
      retryOfRunId: run.id,
      depth: 0,
      initiatingUserId: run.initiatingUserId,
      initiatingAgentId: run.initiatingAgentId,
      billingAgentId: run.billingAgentId,
      routingKind: 'company_agent',
      requestEnvelope: encryptedEnvelope,
      requestContentHash: reqHash,
      requestSafeSummary: retryIngress.safeSummary,
      resolvedMode: run.resolvedMode,
      policySnapshotId: successorPolicyId,
      status: 'draft',
      stateVersion: 1,
      lastEventSequence: 0,
      partialResultPolicy: run.partialResultPolicy,
      createdAt: now,
      updatedAt: now,
    });

    // Fresh finite root budget reservation + allocation with the narrowed
    // ceiling (HIGH-RISK REPAIR: reserve the authoritative narrowed budget).
    // The budget module checks headroom and throws 409 BUDGET_UNAVAILABLE
    // when insufficient (VAL-RUN-061, VAL-CROSS-061).
    const [origReservation] = await tx
      .select()
      .from(schema.budgetReservations)
      .where(eq(schema.budgetReservations.runId, run.id))
      .limit(1);
    const origCeiling = origReservation?.requestedCents ?? 0;
    const ceiling = Math.min(origCeiling, narrowedLimits['costCents'] ?? origCeiling);
    const periodKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const budgetService = new BudgetService(this.db, { clock: () => now });
    const budgetResult = await budgetService.reserveRoot(tx, {
      companyId: run.companyId,
      runId: successorId,
      billingAgentId: run.billingAgentId,
      requestedCents: ceiling,
      periodKey,
    });
    const reservedCents = budgetResult.reservedCents;

    // Build the successor response snapshot before recording the command.
    const snapshot = await this.buildSnapshot(tx, successorId);
    const stored: StoredResult = {
      statusCode: 202,
      etag: snapshot.stateVersion,
      run: snapshot,
      successorRunId: successorId,
    };

    // Record the run.retry command against the ORIGINAL (terminal) run.
    const commandRow = await this.insertCommand(tx, {
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      type: 'run.retry',
      idempotencyKey,
      requestHash: commandRequestHash('run.retry', body),
      payload: { ...(body as Record<string, unknown>) },
      actorType,
      actorId,
      expectedStateVersion: run.stateVersion,
      resultStatusCode: 202,
      stored,
      traceId,
    });

    // Ordered initial events on the successor run.
    const events = [
      {
        type: 'run.created',
        payload: { runId: successorId, status: 'draft', retryOfRunId: run.id },
      },
      { type: 'mode.resolved', payload: { resolvedMode: run.resolvedMode, retry: true } },
      {
        type: 'policy.snapshotted',
        payload: { policySnapshotId: successorPolicyId, contentHash: narrowedPolicyContentHash },
      },
      { type: 'budget.reserved', payload: { reservedCents, periodKey } },
    ];
    let seq = 0;
    for (const event of events) {
      seq += 1;
      await tx.insert(schema.runEvents).values({
        companyId: run.companyId,
        projectId: run.projectId,
        runId: successorId,
        sequence: seq,
        type: event.type,
        schemaVersion: 1,
        payload: event.payload,
        commandId: commandRow.id,
        actorType,
        actorId,
        traceId,
        occurredAt: now,
      });
    }
    await tx
      .update(schema.missionRuns)
      .set({ lastEventSequence: seq, updatedAt: now })
      .where(eq(schema.missionRuns.id, successorId));

    return {
      statusCode: 202,
      etag: snapshot.stateVersion,
      run: snapshot,
      commandRow,
      successorRunId: successorId,
    };
  }

  // -- helpers --------------------------------------------------------------

  private async lookupCommand(companyId: string, projectId: string, runId: string, key: string) {
    const schema = this.db.schema;
    const [row] = await this.db.drizzle
      .select()
      .from(schema.runCommands)
      .where(
        and(
          eq(schema.runCommands.companyId, companyId),
          eq(schema.runCommands.projectId, projectId),
          eq(schema.runCommands.runId, runId),
          eq(schema.runCommands.idempotencyKey, key),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** In-transaction idempotency recheck after locking (HIGH-RISK REPAIR). */
  private async lookupCommandInTx(
    tx: Tx,
    companyId: string,
    projectId: string,
    runId: string,
    key: string,
  ) {
    const schema = this.db.schema;
    const [row] = await tx
      .select()
      .from(schema.runCommands)
      .where(
        and(
          eq(schema.runCommands.companyId, companyId),
          eq(schema.runCommands.projectId, projectId),
          eq(schema.runCommands.runId, runId),
          eq(schema.runCommands.idempotencyKey, key),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  private async loadRun(
    companyId: string,
    projectId: string,
    runId: string,
  ): Promise<MissionRunRow> {
    const schema = this.db.schema;
    const [row] = await this.db.drizzle
      .select()
      .from(schema.missionRuns)
      .where(
        and(
          eq(schema.missionRuns.companyId, companyId),
          eq(schema.missionRuns.projectId, projectId),
          eq(schema.missionRuns.id, runId),
        ),
      )
      .limit(1);
    if (!row) {
      throw new AppError(404, 'RUN_NOT_FOUND', 'Mission run not found');
    }
    return row;
  }

  private async lockRun(
    tx: Tx,
    companyId: string,
    projectId: string,
    runId: string,
  ): Promise<MissionRunRow> {
    const schema = this.db.schema;
    const [row] = await tx
      .select()
      .from(schema.missionRuns)
      .where(
        and(
          eq(schema.missionRuns.companyId, companyId),
          eq(schema.missionRuns.projectId, projectId),
          eq(schema.missionRuns.id, runId),
        ),
      )
      .for('update')
      .limit(1);
    if (!row) {
      throw new AppError(404, 'RUN_NOT_FOUND', 'Mission run not found');
    }
    return row;
  }

  private async insertCommand(
    runner: Tx | DbInstance['drizzle'],
    input: {
      companyId: string;
      projectId: string;
      runId: string;
      type: RunCommandType;
      idempotencyKey: string;
      requestHash: string;
      payload: Record<string, unknown>;
      actorType: 'user' | 'agent' | 'system';
      actorId: string | null;
      expectedStateVersion: number;
      resultStatusCode: number;
      stored: StoredResult;
      now?: Date;
      traceId?: string | null;
    },
  ): Promise<MissionCommandRow> {
    const schema = this.db.schema;
    const now = input.now ?? this.now();
    const [row] = await runner
      .insert(schema.runCommands)
      .values({
        companyId: input.companyId,
        projectId: input.projectId,
        runId: input.runId,
        type: input.type,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        payload: input.payload,
        actorType: input.actorType,
        actorId: input.actorId,
        expectedStateVersion: input.expectedStateVersion,
        status: 'applied',
        resultStatusCode: input.resultStatusCode,
        resultBody: input.stored as unknown as Record<string, unknown>,
        traceId: input.traceId ?? null,
        createdAt: now,
        appliedAt: now,
      })
      .returning();
    return row;
  }

  /**
   * Build a lean command-response snapshot from the committed run row, its
   * budget reservation, and policy content hash. When called inside a
   * transaction, pass `tx` so uncommitted writes are visible.
   */
  private async buildSnapshot(
    runner: Tx | DbInstance['drizzle'],
    runId: string,
  ): Promise<CommandRunSnapshot> {
    const schema = this.db.schema;
    const [run] = await runner
      .select()
      .from(schema.missionRuns)
      .where(eq(schema.missionRuns.id, runId))
      .limit(1);
    const [reservation] = await runner
      .select()
      .from(schema.budgetReservations)
      .where(eq(schema.budgetReservations.runId, runId))
      .limit(1);
    let policyContentHash: string | null = null;
    if (run.policySnapshotId) {
      const [policy] = await runner
        .select({ contentHash: schema.runPolicySnapshots.contentHash })
        .from(schema.runPolicySnapshots)
        .where(eq(schema.runPolicySnapshots.id, run.policySnapshotId))
        .limit(1);
      policyContentHash = policy?.contentHash ?? null;
    }
    return {
      id: run.id,
      companyId: run.companyId,
      projectId: run.projectId,
      status: run.status,
      stateVersion: run.stateVersion,
      lastEventSequence: Number(run.lastEventSequence),
      resolvedMode: run.resolvedMode,
      policyContentHash,
      requestContentHash: run.requestContentHash,
      cancelRequestedAt: run.cancelRequestedAt ? run.cancelRequestedAt.toISOString() : null,
      cancelRequestedBy: run.cancelRequestedBy,
      cancellationDeadlineAt: run.cancellationDeadlineAt
        ? run.cancellationDeadlineAt.toISOString()
        : null,
      retryOfRunId: run.retryOfRunId,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      budget: {
        reservedCents: reservation?.reservedCents ?? 0,
        settledCents: reservation?.settledCents ?? 0,
        releasedCents: reservation?.releasedCents ?? 0,
        costCentsCeiling: reservation?.requestedCents ?? 0,
      },
    };
  }

  /**
   * Encrypt the `reason` field in a cancel command payload before storage
   * so the plaintext reason is not visible in the raw database column
   * (VAL-RUN-138). The request hash is computed from the plaintext body
   * (before encryption) so idempotent replay is consistent.
   */
  private encryptCancelPayload(body: unknown): Record<string, unknown> {
    const payload = { ...(body as Record<string, unknown>) };
    if (typeof payload.reason === 'string' && payload.reason.length > 0) {
      payload.reason = encryptReason(payload.reason);
    }
    return payload;
  }

  /** Record a domain-rejected command as a `status='rejected'` row so it
   *  remains visible in history without changing state/events/budget/output
   *  (VAL-RUN-075). A unique-violation (concurrent identical key) is silently
   *  ignored — the concurrent command is authoritative. */
  private async recordRejected(
    run: MissionRunRow,
    type: RunCommandType,
    body: unknown,
    idempotencyKey: string,
    statusCode: number,
    errorCode: string,
    errorMessage: string,
    actorType: 'user' | 'agent' | 'system',
    actorId: string | null,
    ifMatch: number | null,
  ): Promise<void> {
    // Increment the rejected command counter (VAL-RUN-078).
    incrementMissionCommand(type, 'rejected');
    const schema = this.db.schema;
    const now = this.now();
    const payload =
      type === 'run.cancel'
        ? this.encryptCancelPayload(body)
        : { ...(body as Record<string, unknown>) };
    try {
      await this.db.drizzle.insert(schema.runCommands).values({
        companyId: run.companyId,
        projectId: run.projectId,
        runId: run.id,
        type,
        idempotencyKey,
        requestHash: commandRequestHash(type, body),
        payload,
        actorType,
        actorId,
        expectedStateVersion: ifMatch,
        status: 'rejected',
        resultStatusCode: statusCode,
        resultBody: { statusCode, code: errorCode, message: errorMessage } as Record<
          string,
          unknown
        >,
        errorCode,
        createdAt: now,
      });
    } catch (err) {
      // A concurrent command with the same key won; the concurrent command
      // is the authoritative one and will be replayed on the next call.
      if (this.isUniqueViolation(err)) {
        return;
      }
      throw err;
    }
  }

  private commandSummary(row: MissionCommandRow): CommandSummary {
    return {
      id: row.id,
      type: row.type,
      idempotencyKey: row.idempotencyKey,
      status: row.status,
      resultStatusCode: row.resultStatusCode ?? 0,
      createdAt: row.createdAt.toISOString(),
      appliedAt: row.appliedAt ? row.appliedAt.toISOString() : row.createdAt.toISOString(),
      traceId: row.traceId ?? null,
    };
  }

  private toResult(outcome: ApplyOutcome): CommandResult {
    return {
      statusCode: outcome.statusCode,
      etag: outcome.etag,
      run: outcome.run,
      command: this.commandSummary(outcome.commandRow),
      successorRunId: outcome.successorRunId,
    };
  }

  private async replayOrConflict(
    existing: MissionCommandRow,
    type: RunCommandType,
    body: unknown,
  ): Promise<CommandResult> {
    const hash = commandRequestHash(type, body);
    if (existing.requestHash !== hash) {
      throw new AppError(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency key already used for different content',
      );
    }
    // If the command was rejected, re-throw the stored rejection so a
    // replay returns the same domain error (VAL-RUN-075).
    if (existing.status === 'rejected') {
      const stored = existing.resultBody as {
        statusCode: number;
        code: string;
        message: string;
      } | null;
      if (stored?.statusCode && stored?.code) {
        throw new AppError(stored.statusCode, stored.code, stored.message ?? 'Command rejected');
      }
      throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key already used');
    }
    // Applied command: return the stored result.
    const stored = existing.resultBody as unknown as StoredResult | null;
    if (!stored || !stored.run) {
      throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key already used');
    }
    // Increment idempotent replay counter (not counted as a new command).
    incrementMissionIdempotentReplay();
    incrementMissionCommand(type, 'replayed');
    return {
      statusCode: stored.statusCode,
      etag: stored.etag,
      run: stored.run,
      command: this.commandSummary(existing),
      successorRunId: stored.successorRunId,
    };
  }

  private isUniqueViolation(err: unknown): boolean {
    const code = (err as { code?: string })?.code;
    return code === '23505';
  }
}
