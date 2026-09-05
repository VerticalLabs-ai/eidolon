import { sql } from 'drizzle-orm';
import type { DbInstance } from '../../types.js';
/**
 * MissionWorkerHealthService — durable worker liveness for queueHealth.
 *
 * The orchestration worker is a separate portless process from the API, so
 * process-local memory cannot communicate worker liveness to the snapshot
 * service. This service persists worker heartbeats to Postgres and derives
 * `queueHealth` from the most recent heartbeat age.
 *
 * A worker is considered available when at least one heartbeat has been
 * recorded within the staleness window (default 30 seconds, per VAL-RUN-088).
 * When no heartbeat is recent (e.g., the worker is stopped, crashed, or has
 * not yet started), `queueHealth` is `"unavailable"`.
 *
 * The table holds only a safe worker identifier and timestamps — never
 * lease tokens, secrets, tenant, run, or prompt material. Worker
 * availability is a platform-level concern shared across all companies and
 * projects, so the registry is not tenant-scoped.
 */

/** Default staleness window: no heartbeat for >=30s means unavailable. */
export const WORKER_HEARTBEAT_STALE_MS = 30_000;

export interface WorkerHealthDeps {
  /** Override the clock for deterministic tests. */
  clock?: () => Date;
  /** Override the staleness window (ms). Default 30_000. */
  staleMs?: number;
}

export type QueueHealth = 'available' | 'unavailable';

export class MissionWorkerHealthService {
  constructor(
    private db: DbInstance,
    private deps: WorkerHealthDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  private staleMs(): number {
    return this.deps.staleMs ?? WORKER_HEARTBEAT_STALE_MS;
  }

  /**
   * Record (upsert) a heartbeat for the given worker. Called by the
   * orchestration worker on every poll cycle so liveness stays fresh while
   * the worker is running. Idempotent: a repeated heartbeat for the same
   * worker updates `last_heartbeat_at`.
   */
  async recordHeartbeat(workerId: string): Promise<void> {
    const now = this.now();
    const schema = this.db.schema;
    // Upsert by worker_id (unique). The Drizzle query builder applies the
    // JS-side $defaultFn for the primary key id. ON CONFLICT updates only
    // the heartbeat and updated_at timestamps — never the worker_id or id.
    await this.db.drizzle
      .insert(schema.missionWorkerHeartbeats)
      .values({
        workerId,
        lastHeartbeatAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.missionWorkerHeartbeats.workerId,
        set: {
          lastHeartbeatAt: now,
          updatedAt: now,
        },
      });
  }

  /**
   * Derive `queueHealth` from the most recent worker heartbeat age. Returns
   * `"available"` when at least one heartbeat was recorded within the
   * staleness window, otherwise `"unavailable"`. Used by the snapshot
   * serializer so the browser never infers worker unavailability from a
   * local timer (VAL-RUN-088).
   */
  async queueHealth(): Promise<QueueHealth> {
    const now = this.now();
    const staleMs = this.staleMs();
    const threshold = new Date(now.getTime() - staleMs);
    const thresholdIso = threshold.toISOString();

    const result = (await this.db.drizzle.execute(sql`
      SELECT 1 FROM "mission_worker_heartbeats"
      WHERE "last_heartbeat_at" >= ${thresholdIso}::timestamptz
      LIMIT 1
    `)) as unknown as Array<Record<string, unknown>>;

    return result && result.length > 0 ? 'available' : 'unavailable';
  }
}
