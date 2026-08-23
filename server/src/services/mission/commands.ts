import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../middleware/error-handler.js';
import type { DbInstance } from '../../types.js';
import { commandRequestHash, validateIdempotencyKey } from './idempotency.js';
import {
  canonicalHash,
  resolvePolicy,
  resolveCustomPolicy,
  policyContentHash,
  type ResolvedPolicy,
  type CustomProfileConfig,
  type CompanyPolicyInput,
  type UserReductions,
} from './policy.js';
import { type BuiltInMode, type ModeLimits } from './modes.js';
import { classifyRequest, type ClassificationResult } from './mode-classifier.js';
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

export type RunCommandType = 'run.cancel' | 'run.retry' | 'questions.answer';

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
  /**
   * Optional mode/profile override for retry (VAL-MODEQ-117). When the
   * original custom profile is disabled or absent, the user may explicitly
   * select an eligible replacement. If omitted, the retry uses the original
   * run's mode/profile. Never silently substitutes Auto.
   */
  modeOverride?: {
    mode: 'fast' | 'deep_work' | 'analyst' | 'auto' | 'custom';
    modeProfileId?: string;
  };
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

/**
 * Pre-computed policy resolution result for the retry branch. The policy is
 * re-resolved from current governance (agent, company, profile) rather than
 * copied from the original snapshot, so the successor gets a fresh snapshot
 * reflecting current settings (VAL-MODEQ-117). If the original custom
 * profile is disabled or absent and no modeOverride is provided, the
 * resolution fails closed.
 */
interface RetryPolicyResult {
  policy: ResolvedPolicy;
  autoClassification: ClassificationResult | null;
  /** The mode to store on the successor run's resolvedMode column. */
  resolvedMode: string;
  /** The modeProfileId to store on the successor run (null for built-ins). */
  modeProfileId: string | null;
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
    const { companyId, projectId, runId, type, body, ifMatch, actorType, actorId } = input;
    const traceId = input.traceId ?? null;

