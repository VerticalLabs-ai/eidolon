/**
 * Research scope enforcement (VAL-RES-073, VAL-RES-074).
 *
 * Every research read, mutation, source, revision, citation, artifact,
 * provenance, export, and deep link is scoped by company and project.
 * Cross-company and cross-project resource IDs return a non-enumerating
 * 404 that reveals nothing about the resource's actual scope, title, URL,
 * quote, provider ID hash, or artifact content.
 *
 * Phase 1 has no implicit cross-project artifact exception. Explicit future
 * sharing must use a separate grant contract and is out of scope.
 */

import { AppError } from '../../../middleware/error-handler.js';

// ---------------------------------------------------------------------------
// Resource types
// ---------------------------------------------------------------------------

/**
 * The types of research resources that are subject to scope enforcement.
 * Each is company-scoped; most are also project-scoped.
 */
export type ScopedResourceType =
  'run' | 'logical_call' | 'source' | 'source_revision' | 'citation' | 'artifact' | 'provenance';

/**
 * A research resource with its authoritative scope. The `companyId` is always
 * required. `projectId` may be null for company-scoped-only resources
 * (e.g. logical_call, provider health). Extra fields carry resource data that
 * must NOT leak through a scope denial.
 */
export interface ScopedResource {
  type: ScopedResourceType;
  companyId: string;
  projectId: string | null;
  id: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Non-enumerating 404
// ---------------------------------------------------------------------------

/**
 * Build a non-enumerating 404 error for a scoped resource access failure.
 *
 * The error never reveals whether the resource exists in another company or
 * project. The message is generic and does not include the resource type,
 * ID, actual scope, title, URL, quote, or any content.
 */
export function nonEnumerating404(): AppError {
  return new AppError(404, 'RESOURCE_NOT_FOUND', 'Resource not found');
}

// ---------------------------------------------------------------------------
// Scope assertion
// ---------------------------------------------------------------------------

/**
 * Assert that a research resource is within the requesting company and
 * project scope. Throws a non-enumerating 404 if the resource belongs to
 * a different company or project.
 *
 * The 404 is uniform whether the resource is absent, foreign, or wrong-project
 * — the caller cannot distinguish between these cases from the response.
 *
 * @param resource - The resource being accessed (with its authoritative scope).
 * @param requestingCompanyId - The company making the request.
 * @param requestingProjectId - The project making the request (optional for
 *   company-scoped-only routes).
 */
export function assertScopedResource(
  resource: ScopedResource,
  requestingCompanyId: string,
  requestingProjectId?: string,
): void {
  // 1. Company check: resource must belong to the requesting company.
  if (resource.companyId !== requestingCompanyId) {
    throw nonEnumerating404();
  }

  // 2. Project check: if the resource has a project, it must match the
  //    requesting project. Phase 1 has no implicit cross-project exception.
  if (
    resource.projectId !== null &&
    resource.projectId !== undefined &&
    requestingProjectId !== undefined &&
    resource.projectId !== requestingProjectId
  ) {
    throw nonEnumerating404();
  }
}

/**
 * Check whether a resource is within scope without throwing.
 * Returns true if the resource is in the requesting company and (when
 * applicable) project scope.
 */
export function isResourceInScope(
  resource: ScopedResource,
  requestingCompanyId: string,
  requestingProjectId?: string,
): boolean {
  if (resource.companyId !== requestingCompanyId) {
    return false;
  }
  if (
    resource.projectId !== null &&
    resource.projectId !== undefined &&
    requestingProjectId !== undefined &&
    resource.projectId !== requestingProjectId
  ) {
    return false;
  }
  return true;
}

/**
 * Filter an array of resources to only those in the requesting scope.
 * Used for list endpoints to ensure no cross-scope resources leak.
 */
export function filterScopedResources<T extends ScopedResource>(
  resources: T[],
  requestingCompanyId: string,
  requestingProjectId?: string,
): T[] {
  return resources.filter((r) => isResourceInScope(r, requestingCompanyId, requestingProjectId));
}
