/**
 * Research attempt accounting: reserve, settle, charge, and release every
 * research provider attempt exactly once.
 *
 * (architecture.md: Budget, VAL-RES-064, VAL-RES-065, VAL-RES-066,
 *  VAL-RES-067, VAL-RES-068, VAL-RES-069, VAL-RES-070, VAL-RES-110,
 *  VAL-RES-120)
 *
 * Each physical provider attempt is a `research_attempts` row with state
 * `prepared -> started -> succeeded | failed | cancelled | unknown`.
 *
 * In-flight budget is reserved before dispatch (preflight + reserveInFlight)
 * and released or settled after the outcome. The invariant
 * `settled + released + activeInFlight <= allocated` is enforced under a
 * row lock on the run's allocation. Settlement is exactly-once through the
 * BudgetService keyed by a unique `external_call_id` (VAL-RES-066).
 *
 * Fallback attempts each get their own attempt row, settlement, and
 * request-id hash while sharing one logical call id (VAL-RES-067). Unknown
 * price is never free: the configured conservative maximum is reserved and
 * charged when usage is unknown (VAL-RES-069, VAL-RES-110). Budget
 * exhaustion blocks further dispatch (VAL-RES-068). Unused residuals
 * release on terminalization (VAL-RES-070).
 *
 * Monetary values are integer cents; no floating-point budget decisions.
 */

import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../../middleware/error-handler.js';
import type { DbInstance } from '../../../types.js';
import { BudgetService } from '../budget.js';

type Tx = Parameters<Parameters<DbInstance['drizzle']['transaction']>[0]>[0];

export interface ResearchAccountingDeps {
  clock?: () => Date;
}

/** Input for reserving an in-flight hold before dispatch. */
export interface ReserveInFlightInput {
  companyId: string;
  projectId?: string;
  runId: string;
  rootRunId: string;
  logicalCallId: string;
  /** Per-logical-call physical attempt ordinal (1-based). */
  attemptOrdinal: number;
  provider: string;
  operation: string;
  /** Conservative in-flight hold (integer cents). */
  reservedCents: number;
}

/** Result of reserving an in-flight hold. */
export interface ReserveInFlightResult {
  attemptId: string;
  allocationId: string;
  /** Allocation remaining after this reservation (integer cents). */
  remainingCents: number;
}

/** Input for settling a successful attempt. */
export interface SettleAttemptInput {
  /** Deterministic external call id (unique per physical attempt). */
  externalCallId: string;
  /** Provider-reported credits/units consumed. */
  reportedCredits: number;
  /** SHA-256 hash of the provider request id (lowercase hex). */
  providerRequestIdHash?: string;
  /** Linked immutable pricing snapshot id. */
  pricingSnapshotId?: string;
  /** Actual charge (integer cents), computed from the pricing snapshot. */
  costCents: number;
  /** Billing agent id (for legacy spend projection). */
  billingAgentId?: string | null;
  /** Trace id for correlation. */
  traceId?: string | null;
}

/** Result of settling an attempt. */
export interface SettleAttemptResult {
  attemptId: string;
  settlementId: string;
  costCents: number;
  /** True if this was a replay of an existing settlement. */
  replayed: boolean;
}

/** Input for conservatively settling an unknown-outcome attempt. */
export interface MarkUnknownInput {
  /** Deterministic external call id (unique per physical attempt). */
  externalCallId: string;
  /** The snapshotted conservative maximum (integer cents). */
  conservativeMaxCents: number;
  /** Linked immutable pricing snapshot id. */
  pricingSnapshotId?: string;
  /** Billing agent id. */
  billingAgentId?: string | null;
  /** Trace id for correlation. */
  traceId?: string | null;
}

/** Allocation budget state for a run. */
export interface AllocationState {
  allocationId: string;
  allocatedCents: number;
  settledCents: number;
  releasedCents: number;
  /** Sum of reserved_cents over active in-flight attempts (prepared/started). */
  inFlightCents: number;
  /** allocated - settled - released - inFlight. */
  remainingCents: number;
}

/** Active in-flight attempt states (reserved_cents counts as held). */
const IN_FLIGHT_STATES = ['prepared', 'started'];

export class ResearchAttemptAccountingService {
  private readonly clock: () => Date;
  private readonly budget: BudgetService;

