import { z } from 'zod';

/**
 * Per-resource access levels (M4 RBAC).
 *
 * - `view` — read-only access to a resource (GET).
 * - `edit` — read + content/title edits (PATCH content). Cannot delete,
 *   archive, or manage permissions.
 * - `manage` — edit + delete/archive + grant/revoke permissions on the
 *   resource.
 */
export const AccessLevelSchema = z.enum(['view', 'edit', 'manage']);
export type AccessLevel = z.infer<typeof AccessLevelSchema>;

/** The kind of resource a permission applies to. */
export const PermissionResourceTypeSchema = z.enum(['project', 'folder', 'artifact']);
export type PermissionResourceType = z.infer<typeof PermissionResourceTypeSchema>;

/** Whether a grantee is an individual user or a team. */
export const GranteeTypeSchema = z.enum(['user', 'team']);
export type GranteeType = z.infer<typeof GranteeTypeSchema>;

/** Body for granting a permission (POST /permissions). */
export const GrantPermissionBodySchema = z.object({
  resourceType: PermissionResourceTypeSchema,
  resourceId: z.string().min(1),
  granteeType: GranteeTypeSchema,
  granteeId: z.string().min(1),
  accessLevel: AccessLevelSchema,
});
export type GrantPermissionBody = z.infer<typeof GrantPermissionBodySchema>;

/** Query for listing permissions on a resource. */
export const ListPermissionsQuerySchema = z.object({
  resourceType: PermissionResourceTypeSchema,
  resourceId: z.string().min(1),
});
export type ListPermissionsQuery = z.infer<typeof ListPermissionsQuerySchema>;

/** Body for creating a team. */
export const CreateTeamBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
});
export type CreateTeamBody = z.infer<typeof CreateTeamBodySchema>;

/** Body for adding a team member. */
export const AddTeamMemberBodySchema = z.object({
  userId: z.string().min(1),
});
export type AddTeamMemberBody = z.infer<typeof AddTeamMemberBodySchema>;
