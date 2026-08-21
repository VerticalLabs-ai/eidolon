import { and, eq } from 'drizzle-orm';
import { AppError } from '../../middleware/error-handler.js';
import type { DbInstance } from '../../types.js';

/**
 * Bounded same-run retries for transient execution failures.
 *
 * When the orchestration worker observes a failure during an active attempt
 * it calls {@link MissionRetryService.handleExecutionFailure}. The service
 * classifies the failure, decides whether to requeue the SAME nonterminal run
 * (bounded full-jitter exponential backoff, finite attempt and time bounds)
 * or to terminalize it, and applies that decision in one locked transaction
 * that appends a sanitized journal event and bumps the run version/sequence.
 *
 * Retryable categories are transient provider 408/429/5xx, network errors,
 * lease-safe database serialization/deadlock, and explicitly idempotent
 * projection failure. Authentication/configuration, policy denial, invalid
 * response schema, budget/limit exhaustion, prompt/tool validation, tool
 * denial, and uncertain non-replayable effects are permanent and never
 * trigger an automatic external-call retry (architecture: Retry and
 * failures).
 *
 * A retry never creates a user-visible successor run and never duplicates
 * replay-unsafe effects: it keeps the same run id, root, and immutable
 * policy snapshot, releases the worker lease so a stale worker cannot
 * commit, and carries the stable `logicalCallId` in the retry event so the
 * replay-class effect ledger (later feature) deduplicates external effects.
 */

/** Stable failure categories from the architecture. */
export type FailureCategory =
  | 'validation'
  | 'authorization'
  | 'policy'
  | 'budget'
  | 'limit'
  | 'provider_transient'
  | 'provider_permanent'
  | 'tool_denied'
  | 'tool_failed'
  | 'unknown_effect'
  | 'child_failed'
  | 'projection'
  | 'internal';

/** The kind of raw execution failure the worker observed. */
export type ExecutionFailureKind =
  | 'provider'
  | 'network'
  | 'database'
  | 'projection'
  | 'tool'
  | 'policy'
  | 'budget'
  | 'limit'
  | 'validation'
  | 'authorization'
  | 'unknown_effect';

export interface ExecutionFailureInput {
  kind: ExecutionFailureKind;
  /** Provider HTTP status code when `kind` is `'provider'`. */
  httpStatus?: number;
  /** Stable, safe, secret-free failure code (stored in the journal). */
  code: string;
  /** Safe user-visible message (never raw secrets/content). */
  safeMessage: string;
  /** For `kind: 'tool'`, `true` marks a policy denial (`tool_denied`). */
  denied?: boolean;
}

export interface FailureClassification {
  category: FailureCategory;
  code: string;
  safeMessage: string;
  retryable: boolean;
}

/** Categories that may be retried in place on the same nonterminal run. */
const RETRYABLE_CATEGORIES = new Set<FailureCategory>([
  'provider_transient',
  'internal',
  'projection',
]);

/** Provider HTTP statuses that are transient and may be retried. */
const TRANSIENT_HTTP = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Classify a raw execution failure into a stable category and a retryable
 * flag. The classifier is a pure function so it can be unit-tested and
 * reused by the worker, research, and tool dispatcher.
 */
export function classifyFailure(input: ExecutionFailureInput): FailureClassification {
  let category: FailureCategory;
  switch (input.kind) {
    case 'provider': {
      // A known transient HTTP status, or an unknown/no-status provider error
      // (treated as network-level transient), is retryable. Any other 4xx
      // is a permanent provider rejection.
      if (input.httpStatus === undefined || TRANSIENT_HTTP.has(input.httpStatus)) {
        category = 'provider_transient';
      } else {
        category = 'provider_permanent';
      }
      break;
    }
    case 'network':
      category = 'provider_transient';
      break;
    case 'database':
      // Lease-safe serialization/deadlock is retryable in place.
      category = 'internal';
      break;
    case 'projection':
      // Explicitly idempotent projection failure is retryable.
      category = 'projection';
      break;
    case 'tool':
      category = input.denied ? 'tool_denied' : 'tool_failed';
      break;
    case 'policy':
      category = 'policy';
      break;
    case 'budget':
      category = 'budget';
      break;
    case 'limit':
      category = 'limit';
      break;
    case 'validation':
      category = 'validation';
      break;
    case 'authorization':
      category = 'authorization';
      break;
    case 'unknown_effect':
      category = 'unknown_effect';
      break;
    default:
      category = 'internal';
      break;
  }
  return {
    category,
    code: input.code,
    safeMessage: input.safeMessage,
    retryable: RETRYABLE_CATEGORIES.has(category),
  };
}