  constructor(
    private db: DbInstance,
    deps: ResearchAccountingDeps = {},
  ) {
    this.clock = deps.clock ?? (() => new Date());
    this.budget = new BudgetService(db, { clock: this.clock });
  }

  private now(): Date {
    return this.clock();
  }

  /**
   * Read the allocation budget state for a run under a row lock.
   *
   * @param tx Transaction client.
   * @param runId The run id.
   * @param lock Whether to acquire FOR UPDATE lock.
   */
  async getAllocationState(tx: Tx, runId: string, lock = true): Promise<AllocationState> {
    const lockClause = lock ? sql` FOR UPDATE` : sql``;

    const [allocation] = (await tx.execute(sql`
      SELECT "id", "allocated_cents", "settled_cents", "released_cents"
      FROM "budget_allocations"
      WHERE "run_id" = ${runId}
      LIMIT 1${lockClause}
    `)) as unknown as {
      id: string;
      allocated_cents: number;
      settled_cents: number;
      released_cents: number;
    }[];

    if (!allocation) {
      throw new AppError(404, 'BUDGET_ALLOCATION_NOT_FOUND', 'Budget allocation not found for run');
    }

    const inFlightRows = (await tx.execute(sql`
      SELECT COALESCE(SUM("reserved_cents"), 0) AS "in_flight"
      FROM "research_attempts"
      WHERE "run_id" = ${runId}
        AND "state" IN (${IN_FLIGHT_STATES[0]}, ${IN_FLIGHT_STATES[1]})
    `)) as unknown as { in_flight: string }[];

    const inFlightCents = Number(inFlightRows[0]?.in_flight ?? 0);
    const remainingCents =
      allocation.allocated_cents -
      allocation.settled_cents -
      allocation.released_cents -
      inFlightCents;

    return {
      allocationId: allocation.id,
      allocatedCents: allocation.allocated_cents,
      settledCents: allocation.settled_cents,
      releasedCents: allocation.released_cents,
      inFlightCents,
      remainingCents,
    };
  }

  /**
   * VAL-RES-064: Research budget preflight. Verify the allocation can cover
   * the conservative estimated provider charge before any dispatch. Throws
   * 409 BUDGET_UNAVAILABLE if it cannot.
   *
   * Must be called inside a transaction.
   */
  async preflight(
    tx: Tx,
    runId: string,
    conservativeEstimateCents: number,
  ): Promise<AllocationState> {
    const state = await this.getAllocationState(tx, runId);
    if (state.remainingCents < conservativeEstimateCents) {
      throw new AppError(
        409,
        'BUDGET_UNAVAILABLE',
        'Research budget cannot cover the conservative estimated provider charge',
      );
    }
    return state;
  }

  /**
   * Check whether a new in-flight reservation of `requiredCents` can be
   * covered by the remaining allocation. Used to block fallback when budget
   * is exhausted (VAL-RES-068). Does NOT mutate state.
   *
   * Must be called inside a transaction (acquires a lock for a consistent
   * read).
   */
  async checkBudgetAvailable(tx: Tx, runId: string, requiredCents: number): Promise<boolean> {
    const state = await this.getAllocationState(tx, runId);
    return state.remainingCents >= requiredCents;
  }

  /**
   * VAL-RES-065: Reserve a bounded in-flight hold inside the run allocation
   * before dispatch. Creates a `research_attempts` row in `prepared` state
   * and verifies `settled + released + activeInFlight + new <= allocated`.
   * Throws 409 BUDGET_EXHAUSTED if the reservation would over-allocate.
   *
   * Must be called inside a transaction.
   */
  async reserveInFlight(tx: Tx, input: ReserveInFlightInput): Promise<ReserveInFlightResult> {
    if (input.reservedCents < 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'reservedCents must be non-negative');
    }
    if (input.attemptOrdinal < 1) {
      throw new AppError(400, 'VALIDATION_ERROR', 'attemptOrdinal must be positive');
    }

    const state = await this.getAllocationState(tx, input.runId);
    if (state.remainingCents < input.reservedCents) {
      throw new AppError(
        409,
        'BUDGET_EXHAUSTED',
        'In-flight research reservation would exceed remaining allocation',
      );
    }

    const id = randomUUID();
    const now = this.now();