    // Defense-in-depth: validate the idempotency key at the service boundary
    // before any database query or state change (VAL-RUN-114). The route
    // also validates, but Node's HTTP parser strips leading/trailing OWS
    // from header values per RFC 7230 before Express sees them, so this
    // service-level check is the authoritative seam for callers that reach
    // the service directly (internal calls, tests, non-OWS Unicode
    // whitespace that survives HTTP parsing).
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);

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
    let retryPolicy: RetryPolicyResult | undefined;
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
      // Re-resolve the policy from current governance so the successor
      // gets a fresh snapshot (VAL-MODEQ-117). If the original custom
      // profile is disabled or absent and no modeOverride is provided,
      // this fails closed.
      retryPolicy = await this.resolveRetryPolicy(run, body, retryIngress);
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
        // run.retry — retryIngress and retryPolicy are guaranteed to be set
        // here because they were computed in the pre-transaction retry block
        // above.
        if (!retryIngress) {
          throw new Error('retryIngress not computed for run.retry');
        }
        if (!retryPolicy) {
          throw new Error('retryPolicy not computed for run.retry');
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
          retryPolicy,
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

  /**
   * Re-resolve the effective policy for a retry from current governance
   * (VAL-MODEQ-117). The successor gets a fresh snapshot reflecting current
   * agent, company, and profile settings — not a verbatim copy of the
   * original.
   *
   * Mode selection for retry:
   * 1. If the retry body provides a `modeOverride`, use that mode/profile.
   * 2. If the original run used a custom profile, try to re-resolve it
   *    from the current DB. If the profile is disabled or absent, fail
   *    closed with `PROFILE_UNAVAILABLE` — never silently substitute Auto.
   * 3. If the original run used Auto, re-classify from the request text
   *    (using the new request if provided, otherwise the original).
   * 4. If the original run used a built-in mode, re-resolve from current
   *    governance.
   *
   * After resolution, retry body limits are applied as user reductions
   * (minimum wins — retry may only lower, never raise).
   */
  private async resolveRetryPolicy(
    run: MissionRunRow,
    body: unknown,
    retryIngress: RetryIngressResult,
  ): Promise<RetryPolicyResult> {
    const retryBody = (body ?? {}) as RetryBody;
    const schema = this.db.schema;

    // Read the original policy snapshot to determine what mode/profile was
    // originally used.
    const [origPolicy] = await this.db.drizzle
      .select()
      .from(schema.runPolicySnapshots)
      .where(eq(schema.runPolicySnapshots.id, run.policySnapshotId ?? ''))
      .limit(1);
    if (!origPolicy) {
      throw new AppError(500, 'INTERNAL_SERVER_ERROR', 'Original policy snapshot missing');
    }

    // Read the initiating agent from current DB (may have changed since
    // the original run started — VAL-MODEQ-040, VAL-RUN-103).
    let agent:
      | {
          provider: string;
          adapterId: string | null;
          model: string;
          toolAllowlist: string[];
          domainAllowlist: string[];
          status: string;
          capabilities: string[];
        }
      | undefined;
    if (run.initiatingAgentId) {
      const [agentRow] = await this.db.drizzle
        .select({
          id: schema.agents.id,
          provider: schema.agents.provider,
          adapterId: schema.agents.adapterId,
          model: schema.agents.model,
          toolsEnabled: schema.agents.toolsEnabled,
          allowedDomains: schema.agents.allowedDomains,
          status: schema.agents.status,
          capabilities: schema.agents.capabilities,
        })
        .from(schema.agents)
        .where(
          and(
            eq(schema.agents.id, run.initiatingAgentId),
            eq(schema.agents.companyId, run.companyId),
          ),
        )
        .limit(1);
      if (agentRow) {
        agent = {
          provider: agentRow.provider,
          adapterId: agentRow.adapterId,
          model: agentRow.model,
          toolAllowlist: agentRow.toolsEnabled ?? [],
          domainAllowlist: agentRow.allowedDomains ?? [],
          status: agentRow.status,
          capabilities: agentRow.capabilities ?? [],
        };
      }
    }

    // Read company governance from current DB (may have changed).
    const companyPolicy = await this.lookupCompanyPolicy(run.companyId);

    // Build user reductions from the retry body limits.
    const userReductions: UserReductions = { ...retryBody.limits };

    // Determine the effective mode for the retry.
    const modeOverride = retryBody.modeOverride;
    const originalSourceProfile = origPolicy.sourceProfile;
    const originalWasCustom = run.modeProfileId !== null;

    if (modeOverride) {
      // User explicitly selected a replacement mode (VAL-MODEQ-117).
      if (modeOverride.mode === 'custom') {
        if (!modeOverride.modeProfileId) {
          throw new AppError(
            400,
            'VALIDATION_ERROR',
            'modeProfileId is required when modeOverride.mode is "custom"',
          );
        }
        const { ModeRegistryService } = await import('./mode-registry.js');
        const registry = new ModeRegistryService(this.db);
        const profile = await registry.resolveProfileForStart(
          run.companyId,
          modeOverride.modeProfileId,
        );
        const policy = resolveCustomPolicy({
          profileSlug: profile.slug,
          profileVersion: profile.version,
          profileId: profile.id,
          profileName: profile.name,
          profileDescription: profile.description,
          config: profile.config as CustomProfileConfig,
          agent: agent
            ? {
                provider: agent.provider,
                adapterId: agent.adapterId ?? undefined,
                model: agent.model,
                toolAllowlist: agent.toolAllowlist,
                domainAllowlist: agent.domainAllowlist,
                status: agent.status,
                capabilities: agent.capabilities,
              }
            : undefined,
          company: companyPolicy,
          userReductions,
        });
        return {
          policy,
          autoClassification: null,
          resolvedMode: policy.resolvedMode,
          modeProfileId: profile.id,
        };
      }

      // Built-in or Auto mode override.
      return this.resolveBuiltInRetry(
        modeOverride.mode as BuiltInMode,
        agent,
        companyPolicy,
        userReductions,
        retryIngress,
        originalSourceProfile,
      );
    }

    // No mode override: use the original run's mode/profile.
    if (originalWasCustom && run.modeProfileId) {
      // Original was custom: try to re-resolve from current DB. If the
      // profile is disabled or absent, fail closed (VAL-MODEQ-117,
      // VAL-MODEQ-129).
      const { ModeRegistryService } = await import('./mode-registry.js');
      const registry = new ModeRegistryService(this.db);
      const profile = await registry.getProfile({
        companyId: run.companyId,
        profileId: run.modeProfileId,
      });
      if (!profile || !profile.enabled) {
        throw new AppError(
          409,
          'PROFILE_UNAVAILABLE',
          'The original custom mode profile is no longer available. Please select an eligible replacement mode and retry.',
        );
      }
      // Re-resolve with the current profile row (name/description may have
      // changed, but the slug/version are current).
      const policy = resolveCustomPolicy({
        profileSlug: profile.slug,
        profileVersion: profile.version,
        profileId: profile.id,
        profileName: profile.name,
        profileDescription: profile.description,
        config: profile.config as CustomProfileConfig,
        agent: agent
          ? {
              provider: agent.provider,
              adapterId: agent.adapterId ?? undefined,
              model: agent.model,
              toolAllowlist: agent.toolAllowlist,
              domainAllowlist: agent.domainAllowlist,
              status: agent.status,
              capabilities: agent.capabilities,
            }
          : undefined,
        company: companyPolicy,
        userReductions,
      });
      return {
        policy,
        autoClassification: null,
        resolvedMode: policy.resolvedMode,
        modeProfileId: profile.id,
      };
    }

    // Original was a built-in or Auto mode.
    // If the original sourceProfile was 'auto', re-classify.
    if (originalSourceProfile === 'auto') {
      return this.resolveBuiltInRetry(
        'auto',
        agent,
        companyPolicy,
        userReductions,
        retryIngress,
        originalSourceProfile,
      );
    }

    // Original was a concrete built-in mode (fast, deep_work, analyst).
    const originalMode = originalSourceProfile as BuiltInMode;
    return this.resolveBuiltInRetry(
      originalMode,
      agent,
      companyPolicy,
      userReductions,
      retryIngress,
      originalSourceProfile,
    );
  }

  /**
   * Resolve a built-in or Auto mode for retry, including Auto
   * re-classification from the request text (VAL-MODEQ-117).
   */
  private resolveBuiltInRetry(
    mode: BuiltInMode,
    agent:
      | {
          provider: string;
          adapterId: string | null;
          model: string;
          toolAllowlist: string[];
          domainAllowlist: string[];
          status: string;
          capabilities: string[];
        }
      | undefined,
    companyPolicy: CompanyPolicyInput | undefined,
    userReductions: UserReductions,
    retryIngress: RetryIngressResult,
    originalSourceProfile: string | null,
  ): RetryPolicyResult {
    let effectiveMode: BuiltInMode = mode;
    let autoClassification: ClassificationResult | null = null;

    if (mode === 'auto') {
      // Re-classify from the request text. Use the decrypted original
      // request if no new request was provided, otherwise the retry
      // request text. The retryIngress has the encrypted envelope; we
      // decrypt it for classification.
      const envelope = decryptEnvelope(retryIngress.encryptedEnvelope);
      const text = (envelope.text as string) ?? '';
      const context = (envelope.context as Record<string, unknown>) ?? undefined;
      autoClassification = classifyRequest({ text, context });
      effectiveMode = autoClassification.resolvedMode;
    }

    const policy = resolvePolicy({
      mode: effectiveMode,
      agent: agent
        ? {
            provider: agent.provider,
            adapterId: agent.adapterId ?? undefined,
            model: agent.model,
            toolAllowlist: agent.toolAllowlist,
            domainAllowlist: agent.domainAllowlist,
            status: agent.status,
            capabilities: agent.capabilities,
          }
        : undefined,
      company: companyPolicy,
      userReductions,
    });

    // For Auto, the source profile is 'auto' (the selected mode), not the
    // classified concrete mode (VAL-MODEQ-015).
    if (mode === 'auto') {
      policy.sourceProfile = 'auto';
    }

    return {
      policy,
      autoClassification,
      resolvedMode: policy.resolvedMode,
      modeProfileId: null,
    };
  }

  /**
   * Read company governance (mission policy) from company settings.
   * Returns undefined if no mission policy is configured.
   */
  private async lookupCompanyPolicy(companyId: string): Promise<CompanyPolicyInput | undefined> {
    const schema = this.db.schema;
    const [company] = await this.db.drizzle
      .select({ settings: schema.companies.settings })
      .from(schema.companies)
      .where(eq(schema.companies.id, companyId))
      .limit(1);
    if (!company) {
      return undefined;
    }
    const settings = company.settings as Record<string, unknown>;
    const missionPolicy = settings.missionPolicy as Record<string, unknown> | undefined;
    if (!missionPolicy) {
      return undefined;
    }
    return {
      allowedProviders: (missionPolicy.allowedProviders as string[] | undefined)?.filter(
        (p): p is string => typeof p === 'string',
      ),
      allowedTools: (missionPolicy.allowedTools as string[] | undefined)?.filter(
        (t): t is string => typeof t === 'string',
      ),
      allowedDomains: (missionPolicy.allowedDomains as string[] | undefined)?.filter(
        (d): d is string => typeof d === 'string',
      ),
      deniedTools: (missionPolicy.deniedTools as string[] | undefined)?.filter(
        (t): t is string => typeof t === 'string',
      ),
      deniedDomains: (missionPolicy.deniedDomains as string[] | undefined)?.filter(
        (d): d is string => typeof d === 'string',
      ),
      limits: missionPolicy.limits as Partial<ModeLimits> | undefined,
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
    retryPolicy: RetryPolicyResult,
  ): Promise<ApplyOutcome> {
    const schema = this.db.schema;
    const now = this.now();
    const { policy, autoClassification, resolvedMode, modeProfileId } = retryPolicy;

    // The retry request envelope has already been validated and encrypted
    // (or copied from the original) by validateRetryIngress in the
    // pre-transaction phase (VAL-RUN-133, VAL-RUN-134, VAL-RUN-135,
    // Normative Boundary 3). The policy has been re-resolved from current
    // governance by resolveRetryPolicy (VAL-MODEQ-117).
    const encryptedEnvelope = retryIngress.encryptedEnvelope;
    const reqHash = retryIngress.reqHash;

    // Compute the fresh policy content hash from the re-resolved policy.
    // This covers the entire effective policy, not display text
    // (VAL-MODEQ-127).
    const policyHash = policyContentHash(policy);

    // Store the fresh immutable policy snapshot (VAL-MODEQ-117, VAL-MODEQ-129).
    const successorPolicyId = randomUUID();
    await tx.insert(schema.runPolicySnapshots).values({
      id: successorPolicyId,
      companyId: run.companyId,
      schemaVersion: policy.schemaVersion,
      sourceProfile: policy.sourceProfile,
      sourceProfileName: policy.sourceProfileName ?? null,
      sourceProfileDescription: policy.sourceProfileDescription ?? null,
      sourceProfileVersion: policy.sourceProfileVersion ?? null,
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
    });

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
      modeProfileId,
      resolvedMode: resolvedMode as 'fast' | 'deep_work' | 'analyst' | 'auto' | 'custom',
      policySnapshotId: successorPolicyId,
      status: 'draft',
      stateVersion: 1,
      lastEventSequence: 0,
      partialResultPolicy: policy.partialResultPolicy,
      createdAt: now,
      updatedAt: now,
    });

    // Fresh finite root budget reservation + allocation with the resolved
    // ceiling. The budget module checks headroom and throws 409
    // BUDGET_UNAVAILABLE when insufficient (VAL-RUN-061, VAL-CROSS-061).
    const ceiling = policy.limits.costCents;
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
      {
        type: 'mode.resolved',
        payload: {
          resolvedMode,
          retry: true,
          ...(modeProfileId
            ? { profileSlug: policy.sourceProfile, profileVersion: policy.sourceProfileVersion }
            : {}),
          ...(autoClassification
            ? {
                classifierVersion: autoClassification.classifierVersion,
                reasons: autoClassification.reasons,
              }
            : {}),
        },
      },
      {
        type: 'policy.snapshotted',
        payload: { policySnapshotId: successorPolicyId, contentHash: policyHash },
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