/**
 * Full-jitter exponential backoff. Base delays are 1s, 2s, 4s, ...
 * (`2^(attemptsCompleted - 1) * 1000ms`) and the actual delay is a uniform
 * random value in `[0, min(base, cap)]` where `cap` is the minimum of the
 * configured maximum backoff and the remaining run duration. Returns 0 when
 * no time remains (architecture: bounded by remaining duration).
 */
export function computeBackoff(input: {
  attemptsCompleted: number;
  /** Remaining run duration in ms. `Infinity` means no time bound. */
  remainingMs: number;
  maxBackoffMs?: number;
  random?: () => number;
}): number {
  const maxBackoff = input.maxBackoffMs ?? 5000;
  // The cap is the minimum of the absolute backoff cap and the remaining
  // duration. An infinite remaining duration (no deadline) keeps only the
  // configured cap (architecture: bounded by remaining duration).
  const cap = Number.isFinite(input.remainingMs)
    ? Math.min(maxBackoff, input.remainingMs)
    : maxBackoff;
  if (cap <= 0) {
    return 0;
  }
  const base = Math.pow(2, Math.max(input.attemptsCompleted - 1, 0)) * 1000;
  const temp = Math.min(base, cap);
  const r = (input.random ?? Math.random)();
  const delay = Math.floor(r * temp);
  return Math.min(Math.max(delay, 0), cap);
}

export interface RetryDecisionInput {
  classification: FailureClassification;
  /** Attempts completed so far, including the one that just failed. */
  attemptsCompleted: number;
  /** Maximum attempts allowed (default 3 per architecture). */
  maxAttempts: number;
  /** Optional run deadline in epoch ms. */
  deadlineMs?: number;
  /** Current time in epoch ms. */
  nowMs: number;
  maxBackoffMs?: number;
  /**
   * Minimum remaining duration required to schedule a retry. If the
   * remaining runway is below this floor the run is terminalized rather
   * than requeued with a degenerate truncated backoff. Defaults to 1000ms
   * (the smallest exponential base).
   */
  minRemainingMs?: number;
  random?: () => number;
}

export type RetryDecision =
  | { kind: 'requeue'; backoffMs: number; nextAttempt: number }
  | { kind: 'fail'; reason: 'permanent' | 'attempts_exhausted' | 'time_exhausted' };

/**
 * Decide whether a failure requeues the same run or terminalizes it. Pure so
 * it can be unit-tested independently of persistence.
 */
export function decideRetry(input: RetryDecisionInput): RetryDecision {
  const { classification, attemptsCompleted, maxAttempts, deadlineMs, nowMs } = input;

  // Permanent failures never auto-retry (VAL-RUN-108).
  if (!classification.retryable) {
    return { kind: 'fail', reason: 'permanent' };
  }

  // Bounded attempts: exhausted after the configured count (VAL-RUN-107).
  if (attemptsCompleted >= maxAttempts) {
    return { kind: 'fail', reason: 'attempts_exhausted' };
  }

  // Bounded time: if the deadline passed or the remaining duration cannot
  // fit a backoff, terminalize rather than retry indefinitely (VAL-RUN-107).
  const remainingMs = deadlineMs === undefined ? Number.POSITIVE_INFINITY : deadlineMs - nowMs;
  if (remainingMs <= 0) {
    return { kind: 'fail', reason: 'time_exhausted' };
  }
  const minRemainingMs = input.minRemainingMs ?? 1000;
  if (Number.isFinite(remainingMs) && remainingMs < minRemainingMs) {
    // The remaining duration cannot fit a meaningful backoff (architecture:
    // bounded by remaining duration). Terminalize instead of scheduling a
    // degenerate sub-floor retry.
    return { kind: 'fail', reason: 'time_exhausted' };
  }
  const backoff = computeBackoff({
    attemptsCompleted,
    remainingMs,
    maxBackoffMs: input.maxBackoffMs,
    random: input.random,
  });
  if (backoff <= 0) {
    return { kind: 'fail', reason: 'time_exhausted' };
  }

  return { kind: 'requeue', backoffMs: backoff, nextAttempt: attemptsCompleted + 1 };
}