    // SELECT-then-INSERT: check for an existing attempt first so the
    // idempotent case (same logical_call_id + ordinal from a replay or
    // recovery) is handled without catching an INSERT failure. This avoids
    // the PostgreSQL aborted-transaction problem where a failed INSERT
    // prevents the catch-block SELECT from executing, causing a misleading
    // RESEARCH_ATTEMPT_CONFLICT even when no prior attempt exists
    // (fix-ut-m5-research-attempt-transaction).
    const [existing] = (await tx.execute(sql`
      SELECT "id" FROM "research_attempts"
      WHERE "logical_call_id" = ${input.logicalCallId}
        AND "attempt_ordinal" = ${input.attemptOrdinal}
      LIMIT 1
    `)) as unknown as { id: string }[];
    if (existing) {
      const postState = await this.getAllocationState(tx, input.runId, false);
      return {
        attemptId: existing.id,
        allocationId: state.allocationId,
        remainingCents: postState.remainingCents,
      };
    }

    // INSERT the new attempt. If this fails (unique-constraint violation
    // from a concurrent insert, or a foreign-key/check constraint
    // violation), the original error propagates so the caller sees the real
    // failure instead of a misleading RESEARCH_ATTEMPT_CONFLICT. The
    // caller's transaction will be rolled back by drizzle; on retry the
    // SELECT above will find the existing row (for the unique race) or the
    // same error will surface (for FK) (fix-ut-m5-research-attempt-transaction).
    await tx.execute(sql`
      INSERT INTO "research_attempts"
        ("id","company_id","project_id","run_id","root_run_id","allocation_id",
         "logical_call_id","attempt_ordinal","provider","operation","state",
         "reserved_cents","settled_cents","created_at")
      VALUES
        (${id}, ${input.companyId}, ${input.projectId ?? null}, ${input.runId},
         ${input.rootRunId}, ${state.allocationId},
         ${input.logicalCallId}, ${input.attemptOrdinal},
         ${input.provider}, ${input.operation}, 'prepared',
         ${input.reservedCents}, 0, ${now})
    `);

