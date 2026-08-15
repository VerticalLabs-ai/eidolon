// Permission-based UI visibility
//
// Mirrors the server-side permission matrix from
// server/src/middleware/permissions.ts so the UI can show/hide controls
// without a round-trip. The server is always the source of truth — this
// matrix only controls visibility, not enforcement.

import { useMyRole } from './hooks';
import type { Role } from './api';

export type Permission =
  | 'company.view'
  | 'artifact.create'
  | 'artifact.update'
  | 'artifact.delete'
  | 'task.create'
  | 'task.update'
  | 'task.delete'
  | 'project.create'
  | 'project.update'
  | 'agent.manage'
  | 'chat.participate'
  | 'content.create'
  | 'content.update'
  | 'content.delete'
  | 'member.invite'
  | 'member.promote'
  | 'member.remove'
  | 'member.list'
  | 'company.settings.update'
  | 'company.export'
  | 'company.delete'
  | 'secrets.manage'
  | 'integrations.manage'
  | 'mcp.manage'
  | 'webhooks.manage'
  | 'sessions.manage'
  | 'skills.manage'
  | 'environments.manage'
  | 'apikeys.manage';

const ALL_ROLES: Role[] = ['owner', 'admin', 'member', 'viewer'];
const CONTRIBUTOR_ROLES: Role[] = ['owner', 'admin', 'member'];
const ADMIN_ROLES: Role[] = ['owner', 'admin'];

const PERMISSION_MATRIX: Record<Permission, Role[]> = {
  'company.view': ALL_ROLES,
  'artifact.create': CONTRIBUTOR_ROLES,
  'artifact.update': CONTRIBUTOR_ROLES,
  'artifact.delete': CONTRIBUTOR_ROLES,
  'task.create': CONTRIBUTOR_ROLES,
  'task.update': CONTRIBUTOR_ROLES,
  'task.delete': CONTRIBUTOR_ROLES,
  'project.create': CONTRIBUTOR_ROLES,
  'project.update': CONTRIBUTOR_ROLES,
  'agent.manage': CONTRIBUTOR_ROLES,
  'chat.participate': CONTRIBUTOR_ROLES,
  'content.create': CONTRIBUTOR_ROLES,
  'content.update': CONTRIBUTOR_ROLES,
  'content.delete': CONTRIBUTOR_ROLES,
  'member.invite': ADMIN_ROLES,
  'member.promote': ['owner'],
  'member.remove': ADMIN_ROLES,
  'member.list': ALL_ROLES,
  'company.settings.update': ADMIN_ROLES,
  'company.export': ADMIN_ROLES,
  'company.delete': ['owner'],
  'secrets.manage': ADMIN_ROLES,
  'integrations.manage': ADMIN_ROLES,
  'mcp.manage': ADMIN_ROLES,
  'webhooks.manage': ADMIN_ROLES,
  'sessions.manage': ADMIN_ROLES,
  'skills.manage': ADMIN_ROLES,
  'environments.manage': ADMIN_ROLES,
  'apikeys.manage': ADMIN_ROLES,
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return PERMISSION_MATRIX[permission]?.includes(role) ?? false;
}

/**
 * usePermission — fetches the current user's role for a company and exposes
 * a `hasPermission` helper for conditional UI rendering.
 */
export function usePermission(companyId: string | undefined) {
  const { data: role, isLoading, isError } = useMyRole(companyId);

  return {
    role: role ?? null,
    isLoading,
    isError,
    hasPermission: (permission: Permission): boolean => {
      if (!role) {return false;}
      return hasPermission(role, permission);
    },
  };
}
