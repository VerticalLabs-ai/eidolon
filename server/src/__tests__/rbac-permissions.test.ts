import { describe, expect, it } from 'vitest';
import {
  PERMISSION_MATRIX,
  getRoleFromPermissionLevel,
  hasPermission,
  type Permission,
  type Role,
} from '../middleware/permissions.js';

describe('RBAC permission matrix', () => {
  it('contains the complete permission set', () => {
    expect(Object.keys(PERMISSION_MATRIX)).toHaveLength(29);
    expect(PERMISSION_MATRIX['company.view']).toEqual(['owner', 'admin', 'member', 'viewer']);
    expect(PERMISSION_MATRIX['member.promote']).toEqual(['owner']);
  });

  it.each([
    ['owner', 'company.delete'],
    ['admin', 'company.settings.update'],
    ['member', 'artifact.create'],
    ['viewer', 'company.view'],
  ] satisfies [Role, Permission][])('allows %s at its boundary', (role, permission) => {
    expect(hasPermission(role, permission)).toBe(true);
  });

  it.each([
    ['viewer', 'artifact.update'],
    ['member', 'secrets.manage'],
    ['admin', 'company.delete'],
  ] satisfies [Role, Permission][])('denies %s for %s', (role, permission) => {
    expect(hasPermission(role, permission)).toBe(false);
  });

  it('maps numeric permission levels to roles', () => {
    expect(getRoleFromPermissionLevel(4)).toBe('owner');
    expect(getRoleFromPermissionLevel(3)).toBe('admin');
    expect(getRoleFromPermissionLevel(2)).toBe('member');
    expect(getRoleFromPermissionLevel(1)).toBe('viewer');
  });
});