    const postState = await this.getAllocationState(tx, input.runId, false);
    return {
      attemptId: id,
      allocationId: state.allocationId,
      remainingCents: postState.remainingCents,
    };
  }

  /**
   * VAL-RES-110: Transition an attempt from `prepared` to `started` before
   * dispatch. Throws if the attempt is not in `prepared` state.
   *
   * Must be called inside a transaction.
   */
  async markStarted(tx: Tx, attemptId: string): Promise<void> {
    const now = this.now();
    const result = (await tx.execute(sql`
      UPDATE "research_attempts"
      SET "state" = 'started', "started_at" = ${now}
      WHERE "id" = ${attemptId} AND "state" = 'prepared'
      RETURNING "id"
    `)) as unknown as { id: string }[];
    if (result.length === 0) {
      // Verify the attempt exists for a correct error.
      const [row] = (await tx.execute(sql`
        SELECT "state" FROM "research_attempts" WHERE "id" = ${attemptId} LIMIT 1
      `)) as unknown as { state: string }[];
      if (!row) {
        throw new AppError(404, 'RESEARCH_ATTEMPT_NOT_FOUND', 'Research attempt not found');
      }
      throw new AppError(
        409,
        'INVALID_ATTEMPT_STATE',
        `Research attempt is in state '${row.state}', cannot mark started`,
      );
    }
  }

  /**
   * VAL-RES-066 / VAL-RES-067: Settle a successful attempt exactly once.
   * Transitions the attempt to `succeeded`, creates an immutable settlement
   * through the BudgetService keyed by `external_call_id` (replay returns
   * the original result), and releases the unused in-flight residual (the
   * difference between the reservation and the actual charge remains
   * available to the allocation because only `costCents` is added to
   * `settled_cents`).
   *
   * Must be called inside a transaction.
   */
  async settleAttempt(
    tx: Tx,
    attemptId: string,
    input: SettleAttemptInput,
  ): Promise<SettleAttemptResult> {
    const now = this.now();

    // Lock the attempt row.
    const [attempt] = (await tx.execute(sql`
      SELECT "id", "company_id", "run_id", "reserved_cents", "state"
      FROM "research_attempts"
      WHERE "id" = ${attemptId}
      FOR UPDATE
      LIMIT 1
    `)) as unknown as {
      id: string;
      company_id: string;
      run_id: string;
      reserved_cents: number;
      state: string;
    }[];

    if (!attempt) {
      throw new AppError(404, 'RESEARCH_ATTEMPT_NOT_FOUND', 'Research attempt not found');
    }

    // If already settled (idempotent replay), return the existing result.
    if (attempt.state === 'succeeded') {
      const [existing] = (await tx.execute(sql`
        SELECT "id" AS "settlement_id", "cost_cents"
        FROM "budget_settlements"
        WHERE "external_call_id" = ${input.externalCallId}
        LIMIT 1
      `)) as unknown as { settlement_id: string; cost_cents: number }[];
      if (existing) {
        return {
          attemptId,
          settlementId: existing.settlement_id,
          costCents: existing.cost_cents,
          replayed: true,
        };
      }
    }

    // Settle through the BudgetService (exactly-once via external_call_id).
    const settleResult = await this.budget.settle(tx, {
      companyId: attempt.company_id,
      runId: attempt.run_id,
      billingAgentId: input.billingAgentId ?? null,
      externalCallId: input.externalCallId,
      provider: 'research',
      operation: 'research_call',
      credits: input.reportedCredits,
      costCents: input.costCents,
      providerRequestIdHash: input.providerRequestIdHash,
      traceId: input.traceId ?? null,
    });

    // Transition the attempt to succeeded and record the settlement linkage.
    await tx.execute(sql`
      UPDATE "research_attempts"
      SET "state" = 'succeeded',
          "settled_cents" = ${input.costCents},
          "external_call_id" = ${input.externalCallId},
          "provider_request_id_hash" = ${input.providerRequestIdHash ?? null},
          "pricing_snapshot_id" = ${input.pricingSnapshotId ?? null},
          "reported_credits" = ${input.reportedCredits},
          "settled_at" = ${now},
          "terminal_at" = ${now}
      WHERE "id" = ${attemptId}
    `);

    return {
      attemptId,
      settlementId: settleResult.settlementId,
      costCents: settleResult.costCents,
      replayed: settleResult.replayed,
    };
  }

  /**
   * VAL-RES-110: Mark an attempt as failed (pre- or post-dispatch without a
   * charge). Releases the in-flight reservation by transitioning out of the
   * in-flight state. No settlement is created.
   *
   * Must be called inside a transaction.
   */
  async markFailed(
    tx: Tx,
    attemptId: string,
    failureCode: string,
    safeErrorMessage?: string,
  ): Promise<void> {
    const now = this.now();
    const result = (await tx.execute(sql`
      UPDATE "research_attempts"
      SET "state" = 'failed',
          "failure_code" = ${failureCode},
          "safe_error_message" = ${safeErrorMessage ?? null},
          "terminal_at" = ${now}
      WHERE "id" = ${attemptId}
        AND "state" IN ('prepared', 'started')
      RETURNING "id"
    `)) as unknown as { id: string }[];
    if (result.length === 0) {
      const [row] = (await tx.execute(sql`
        SELECT "state" FROM "research_attempts" WHERE "id" = ${attemptId} LIMIT 1
      `)) as unknown as { state: string }[];
      if (!row) {
        throw new AppError(404, 'RESEARCH_ATTEMPT_NOT_FOUND', 'Research attempt not found');
      }
      throw new AppError(
        409,
        'INVALID_ATTEMPT_STATE',
        `Research attempt is in terminal state '${row.state}', cannot mark failed`,
      );
    }
  }

  /**
   * VAL-RES-110 / VAL-RES-061: Mark an attempt as cancelled. Releases the
   * in-flight reservation without settlement.
   *
   * Must be called inside a transaction.
   */
  async markCancelled(tx: Tx, attemptId: string): Promise<void> {
    const now = this.now();
    const result = (await tx.execute(sql`
      UPDATE "research_attempts"
      SET "state" = 'cancelled',
          "failure_code" = 'CANCELLED',
          "terminal_at" = ${now}
      WHERE "id" = ${attemptId}
        AND "state" IN ('prepared', 'started')
      RETURNING "id"
    `)) as unknown as { id: string }[];
    if (result.length === 0) {
      const [row] = (await tx.execute(sql`
        SELECT "state" FROM "research_attempts" WHERE "id" = ${attemptId} LIMIT 1
      `)) as unknown as { state: string }[];
      if (!row) {
        throw new AppError(404, 'RESEARCH_ATTEMPT_NOT_FOUND', 'Research attempt not found');
      }
      // Already terminal — idempotent no-op for cancellation.
    }
  }

  /**
   * VAL-RES-110 / VAL-RES-069: Mark an attempt as `unknown` after a
   * post-dispatch connection loss with no usage/request id. NEVER fabricates
   * a zero cost or a provider request id. Conservatively settles the
   * snapshotted conservative maximum through the BudgetService. The
   * `external_call_id` is a deterministic service-generated id (not a
   * provider request id) so the conservative charge is exactly-once.
   *
   * Must be called inside a transaction.
   */
  async markUnknown(
    tx: Tx,
    attemptId: string,
    input: MarkUnknownInput,
  ): Promise<SettleAttemptResult> {
    const now = this.now();

    const [attempt] = (await tx.execute(sql`
      SELECT "id", "company_id", "run_id", "state"
      FROM "research_attempts"
      WHERE "id" = ${attemptId}
      FOR UPDATE
      LIMIT 1
    `)) as unknown as {
      id: string;
      company_id: string;
      run_id: string;
      state: string;
    }[];

    if (!attempt) {
      throw new AppError(404, 'RESEARCH_ATTEMPT_NOT_FOUND', 'Research attempt not found');
    }

    // Idempotent replay: already unknown/settled.
    if (attempt.state === 'unknown') {
      const [existing] = (await tx.execute(sql`
        SELECT "id" AS "settlement_id", "cost_cents"
        FROM "budget_settlements"
        WHERE "external_call_id" = ${input.externalCallId}
        LIMIT 1
      `)) as unknown as { settlement_id: string; cost_cents: number }[];
      if (existing) {
        return {
          attemptId,
          settlementId: existing.settlement_id,
          costCents: existing.cost_cents,
          replayed: true,
        };
      }
    }

    // Conservatively settle the maximum (unknown price is never free).
    const settleResult = await this.budget.settle(tx, {
      companyId: attempt.company_id,
      runId: attempt.run_id,
      billingAgentId: input.billingAgentId ?? null,
      externalCallId: input.externalCallId,
      provider: 'research',
      operation: 'research_call',
      costCents: input.conservativeMaxCents,
      providerRequestIdHash: undefined, // No fabricated request id.
      traceId: input.traceId ?? null,
    });

    await tx.execute(sql`
      UPDATE "research_attempts"
      SET "state" = 'unknown',
          "settled_cents" = ${input.conservativeMaxCents},
          "external_call_id" = ${input.externalCallId},
          "pricing_snapshot_id" = ${input.pricingSnapshotId ?? null},
          "failure_code" = 'UNKNOWN_EFFECT',
          "settled_at" = ${now},
          "terminal_at" = ${now}
      WHERE "id" = ${attemptId}
    `);

    return {
      attemptId,
      settlementId: settleResult.settlementId,
      costCents: settleResult.costCents,
      replayed: settleResult.replayed,
    };
  }

  /**
   * Release a single attempt's in-flight hold without settlement. Used when
   * a pre-dispatch failure occurs (VAL-RES-110: pre-dispatch failure
   * releases its reservation). Transitions prepared -> cancelled.
   *
   * Must be called inside a transaction.
   */
  async releaseInFlight(tx: Tx, attemptId: string): Promise<void> {
    await this.markCancelled(tx, attemptId);
  }

  /**
   * VAL-RES-070: Release all unused research budget on terminalization.
   * Transitions any active in-flight attempts (prepared/started) to
   * `cancelled`, then releases the unconsumed allocation residual through
   * the BudgetService. Known charges remain settled.
   *
   * Must be called inside a transaction.
   */
  async releaseRunResiduals(tx: Tx, companyId: string, runId: string): Promise<void> {
    const now = this.now();
    // Terminalize all active in-flight attempts.
    await tx.execute(sql`
      UPDATE "research_attempts"
      SET "state" = 'cancelled',
          "failure_code" = 'RELEASED',
          "terminal_at" = ${now}
      WHERE "run_id" = ${runId}
        AND "state" IN ('prepared', 'started')
    `);

    // Release the unconsumed allocation residual (allocated - settled).
    await this.budget.release(tx, { companyId, runId });
  }
}
