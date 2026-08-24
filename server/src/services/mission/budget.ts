import { and, eq, sql } from 'drizzle-orm';
import { AppError } from '../../middleware/error-handler.js';
import type { DbInstance } from '../../types.js';

/**
 * Mission Budget module: root holds, allocations, in-flight reservations,
 * settlements, and releases.
 *
 * Postgres is the authority. Row-lock ordering is stable: company, then
 * billing agent(s) by id, then root reservation. Monetary values are integer
 * cents; no floating-point budget decisions. Settlement is exactly-once:
 * unique `external_call_id` prevents double-charge on replay/recovery, and
 * settlement + legacy counter updates + compatibility cost_events happen in
 * one transaction (VAL-RUN-123).
 */

type Tx = Parameters<Parameters<DbInstance['drizzle']['transaction']>[0]>[0];

export interface BudgetDeps {
  clock?: () => Date;
}

/** Input for reserving a root company hold at start. */
export interface ReserveRootInput {
  companyId: string;
  runId: string;
  billingAgentId: string | null;
  requestedCents: number;
  periodKey: string;
}

/** Result of a root reservation. */
export interface ReserveRootResult {
  reservationId: string;
  allocationId: string;
  reservedCents: number;
}

/** Input for allocating from a root reservation for a child run. */
export interface AllocateInput {
  companyId: string;
  rootReservationId: string;
  runId: string;
  billingAgentId: string | null;
  allocatedCents: number;
}

/** Input for settling an external call charge. */
export interface SettleInput {
  companyId: string;
  runId: string;
  billingAgentId: string | null;
  externalCallId: string;
  provider: string;
  model?: string;
  operation?: string;
  inputTokens?: number;
  outputTokens?: number;
  credits?: number;
  costCents: number;
  providerRequestIdHash?: string;
  traceId?: string | null;
}

/** Result of a settlement. */
export interface SettleResult {
  settlementId: string;
  costCents: number;
  /** True if this was a replay of an existing settlement. */
  replayed: boolean;
}

/** Input for releasing unconsumed budget on terminalization. */
export interface ReleaseInput {
  companyId: string;
  runId: string;
}

/** Minimum viable budget reservation (1 cent). */
const MIN_VIABLE_CENTS = 1;