/** Active execution states that may report an attempt failure. */
const EXECUTION_STATES = new Set(['running', 'synthesizing']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export interface HandleFailureInput {
  companyId: string;
  projectId: string;
  runId: string;
  failure: ExecutionFailureInput;
  /** Maximum attempts allowed. Defaults to 3 (architecture). */
  maxAttempts?: number;
  /** Optional run deadline in epoch ms. */
  deadlineMs?: number;
  /** Stable logical operation id carried in retry events for effect dedup. */
  logicalCallId?: string;
  traceId?: string | null;
  actorType?: 'user' | 'agent' | 'system';
  actorId?: string | null;
  /**
   * Lease token for fenced worker mutations. When provided, verifies the
   * token matches the run's current lease (VAL-RUN-119, VAL-RUN-120).
   */
  leaseToken?: string;
}

export type RetryOutcomeKind = 'requeue' | 'fail' | 'superseded' | 'terminal_noop';

export interface RetryOutcome {
  kind: RetryOutcomeKind;
  runId: string;
  status: string;
  stateVersion: number;
  lastEventSequence: number;
  attemptCount: number;
  availableAt: string | null;
  failureCategory: string | null;
  failureCode: string | null;
  backoffMs?: number;
  reason?: 'permanent' | 'attempts_exhausted' | 'time_exhausted';
}

export interface MissionRetryDeps {
  clock?: () => Date;
  random?: () => number;
}

type MissionRunRow = DbInstance['schema']['missionRuns']['$inferSelect'];
type Tx = Parameters<Parameters<DbInstance['drizzle']['transaction']>[0]>[0];

export class MissionRetryService {
  constructor(
    private db: DbInstance,
    private deps: MissionRetryDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  /**
   * Handle an execution failure observed during an active attempt. Loads and
   * locks the run (company + project + run scope), classifies the failure,
   * decides requeue vs fail, and applies the decision in one transaction
   * that clears the worker lease, appends a sanitized journal event, and
   * bumps the run version/sequence. A terminal or cancellation-pending run
   * is left untouched (cancellation owns terminalization).
   */
  async handleExecutionFailure(input: HandleFailureInput): Promise<RetryOutcome> {
    const { companyId, projectId, runId, failure } = input;
    const maxAttempts = input.maxAttempts ?? 3;
    const logicalCallId = input.logicalCallId ?? null;
    const traceId = input.traceId ?? null;
    const actorType = input.actorType ?? 'system';
    const actorId = input.actorId ?? null;

    return this.db.drizzle.transaction(async (tx) => {
      const run = await this.lockRun(tx, companyId, projectId, runId);

      // Fenced mutation: verify lease token when provided (worker path).
      // A stale worker whose lease was stolen cannot requeue or fail the
      // run (VAL-RUN-119, VAL-RUN-120).
      if (input.leaseToken !== undefined && run.leaseToken !== input.leaseToken) {
        throw new AppError(409, 'LEASE_NOT_HELD', 'Lease is no longer held by this worker');
      }

      // Terminal runs are immutable: a late failure report changes nothing.
      if (TERMINAL_STATUSES.has(run.status)) {
        return this.toOutcome('terminal_noop', run);
      }
      // A pending cancellation owns terminalization; retry must not race it.
      if (run.cancelRequestedAt !== null) {
        return this.toOutcome('superseded', run);
      }
      // Failures only come from an active attempt. A run that is not currently
      // executing (e.g. queued, waiting) has no attempt to retry.
      if (!EXECUTION_STATES.has(run.status)) {
        return this.toOutcome('superseded', run);
      }

      const classification = classifyFailure(failure);
      const nowMs = this.now().getTime();
      const attemptsCompleted = run.attemptCount + 1;
      const decision = decideRetry({
        classification,
        attemptsCompleted,
        maxAttempts,
        deadlineMs: input.deadlineMs,
        nowMs,
        random: this.deps.random,
      });

      if (decision.kind === 'requeue') {
        return this.applyRequeue(tx, run, {
          attemptsCompleted,
          backoffMs: decision.backoffMs,
          classification,
          logicalCallId,
          traceId,
          actorType,
          actorId,
        });
      }
      return this.applyFail(tx, run, {
        attemptsCompleted,
        classification,
        logicalCallId,
        traceId,
        actorType,
        actorId,
        reason: decision.reason,
      });
    });
  }

  // -- apply ----------------------------------------------------------------

  private async applyRequeue(
    tx: Tx,
    run: MissionRunRow,
    ctx: {
      attemptsCompleted: number;
      backoffMs: number;
      classification: FailureClassification;
      logicalCallId: string | null;
      traceId: string | null;
      actorType: 'user' | 'agent' | 'system';
      actorId: string | null;
    },
  ): Promise<RetryOutcome> {
    const schema = this.db.schema;
    const now = this.now();
    const newVersion = run.stateVersion + 1;
    const seq = Number(run.lastEventSequence) + 1;
    const availableAt = new Date(now.getTime() + ctx.backoffMs);

    await tx
      .update(schema.missionRuns)
      .set({
        status: 'queued',
        availableAt,
        attemptCount: ctx.attemptsCompleted,
        // Release the lease so a stale worker cannot commit after requeue.
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        // Nonterminal: terminal_at must be NULL (CHECK constraint).
        terminalAt: null,
        stateVersion: newVersion,
        lastEventSequence: seq,
        updatedAt: now,
      })
      .where(eq(schema.missionRuns.id, run.id));

    await tx.insert(schema.runEvents).values({
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      sequence: seq,
      type: 'execution.progress',
      schemaVersion: 1,
      payload: {
        retry: true,
        attempt: ctx.attemptsCompleted,
        backoffMs: ctx.backoffMs,
        category: ctx.classification.category,
        code: ctx.classification.code,
        logicalCallId: ctx.logicalCallId,
      },
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      traceId: ctx.traceId,
      occurredAt: now,
    });

    return {
      kind: 'requeue',
      runId: run.id,
      status: 'queued',
      stateVersion: newVersion,
      lastEventSequence: seq,
      attemptCount: ctx.attemptsCompleted,
      availableAt: availableAt.toISOString(),
      failureCategory: null,
      failureCode: null,
      backoffMs: ctx.backoffMs,
    };
  }

  private async applyFail(
    tx: Tx,
    run: MissionRunRow,
    ctx: {
      attemptsCompleted: number;
      classification: FailureClassification;
      logicalCallId: string | null;
      traceId: string | null;
      actorType: 'user' | 'agent' | 'system';
      actorId: string | null;
      reason: 'permanent' | 'attempts_exhausted' | 'time_exhausted';
    },
  ): Promise<RetryOutcome> {
    const schema = this.db.schema;
    const now = this.now();
    const newVersion = run.stateVersion + 1;
    const seq = run.lastEventSequence + 1;

    await tx
      .update(schema.missionRuns)
      .set({
        status: 'failed',
        terminalAt: now,
        attemptCount: ctx.attemptsCompleted,
        failureCategory: ctx.classification.category,
        failureCode: ctx.classification.code,
        safeErrorMessage: ctx.classification.safeMessage,
        // Release the lease on terminalization.
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        availableAt: null,
        stateVersion: newVersion,
        lastEventSequence: seq,
        updatedAt: now,
      })
      .where(eq(schema.missionRuns.id, run.id));

    await tx.insert(schema.runEvents).values({
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      sequence: seq,
      type: 'run.failed',
      schemaVersion: 1,
      payload: {
        category: ctx.classification.category,
        code: ctx.classification.code,
        safeMessage: ctx.classification.safeMessage,
        attempts: ctx.attemptsCompleted,
        reason: ctx.reason,
        logicalCallId: ctx.logicalCallId,
      },
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      traceId: ctx.traceId,
      occurredAt: now,
    });

    return {
      kind: 'fail',
      runId: run.id,
      status: 'failed',
      stateVersion: newVersion,
      lastEventSequence: seq,
      attemptCount: ctx.attemptsCompleted,
      availableAt: null,
      failureCategory: ctx.classification.category,
      failureCode: ctx.classification.code,
      reason: ctx.reason,
    };
  }

  // -- helpers --------------------------------------------------------------

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

  private toOutcome(kind: RetryOutcomeKind, run: MissionRunRow): RetryOutcome {
    return {
      kind,
      runId: run.id,
      status: run.status,
      stateVersion: run.stateVersion,
      lastEventSequence: Number(run.lastEventSequence),
      attemptCount: run.attemptCount,
      availableAt: run.availableAt ? run.availableAt.toISOString() : null,
      failureCategory: run.failureCategory,
      failureCode: run.failureCode,
    };
  }
}
