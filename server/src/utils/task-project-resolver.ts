import { and, eq } from 'drizzle-orm';
import { tasks, projects } from '@eidolon/db';
import type { DbInstance } from '../types.js';

/**
 * Query executor type that accepts either the main Drizzle instance or a
 * transaction client. Both expose the same `select` entry point.
 */
type QueryExecutor = Pick<DbInstance['drizzle'], 'select'>;

/**
 * Resolve a task's effective `project_id` through a same-company join to
 * `projects`.
 *
 * `tasks.project_id` has no FK constraint, so it may hold stale, deleted, or
 * cross-company project IDs. By LEFT JOINing to `projects` on both `id` AND
 * `company_id`, only resolvable same-company project IDs are returned; all
 * others yield `null`. This prevents FK violations when the resolved value is
 * inserted into tables that do have a FK to `projects.id`.
 *
 * Accepts either the main Drizzle instance (`db.drizzle`) or a transaction
 * client (`tx`), so it can be used inside and outside transaction blocks.
 */
export async function resolveTaskProjectId(
  executor: QueryExecutor,
  companyId: string,
  taskId: string,
): Promise<string | null> {
  const [row] = await executor
    .select({ projectId: projects.id })
    .from(tasks)
    .leftJoin(
      projects,
      and(eq(projects.id, tasks.projectId), eq(projects.companyId, tasks.companyId)),
    )
    .where(and(eq(tasks.id, taskId), eq(tasks.companyId, companyId)))
    .limit(1);
  return row?.projectId ?? null;
}
