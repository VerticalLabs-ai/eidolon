import { eq, and } from 'drizzle-orm';
import { AppError } from '../middleware/error-handler.js';
import type { DbInstance } from '../types.js';

/**
 * Validate that a projectId belongs to the given company.
 *
 * - Returns `null` when `projectId` is `null` or `undefined` (unscoped is valid).
 * - Returns the project row when the project exists and belongs to `companyId`.
 * - Throws `PROJECT_INVALID` (HTTP 404) when the project does not exist or
 *   belongs to a different company.
 *
 * This is the single canonical ownership check used by every endpoint that
 * accepts an optional `projectId` for independent project assignment.
 */
export async function validateProjectOwnership(
  db: DbInstance,
  companyId: string,
  projectId: string | null | undefined,
): Promise<{ id: string; companyId: string; name: string } | null> {
  if (projectId === null || projectId === undefined) {
    return null;
  }

  const { projects } = db.schema;
  const [project] = await db.drizzle
    .select({
      id: projects.id,
      companyId: projects.companyId,
      name: projects.name,
    })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
    .limit(1);

  if (!project) {
    throw new AppError(
      404,
      'PROJECT_INVALID',
      'Choose a project from this company.',
    );
  }

  return project;
}
