/**
 * Research RBAC enforcement (VAL-RES-071, VAL-RES-072, VAL-RES-075).
 *
 * Centralized authorization for research operations. Every research
 * mutation and read is company/project/actor scoped. The actor is always
 * taken from authenticated server context, never from request payloads.
 *
 * - **Viewer** (`company.view`): may read source summaries, cited artifacts,
 *   provenance, events, and snapshots. Denied all mutations (start, cancel,
 *   retry, answer, revise, approve, reject).
 * - **Owner/admin/member** with `content.create`/`content.update`: may start
 *   and interact with research. Only owner/admin with `mission.approve` may
 *   approve or reject a research plan.
 * - **Agent API key**: may operate only if its scopes explicitly include the
 *   corresponding Mission research command and its company scope matches.
 *   No implicit elevation — an agent key cannot gain approval or
 *   restricted-source access from role alone.
 *
 * This module is a pure authorization decision. It does not resolve scope
 * (cross-company/cross-project isolation is handled by `scope.ts`), nor does
 * it touch credentials (handled by `credential-resolver.ts`).
 */

import { hasPermission, type Permission, type Role } from '../../../middleware/permissions.js';
import { AppError } from '../../../middleware/error-handler.js';

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export type ResearchReadOperation =
  | 'research.read_sources'
  | 'research.read_artifacts'
  | 'research.read_provenance'
  | 'research.read_events'
  | 'research.read_snapshot';

export type ResearchMutationOperation =
  | 'research.start'
  | 'research.cancel'
  | 'research.retry'
  | 'research.answer'
  | 'research.revise'
  | 'research.approve'
  | 'research.reject';

export type ResearchOperation = ResearchReadOperation | ResearchMutationOperation;

// ---------------------------------------------------------------------------
// Permission mapping
// ---------------------------------------------------------------------------

/**
 * Maps each research operation to the permission required to perform it.
 * This is consistent with the declared Mission mutation matrix
 * (`mutation-matrix.ts`):
 * - start/cancel/retry → `content.create`
 * - answer/revise → `content.update`
 * - approve/reject → `mission.approve`
 * - all reads → `company.view`
 */
export const RESEARCH_OPERATION_PERMISSIONS: Record<ResearchOperation, Permission> = {
  'research.start': 'content.create',
  'research.cancel': 'content.create',
  'research.retry': 'content.create',
  'research.answer': 'content.update',
  'research.revise': 'content.update',
  'research.approve': 'mission.approve',
  'research.reject': 'mission.approve',
  'research.read_sources': 'company.view',
  'research.read_artifacts': 'company.view',
  'research.read_provenance': 'company.view',
  'research.read_events': 'company.view',
  'research.read_snapshot': 'company.view',
};

// ---------------------------------------------------------------------------
// Agent key scope mapping
// ---------------------------------------------------------------------------

/**
 * Agent API key scopes that authorize research operations. An agent key must
 * have the exact scope for the operation it attempts; no implicit elevation.
 *
 * `mission.approve` and `mission.reject` have NO agent key scope — agent keys
 * can never approve or reject a research plan, regardless of role.
 */
const AGENT_KEY_SCOPES: Record<ResearchMutationOperation, string | null> = {
  'research.start': 'mission.research.run',
  'research.cancel': 'mission.research.run',
  'research.retry': 'mission.research.run',
  'research.answer': 'mission.research.answer',
  'research.revise': 'mission.research.answer',
  'research.approve': null, // Never allowed for agent keys
  'research.reject': null, // Never allowed for agent keys
};

// ---------------------------------------------------------------------------
// Actor
// ---------------------------------------------------------------------------

/**
 * The authenticated actor attempting a research operation.
 *
 * For `actorType: 'user'`, the role and company come from authenticated
 * server context (Clerk session or local_trusted).
 *
 * For `actorType: 'agent'`, the role and company come from the agent API key
 * record, and `agentKeyScopes` lists the explicit command scopes on the key.
 */
export interface ResearchActor {
  actorType: 'user' | 'agent' | 'system';
  actorId: string;
  role: Role;
  /** Company the actor is authenticated for. */
  companyId: string;
  /** Agent API key scopes (only for `actorType: 'agent'`). */
  agentKeyScopes?: string[];
  /** Company the agent API key belongs to (only for `actorType: 'agent'`). */
  agentKeyCompanyId?: string;
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

export function isResearchReadOperation(op: string): op is ResearchReadOperation {
  return op.startsWith('research.read_');
}

export function isResearchMutationOperation(op: string): op is ResearchMutationOperation {
  return (
    op === 'research.start' ||
    op === 'research.cancel' ||
    op === 'research.retry' ||
    op === 'research.answer' ||
    op === 'research.revise' ||
    op === 'research.approve' ||
    op === 'research.reject'
  );
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/**
 * Authorize a research operation for the given actor against the target
 * company. Throws `403 INSUFFICIENT_PERMISSION` if denied. Returns void
 * if authorized.
 *
 * @param actor - The authenticated actor (from server context, never payload).
 * @param operation - The research operation to authorize.
 * @param targetCompanyId - The company the target resource belongs to.
 */
export function authorizeResearchOperation(
  actor: ResearchActor,
  operation: ResearchOperation,
  targetCompanyId: string,
): void {
  // 1. Company scope: actor must belong to the target company.
  //    For agent keys, the key's company must match.
  const actorCompany =
    actor.actorType === 'agent' ? (actor.agentKeyCompanyId ?? actor.companyId) : actor.companyId;
  if (actorCompany !== targetCompanyId) {
    throw new AppError(403, 'INSUFFICIENT_PERMISSION', 'Not authorized for this company');
  }

  // 2. System actors bypass permission checks (internal orchestration only).
  if (actor.actorType === 'system') {
    return;
  }

  // 3. Permission check: role must have the required permission.
  const requiredPermission = RESEARCH_OPERATION_PERMISSIONS[operation];
  if (!hasPermission(actor.role, requiredPermission)) {
    throw new AppError(
      403,
      'INSUFFICIENT_PERMISSION',
      'Insufficient permission for this operation',
    );
  }

  // 4. Agent key scope check: agent keys need the exact command scope.
  //    No implicit elevation — an agent key cannot approve/reject even
  //    with an admin role, and cannot gain restricted-source access.
  if (actor.actorType === 'agent' && isResearchMutationOperation(operation)) {
    const requiredScope = AGENT_KEY_SCOPES[operation];
    if (requiredScope === null) {
      // approve/reject: never allowed for agent keys
      throw new AppError(
        403,
        'INSUFFICIENT_PERMISSION',
        'Agent keys cannot perform this operation',
      );
    }
    const scopes = actor.agentKeyScopes ?? [];
    if (!scopes.includes(requiredScope)) {
      throw new AppError(403, 'INSUFFICIENT_PERMISSION', 'Agent key lacks required scope');
    }
  }
}
