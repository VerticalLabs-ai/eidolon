import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../middleware/error-handler.js';
import type { DbInstance } from '../../types.js';

/**
 * RunCoordinator — claims, lease renewal, fencing, and release.
 *
 * Implements the claim algorithm from the architecture:
 *
 * 1. Begin transaction.
 * 2. Select one eligible run in `queued`, `running`, or `synthesizing`
 *    whose `available_at <= now()` and whose lease is null/expired,
 *    ordered by priority, available time, creation time, using
 *    `FOR UPDATE SKIP LOCKED`.
 * 3. Recheck cancellation under the lock (a cancelled run is not claimed).
 * 4. Generate a cryptographically random `lease_token`; set `lease_owner`,
 *    token, `lease_expires_at = now()+30s`, heartbeat, and increment
 *    attempt only for a real recovery/retry.
 * 5. Append `run.claimed` or `run.recovered`; commit.
 *
 * The worker renews every 10 seconds. Every worker mutation uses both run ID
 * and lease token as a fencing condition while holding/locking the run; a
 * stale worker cannot commit after another claim (VAL-RUN-119, VAL-RUN-120).
 *
 * Lease tokens are never included in event payloads, snapshots, command
 * history, SSE, activity, errors, or metrics (VAL-RUN-128). Only safe
 * worker/attempt identities and timestamps may be exposed.
 */

type Tx = Parameters<Parameters<DbInstance['drizzle']['transaction']>[0]>[0];

/**
 * Raw SQL result row for mission_runs. Column names are snake_case because
 * `tx.execute(sql`...`)` returns raw postgres.js rows without Drizzle's
 * camelCase column mapping.
 */
interface RawRunRow {
  id: string;
  company_id: string;
  project_id: string;
  project_thread_id: string;
  status: string;
  state_version: number;
  last_event_sequence: string | number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  heartbeat_at: Date | null;
  available_at: Date | null;
  attempt_count: number;
  cancel_requested_at: Date | null;
  terminal_at: Date | null;
  started_at: Date | null;
  created_at: Date;
}

/** Default lease duration (30 seconds per architecture). */
const LEASE_DURATION_MS = 30_000;
/** Default renewal interval (10 seconds per architecture). */
const RENEWAL_INTERVAL_MS = 10_000;

/** The status a queued run transitions to when claimed. */
const FIRST_CLAIM_TRANSITION: Record<string, string> = {
  queued: 'running',
};

export interface CoordinatorDeps {
  clock?: () => Date;
  /** Override the lease duration (ms). Default 30_000. */
  leaseDurationMs?: number;
}

/**
 * A claim represents the worker's fenced authority over a run. It carries
 * the lease token which must be presented on every fenced mutation. The
 * token is NEVER serialized into events, snapshots, or logs.
 */
export interface Claim {
  runId: string;
  companyId: string;
  projectId: string;
  /** Worker identifier (e.g., `worker-A`). Safe to expose. */
  leaseOwner: string;
  /** Cryptographically random lease token. NEVER expose. */
  leaseToken: string;
  /** When the lease expires. */
  leaseExpiresAt: Date;
  /** Run status at claim time (before any transition). */
  claimedFromStatus: string;
  /** Run status after the claim transition (e.g., `running`). */
  status: string;
  /** State version at claim time. */
  stateVersion: number;
  /** Latest event sequence at claim time. */
  lastEventSequence: number;
  /** Attempt count at claim time. */
  attemptCount: number;
  /** Whether this was a recovery (lease was expired/null on a non-queued state). */
  isRecovery: boolean;
}

