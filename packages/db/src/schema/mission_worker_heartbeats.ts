import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';

/**
 * Mission orchestration worker heartbeat registry.
 *
 * The orchestration worker is a separate portless process from the API.
 * Process-local memory is not visible across processes and is erased on
 * worker restart, so worker liveness is persisted to Postgres. Each worker
 * upserts its row on every poll cycle (bounded, ~2s by default). The
 * snapshot service derives `queueHealth` from the most recent heartbeat
 * age: a worker is considered unavailable when no heartbeat has been
 * recorded for at least 30 seconds (VAL-RUN-088).
 *
 * The table holds no tenant, run, user, prompt, or secret material — only
 * a safe worker identifier and timestamps. It is not tenant-scoped because
 * worker availability is a platform-level concern shared across all
 * companies/projects.
 */
export const missionWorkerHeartbeats = pgTable('mission_worker_heartbeats', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  /** Safe worker identifier (e.g., `worker-a1b2c3d4`). Never a lease token. */
  workerId: text('worker_id').notNull().unique(),
  /** Most recent heartbeat timestamp. */
  lastHeartbeatAt: timestamp('last_heartbeat_at', {
    mode: 'date',
    precision: 3,
    withTimezone: true,
  })
    .notNull()
    .$defaultFn(() => new Date()),
  createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
    .notNull()
    .$defaultFn(() => new Date()),
});