export class BudgetService {
  constructor(
    private db: DbInstance,
    private deps: BudgetDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  /**
   * Reserve a root company hold at start. Locks company + billing agent in
   * stable order, checks headroom, creates reservation + allocation, or
   * throws 409 BUDGET_UNAVAILABLE. Must be called inside a transaction.
   */
  async reserveRoot(tx: Tx, input: ReserveRootInput): Promise<ReserveRootResult> {
    const schema = this.db.schema;
    const now = this.now();

    // Lock company row in stable order.
    const [company] = await tx
      .select({
        budgetMonthlyCents: schema.companies.budgetMonthlyCents,
        spentMonthlyCents: schema.companies.spentMonthlyCents,
      })
      .from(schema.companies)
      .where(eq(schema.companies.id, input.companyId))
      .for('update')
      .limit(1);

    if (!company) {
      throw new AppError(404, 'COMPANY_NOT_FOUND', 'Company not found');
    }

    // Lock billing agent row if present (stable order: after company).
    let agentBudgetMonthlyCents = 0;
    let agentSpentMonthlyCents = 0;
    if (input.billingAgentId) {
      const [agent] = await tx
        .select({
          budgetMonthlyCents: schema.agents.budgetMonthlyCents,
          spentMonthlyCents: schema.agents.spentMonthlyCents,
        })
        .from(schema.agents)
        .where(
          and(
            eq(schema.agents.id, input.billingAgentId),
            eq(schema.agents.companyId, input.companyId),
          ),
        )
        .for('update')
        .limit(1);
      if (!agent) {
        throw new AppError(404, 'AGENT_NOT_FOUND', 'Billing agent not found');
      }
      agentBudgetMonthlyCents = agent.budgetMonthlyCents;
      agentSpentMonthlyCents = agent.spentMonthlyCents;
    }

    // Sum residual active root holds for the same company + period (held or
    // partially_settled — not released/settled).
    const residualHolds = await tx
      .select({
        reservedCents: schema.budgetReservations.reservedCents,
        settledCents: schema.budgetReservations.settledCents,
        releasedCents: schema.budgetReservations.releasedCents,
      })
      .from(schema.budgetReservations)
      .where(
        and(
          eq(schema.budgetReservations.companyId, input.companyId),
          eq(schema.budgetReservations.periodKey, input.periodKey),
          sql`${schema.budgetReservations.status} IN ('held', 'partially_settled')`,
        ),
      );

    // Residual = reserved - settled - released for each active hold.
    const totalResidualHolds = residualHolds.reduce(
      (sum, r) => sum + (r.reservedCents - r.settledCents - r.releasedCents),
      0,
    );

    // Compute available company headroom. If budgetMonthlyCents is 0, treat
    // as unbounded (but keep finite Mission ceiling).
    let availableCompanyCents: number;
    if (company.budgetMonthlyCents === 0) {
      availableCompanyCents = input.requestedCents;
    } else {
      availableCompanyCents =
        company.budgetMonthlyCents - company.spentMonthlyCents - totalResidualHolds;
    }

    // Check agent headroom if present.
    if (input.billingAgentId) {
      // Sum residual active allocations for this agent in the same period.
      const residualAllocations = await tx
        .select({
          allocatedCents: schema.budgetAllocations.allocatedCents,
          settledCents: schema.budgetAllocations.settledCents,
          releasedCents: schema.budgetAllocations.releasedCents,
        })
        .from(schema.budgetAllocations)
        .where(
          and(
            eq(schema.budgetAllocations.billingAgentId, input.billingAgentId),
            sql`${schema.budgetAllocations.status} IN ('held', 'partially_settled')`,
          ),
        );

      const totalResidualAllocations = residualAllocations.reduce(
        (sum, r) => sum + (r.allocatedCents - r.settledCents - r.releasedCents),
        0,
      );

      let availableAgentCents: number;
      if (agentBudgetMonthlyCents === 0) {
        availableAgentCents = input.requestedCents;
      } else {
        availableAgentCents =
          agentBudgetMonthlyCents - agentSpentMonthlyCents - totalResidualAllocations;
      }

      if (availableAgentCents < MIN_VIABLE_CENTS) {
        throw new AppError(
          409,
          'BUDGET_UNAVAILABLE',
          'Insufficient billing agent budget for the minimum viable Mission reservation',
        );
      }
      // Available is the minimum of company and agent headroom.
      availableCompanyCents = Math.min(availableCompanyCents, availableAgentCents);
    }

    if (availableCompanyCents < MIN_VIABLE_CENTS) {
      throw new AppError(
        409,
        'BUDGET_UNAVAILABLE',
        'Insufficient company budget for the minimum viable Mission reservation',
      );
    }

    // Reserve min(requested ceiling, available).
    const reservedCents = Math.min(input.requestedCents, availableCompanyCents);

    // Insert root reservation.
    const [reservation] = await tx
      .insert(schema.budgetReservations)
      .values({
        companyId: input.companyId,
        runId: input.runId,
        billingAgentId: input.billingAgentId,
        requestedCents: input.requestedCents,
        reservedCents,
        settledCents: 0,
        releasedCents: 0,
        periodKey: input.periodKey,
        status: 'held',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.budgetReservations.id });

    // Insert initial allocation.
    const [allocation] = await tx
      .insert(schema.budgetAllocations)
      .values({
        companyId: input.companyId,
        rootReservationId: reservation.id,
        runId: input.runId,
        billingAgentId: input.billingAgentId,
        allocatedCents: reservedCents,
        settledCents: 0,
        releasedCents: 0,
        status: 'held',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.budgetAllocations.id });

    return { reservationId: reservation.id, allocationId: allocation.id, reservedCents };
  }

  /**
   * Settle an external call charge. Inserts a uniquely-keyed settlement,
   * updates reservation/allocation settled amounts, updates legacy
   * company/agent monthly spend counters, and inserts a compatibility
   * cost_events row — all in one transaction. Duplicate external_call_id
   * returns the original result (VAL-RUN-065, VAL-RUN-123).
   *
   * Must be called inside a transaction.
   */
  async settle(tx: Tx, input: SettleInput): Promise<SettleResult> {
    const schema = this.db.schema;
    const now = this.now();

    // Check for an existing settlement with the same external_call_id
    // (replay/recovery idempotency).
    const [existing] = await tx
      .select({
        id: schema.budgetSettlements.id,
        costCents: schema.budgetSettlements.costCents,
      })
      .from(schema.budgetSettlements)
      .where(eq(schema.budgetSettlements.externalCallId, input.externalCallId))
      .limit(1);

    if (existing) {
      return { settlementId: existing.id, costCents: existing.costCents, replayed: true };
    }

    // Lock the allocation for this run.
    const [allocation] = await tx
      .select()
      .from(schema.budgetAllocations)
      .where(eq(schema.budgetAllocations.runId, input.runId))
      .for('update')
      .limit(1);

    if (!allocation) {
      throw new AppError(404, 'BUDGET_ALLOCATION_NOT_FOUND', 'Budget allocation not found for run');
    }

    // Lock the root reservation.
    const [reservation] = await tx
      .select()
      .from(schema.budgetReservations)
      .where(eq(schema.budgetReservations.id, allocation.rootReservationId))
      .for('update')
      .limit(1);

    if (!reservation) {
      throw new AppError(404, 'BUDGET_RESERVATION_NOT_FOUND', 'Budget reservation not found');
    }

    // Verify the settlement does not exceed the allocation.
    const allocationRemaining =
      allocation.allocatedCents - allocation.settledCents - allocation.releasedCents;
    if (input.costCents > allocationRemaining) {
      throw new AppError(409, 'BUDGET_EXHAUSTED', 'Settlement exceeds remaining allocation');
    }

    // Insert the immutable settlement.
    const [settlement] = await tx
      .insert(schema.budgetSettlements)
      .values({
        companyId: input.companyId,
        rootReservationId: reservation.id,
        allocationId: allocation.id,
        runId: input.runId,
        billingAgentId: input.billingAgentId,
        externalCallId: input.externalCallId,
        provider: input.provider,
        model: input.model ?? null,
        operation: input.operation ?? null,
        inputTokens: input.inputTokens ?? 0,
        outputTokens: input.outputTokens ?? 0,
        credits: input.credits ?? 0,
        costCents: input.costCents,
        providerRequestIdHash: input.providerRequestIdHash ?? null,
        traceId: input.traceId ?? null,
        createdAt: now,
      })
      .returning({ id: schema.budgetSettlements.id });

    // Update allocation settled amount + status.
    const newAllocationSettled = allocation.settledCents + input.costCents;
    const allocationStatus =
      newAllocationSettled >= allocation.allocatedCents ? 'settled' : 'partially_settled';
    await tx
      .update(schema.budgetAllocations)
      .set({
        settledCents: newAllocationSettled,
        status: allocationStatus,
        updatedAt: now,
      })
      .where(eq(schema.budgetAllocations.id, allocation.id));

    // Update reservation settled amount + status.
    const newReservationSettled = reservation.settledCents + input.costCents;
    const reservationStatus =
      newReservationSettled >= reservation.reservedCents ? 'settled' : 'partially_settled';
    await tx
      .update(schema.budgetReservations)
      .set({
        settledCents: newReservationSettled,
        status: reservationStatus,
        updatedAt: now,
      })
      .where(eq(schema.budgetReservations.id, reservation.id));

    // Update legacy company monthly spend counter.
    await tx
      .update(schema.companies)
      .set({
        spentMonthlyCents: sql`${schema.companies.spentMonthlyCents} + ${input.costCents}`,
        updatedAt: now,
      })
      .where(eq(schema.companies.id, input.companyId));

    // Update legacy agent monthly spend counter if billing agent exists.
    if (input.billingAgentId) {
      await tx
        .update(schema.agents)
        .set({
          spentMonthlyCents: sql`${schema.agents.spentMonthlyCents} + ${input.costCents}`,
          updatedAt: now,
        })
        .where(eq(schema.agents.id, input.billingAgentId));
    }

    // Insert compatibility cost_events row linked to the settlement.
    // cost_events.agentId is NOT NULL, so only insert when a billing agent
    // exists (always the case for Mission runs per the architecture).
    if (input.billingAgentId) {
      await tx.insert(schema.costEvents).values({
        companyId: input.companyId,
        agentId: input.billingAgentId,
        provider: input.provider,
        model: input.model ?? 'unknown',
        inputTokens: input.inputTokens ?? 0,
        outputTokens: input.outputTokens ?? 0,
        costCents: input.costCents,
        budgetSettlementId: settlement.id,
        createdAt: now,
      });
    }

    return { settlementId: settlement.id, costCents: input.costCents, replayed: false };
  }

  /**
   * Release all unconsumed budget on terminalization. Updates reservation
   * and allocation released amounts + status, and sets terminal timestamps.
   * Must be called inside a transaction.
   */
  async release(tx: Tx, input: ReleaseInput): Promise<void> {
    const schema = this.db.schema;
    const now = this.now();

    // Lock the allocation for this run.
    const [allocation] = await tx
      .select()
      .from(schema.budgetAllocations)
      .where(eq(schema.budgetAllocations.runId, input.runId))
      .for('update')
      .limit(1);

    if (!allocation) {
      return; // No allocation to release.
    }

    // Lock the root reservation.
    const [reservation] = await tx
      .select()
      .from(schema.budgetReservations)
      .where(eq(schema.budgetReservations.id, allocation.rootReservationId))
      .for('update')
      .limit(1);

    if (!reservation) {
      return;
    }

    // Release unconsumed allocation amount.
    const allocationReleased = allocation.allocatedCents - allocation.settledCents;
    if (allocationReleased > 0) {
      await tx
        .update(schema.budgetAllocations)
        .set({
          releasedCents: sql`${schema.budgetAllocations.releasedCents} + ${allocationReleased}`,
          status: 'released',
          updatedAt: now,
        })
        .where(eq(schema.budgetAllocations.id, allocation.id));
    } else {
      await tx
        .update(schema.budgetAllocations)
        .set({ status: 'released', updatedAt: now })
        .where(eq(schema.budgetAllocations.id, allocation.id));
    }

    // Release unconsumed reservation amount.
    const reservationReleased =
      reservation.reservedCents - reservation.settledCents - reservation.releasedCents;
    if (reservationReleased > 0) {
      await tx
        .update(schema.budgetReservations)
        .set({
          releasedCents: sql`${schema.budgetReservations.releasedCents} + ${reservationReleased}`,
          status: 'released',
          terminalAt: now,
          updatedAt: now,
        })
        .where(eq(schema.budgetReservations.id, reservation.id));
    } else {
      await tx
        .update(schema.budgetReservations)
        .set({ status: 'released', terminalAt: now, updatedAt: now })
        .where(eq(schema.budgetReservations.id, reservation.id));
    }
  }

  /**
   * Earmark the approved execution envelope from the existing root hold
   * atomically (VAL-PLAN-094, VAL-PLAN-126).
   *
   * Approval never reacquires or double-reserves company funds. It verifies
   * `executionEnvelopeCents <= rootReserved - settledPlanning - inFlightPlanning`
   * and atomically sets `executionEarmarkCents` on the root reservation in
   * the same transaction as the binding and queue transition.
   *
   * Only consumed/expired residual, a lower live billing-agent security
   * limit, or an approved estimate above the existing hold can return
   * `409 BUDGET_UNAVAILABLE`. Ordinary external headroom use cannot
   * invalidate protected root funds because the root hold is already
   * reserved.
   *
   * Must be called inside a transaction (the caller's locked transaction).
   *
   * @param tx The caller's transaction.
   * @param runId The run whose root reservation to earmark.
   * @param executionEnvelopeCents `sum(stepBudgetCents) + synthesisBudgetCents`.
   * @returns The earmark result with residual and earmark amounts.
   * @throws AppError(409, 'BUDGET_UNAVAILABLE') if the envelope exceeds the
   *   residual or the live billing-agent limit.
   */
  async earmarkApproval(
    tx: Tx,
    runId: string,
    executionEnvelopeCents: number,
  ): Promise<{
    reservationId: string;
    reservedCents: number;
    settledPlanningCents: number;
    inFlightPlanningCents: number;
    residualCents: number;
    executionEarmarkCents: number;
  }> {
    const schema = this.db.schema;
    const now = this.now();

    // Lock the root reservation for this run.
    const [reservation] = await tx
      .select()
      .from(schema.budgetReservations)
      .where(eq(schema.budgetReservations.runId, runId))
      .for('update')
      .limit(1);

    if (!reservation) {
      throw new AppError(
        404,
        'BUDGET_RESERVATION_NOT_FOUND',
        'Root budget reservation not found for run',
      );
    }

    // At approval time, all settled amounts are planning charges (no
    // execution has started). In-flight planning is not separately tracked
    // in Phase 1, so it is 0. This is conservative: the residual is
    // rootReserved - settledPlanning, which is the maximum available for
    // execution. Released amounts are excluded because a nonterminal run
    // in awaiting_approval should have no releases.
    const settledPlanningCents = reservation.settledCents;
    const inFlightPlanningCents = 0;
    const residualCents = reservation.reservedCents - settledPlanningCents - inFlightPlanningCents;

    // Check 1: execution envelope must fit the residual root hold.
    if (executionEnvelopeCents > residualCents) {
      throw new AppError(
        409,
        'BUDGET_UNAVAILABLE',
        `Approved execution envelope (${executionEnvelopeCents}c) exceeds residual root hold (${residualCents}c). Replan with a lower budget or cancel.`,
      );
    }

    // Check 2: live billing-agent security limit. If the billing agent's
    // monthly budget was reduced since start, the approval may fail even
    // though the root hold covers the envelope. The root hold is already
    // reserved (protecting the company), but the agent's live limit may
    // have been lowered below the in-use allocation.
    if (reservation.billingAgentId) {
      const [agent] = await tx
        .select({
          budgetMonthlyCents: schema.agents.budgetMonthlyCents,
          spentMonthlyCents: schema.agents.spentMonthlyCents,
        })
        .from(schema.agents)
        .where(
          and(
            eq(schema.agents.id, reservation.billingAgentId),
            eq(schema.agents.companyId, reservation.companyId),
          ),
        )
        .for('update')
        .limit(1);

      if (agent) {
        // Sum residual active allocations for this agent (held or
        // partially_settled — not released/settled).
        const residualAllocations = await tx
          .select({
            allocatedCents: schema.budgetAllocations.allocatedCents,
            settledCents: schema.budgetAllocations.settledCents,
            releasedCents: schema.budgetAllocations.releasedCents,
          })
          .from(schema.budgetAllocations)
          .where(
            and(
              eq(schema.budgetAllocations.billingAgentId, reservation.billingAgentId),
              sql`${schema.budgetAllocations.status} IN ('held', 'partially_settled')`,
            ),
          );

        const totalResidualAllocations = residualAllocations.reduce(
          (sum, r) => sum + (r.allocatedCents - r.settledCents - r.releasedCents),
          0,
        );

        // If the agent has a nonzero monthly budget, check that the
        // current allocation (which includes this run's root hold) does
        // not exceed the agent's live headroom. A lowered agent limit
        // can invalidate the approval.
        if (agent.budgetMonthlyCents > 0) {
          const agentHeadroom =
            agent.budgetMonthlyCents - agent.spentMonthlyCents - totalResidualAllocations;
          // The execution envelope must be within the agent's remaining
          // headroom plus the current run's allocation (since the current
          // run's allocation is already included in totalResidualAllocations).
          // If agentHeadroom is negative, the agent is over-allocated.
          if (agentHeadroom < 0) {
            throw new AppError(
              409,
              'BUDGET_UNAVAILABLE',
              'Billing agent budget limit was reduced below the current allocation. Replan with a lower budget or cancel.',
            );
          }
        }
      }
    }

    // Atomically earmark the execution envelope on the root reservation.
    await tx
      .update(schema.budgetReservations)
      .set({
        executionEarmarkCents: executionEnvelopeCents,
        updatedAt: now,
      })
      .where(eq(schema.budgetReservations.id, reservation.id));

    return {
      reservationId: reservation.id,
      reservedCents: reservation.reservedCents,
      settledPlanningCents,
      inFlightPlanningCents,
      residualCents,
      executionEarmarkCents: executionEnvelopeCents,
    };
  }

  /**
   * Read budget summary for a run (reservation + allocation).
   */
  async getBudgetSummary(
    runner: Tx | DbInstance['drizzle'],
    runId: string,
  ): Promise<{
    reservedCents: number;
    settledCents: number;
    releasedCents: number;
    costCentsCeiling: number;
  }> {
    const schema = this.db.schema;
    const [reservation] = await runner
      .select()
      .from(schema.budgetReservations)
      .where(eq(schema.budgetReservations.runId, runId))
      .limit(1);

    if (!reservation) {
      return { reservedCents: 0, settledCents: 0, releasedCents: 0, costCentsCeiling: 0 };
    }

    return {
      reservedCents: reservation.reservedCents,
      settledCents: reservation.settledCents,
      releasedCents: reservation.releasedCents,
      costCentsCeiling: reservation.requestedCents,
    };
  }

  /**
   * Count settlements for a run.
   */
  async countSettlements(runner: Tx | DbInstance['drizzle'], runId: string): Promise<number> {
    const schema = this.db.schema;
    const rows = await runner
      .select({ id: schema.budgetSettlements.id })
      .from(schema.budgetSettlements)
      .where(eq(schema.budgetSettlements.runId, runId));
    return rows.length;
  }
}