export class RunCoordinator {
  constructor(
    private db: DbInstance,
    private deps: CoordinatorDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  private leaseDurationMs(): number {
    return this.deps.leaseDurationMs ?? LEASE_DURATION_MS;
  }

  /**
   * Claim the next eligible run for a worker. Returns null if no run is
   * eligible. Uses `FOR UPDATE SKIP LOCKED` so concurrent workers cannot
   * claim the same run (VAL-RUN-119).
   *
   * A `queued` run transitions to `running` (first claim, `run.claimed`).
   * A `running` or `synthesizing` run with an expired lease is recovered
   * (`run.recovered`). Recovery does NOT increment attempt_count.
   */
  async claimNext(workerId: string): Promise<Claim | null> {
    const now = this.now();
    const leaseExpiresAt = new Date(now.getTime() + this.leaseDurationMs());

    return this.db.drizzle.transaction(async (tx) => {
      // Select one eligible run using FOR UPDATE SKIP LOCKED.
      // Raw SQL returns snake_case column names (no Drizzle camelCase mapping).
      // Use the injected clock's time for comparisons so deterministic tests
      // with fixed clocks work correctly.
      const nowIso = now.toISOString();
      const result = await tx.execute(sql`
        SELECT * FROM "mission_runs"
        WHERE "status" IN ('planning', 'queued', 'running', 'synthesizing')
          AND ("available_at" IS NULL OR "available_at" <= ${nowIso}::timestamptz)
          AND ("lease_expires_at" IS NULL OR "lease_expires_at" <= ${nowIso}::timestamptz)
          AND "cancel_requested_at" IS NULL
          AND "terminal_at" IS NULL
        ORDER BY
          CASE "status"
            WHEN 'planning' THEN 0
            WHEN 'queued' THEN 1
            WHEN 'running' THEN 2
            WHEN 'synthesizing' THEN 3
          END,
          "available_at" ASC NULLS LAST,
          "created_at" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);

      const rows = result as unknown as RawRunRow[];
      if (!rows || rows.length === 0) {
        return null;
      }

      const run = rows[0];

      // Recheck cancellation under the lock (a cancel may have arrived
      // between the index scan and the lock acquisition).
      if (run.cancel_requested_at !== null) {
        return null;
      }

      // Determine if this is a first claim or a recovery.
      // A first claim is when the run has never been leased (no lease owner
      // and no lease token). This covers both `queued` and `planning` runs
      // that are freshly eligible. A recovery is when a previously-leased
      // run's lease expired and a new worker claims it.
      const isFirstClaim = run.lease_owner === null && run.lease_token === null;
      const isRecovery = !isFirstClaim;
      const newStatus = FIRST_CLAIM_TRANSITION[run.status] ?? run.status;

      // Generate a cryptographically random lease token.
      const leaseToken = randomUUID();
      const newVersion = run.state_version + 1;
      const seq = Number(run.last_event_sequence) + 1;

      // Use Drizzle query builder for UPDATE and INSERT to ensure proper
      // Date serialization (raw tx.execute doesn't apply custom serializers).
      const schema = this.db.schema;
      await tx
        .update(schema.missionRuns)
        .set({
          status: newStatus as 'running',
          leaseOwner: workerId,
          leaseToken,
          leaseExpiresAt,
          heartbeatAt: now,
          availableAt: null,
          startedAt: run.started_at ? new Date(run.started_at as unknown as string) : now,
          stateVersion: newVersion,
          lastEventSequence: seq,
          updatedAt: now,
        })
        .where(eq(schema.missionRuns.id, run.id));

      // Append the appropriate event. The payload contains only safe
      // worker identity and recovery flag — NEVER the lease token.
      const eventType = isRecovery ? 'run.recovered' : 'run.claimed';
      await tx.insert(schema.runEvents).values({
        companyId: run.company_id,
        projectId: run.project_id,
        runId: run.id,
        sequence: seq,
        type: eventType,
        schemaVersion: 1,
        payload: { workerId, isRecovery },
        actorType: 'system',
        actorId: workerId,
        traceId: null,
        occurredAt: now,
      });

      return {
        runId: run.id,
        companyId: run.company_id,
        projectId: run.project_id,
        leaseOwner: workerId,
        leaseToken,
        leaseExpiresAt,
        claimedFromStatus: run.status,
        status: newStatus,
        stateVersion: newVersion,
        lastEventSequence: seq,
        attemptCount: run.attempt_count,
        isRecovery,
      };
    });
  }

  /**
   * Renew the lease. Must be called while the lease is still valid.
   * Uses the run ID + lease token as a fencing condition: a stale worker
   * whose lease was claimed by another worker will fail (VAL-RUN-120).
   *
   * Returns the updated claim with the new expiry time. Throws
   * `LEASE_NOT_HELD` if the lease is no longer valid.
   */
  async renew(claim: Claim): Promise<Claim> {
    const now = this.now();
    const newExpiry = new Date(now.getTime() + this.leaseDurationMs());
    const schema = this.db.schema;

    // Use raw SQL for the conditional UPDATE (fencing check + lease expiry).
    const nowIso = now.toISOString();

    const result = await this.db.drizzle.execute(sql`
      UPDATE "mission_runs"
      SET "lease_expires_at" = ${newExpiry.toISOString()}::timestamptz,
          "heartbeat_at" = ${nowIso}::timestamptz,
          "updated_at" = ${nowIso}::timestamptz
      WHERE "id" = ${claim.runId}
        AND "lease_token" = ${claim.leaseToken}
        AND "lease_expires_at" > ${nowIso}::timestamptz
        AND "terminal_at" IS NULL
        AND "cancel_requested_at" IS NULL
      RETURNING "state_version", "last_event_sequence"
    `);

    const returned = result as unknown as Array<{
      state_version: number;
      last_event_sequence: number;
    }>;
    if (!returned || returned.length === 0) {
      throw new AppError(409, 'LEASE_NOT_HELD', 'Lease is no longer valid');
    }

    // Append run.lease_renewed event using Drizzle query builder.
    const row = returned[0];
    const seq = Number(row.last_event_sequence) + 1;
    const newVersion = row.state_version + 1;

    await this.db.drizzle
      .update(schema.missionRuns)
      .set({ stateVersion: newVersion, lastEventSequence: seq, updatedAt: now })
      .where(eq(schema.missionRuns.id, claim.runId));

    await this.db.drizzle.insert(schema.runEvents).values({
      companyId: claim.companyId,
      projectId: claim.projectId,
      runId: claim.runId,
      sequence: seq,
      type: 'run.lease_renewed',
      schemaVersion: 1,
      payload: { workerId: claim.leaseOwner },
      actorType: 'system',
      actorId: claim.leaseOwner,
      traceId: null,
      occurredAt: now,
    });

    return {
      ...claim,
      leaseExpiresAt: newExpiry,
      stateVersion: newVersion,
      lastEventSequence: seq,
    };
  }

  /**
   * Update the heartbeat without extending the lease. Throws
   * `LEASE_NOT_HELD` if the lease is no longer valid.
   */
  async heartbeat(claim: Claim): Promise<void> {
    const now = this.now();
    const nowIso = now.toISOString();

    const result = await this.db.drizzle.execute(sql`
      UPDATE "mission_runs"
      SET "heartbeat_at" = ${nowIso}::timestamptz,
          "updated_at" = ${nowIso}::timestamptz
      WHERE "id" = ${claim.runId}
        AND "lease_token" = ${claim.leaseToken}
        AND "lease_expires_at" > ${nowIso}::timestamptz
        AND "terminal_at" IS NULL
      RETURNING 1
    `);

    const returned = result as unknown as unknown[];
    if (!returned || returned.length === 0) {
      throw new AppError(409, 'LEASE_NOT_HELD', 'Lease is no longer valid');
    }
  }

  /**
   * Release the lease, returning the run to `queued` for re-claiming.
   * Throws `LEASE_NOT_HELD` if the lease is no longer valid.
   *
   * Used during graceful shutdown or when a worker cannot make progress
   * and wants to release the run without completing or failing it.
   */
  async release(claim: Claim): Promise<void> {
    const now = this.now();
    const nowIso = now.toISOString();

    const result = await this.db.drizzle.execute(sql`
      UPDATE "mission_runs"
      SET "lease_owner" = NULL,
          "lease_token" = NULL,
          "lease_expires_at" = NULL,
          "heartbeat_at" = NULL,
          "available_at" = ${nowIso}::timestamptz,
          "status" = 'queued',
          "updated_at" = ${nowIso}::timestamptz
      WHERE "id" = ${claim.runId}
        AND "lease_token" = ${claim.leaseToken}
        AND "terminal_at" IS NULL
      RETURNING 1
    `);

    const returned = result as unknown as unknown[];
    if (!returned || returned.length === 0) {
      // Lease may have already expired or been claimed by another worker.
      // This is acceptable during shutdown — the run is recoverable.
      // Only throw if the lease was genuinely held.
      const row = await this.db.drizzle.execute(sql`
        SELECT "lease_token", "terminal_at" FROM "mission_runs" WHERE "id" = ${claim.runId}
      `);
      const rows = row as unknown as Array<{
        lease_token: string | null;
        terminal_at: Date | null;
      }>;
      if (
        rows.length > 0 &&
        rows[0].lease_token === claim.leaseToken &&
        rows[0].terminal_at === null
      ) {
        throw new AppError(409, 'LEASE_NOT_HELD', 'Lease is no longer valid');
      }
      // If the lease was already taken by another worker or the run is
      // terminal, the release is a no-op (safe during shutdown).
    }
  }

  /**
   * Fenced mutation: verify that the given claim still holds the lease
   * on the run. Must be called inside a transaction that has locked the
   * run row with FOR UPDATE. Throws `LEASE_NOT_HELD` if the lease token
   * does not match (stale worker cannot commit, VAL-RUN-119, VAL-RUN-120).
   *
   * @param tx The transaction (with the run locked).
   * @param runId The run ID.
   * @param leaseToken The lease token from the claim.
   */
  async fence(tx: Tx, runId: string, leaseToken: string): Promise<void> {
    const rows = (await tx.execute(sql`
      SELECT "lease_token" FROM "mission_runs" WHERE "id" = ${runId}
    `)) as unknown as Array<{ lease_token: string | null }>;

    if (rows.length === 0) {
      throw new AppError(404, 'RUN_NOT_FOUND', 'Mission run not found');
    }

    if (rows[0].lease_token !== leaseToken) {
      throw new AppError(409, 'LEASE_NOT_HELD', 'Lease is no longer held by this worker');
    }
  }
}

export { LEASE_DURATION_MS, RENEWAL_INTERVAL_MS };
