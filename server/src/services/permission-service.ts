import { and, eq, inArray, or } from 'drizzle-orm';
import { AppError } from '../middleware/error-handler.js';
import eventBus from '../realtime/events.js';
import { getFolder } from './folder-service.js';
import { getUserTeamIds } from './team-service.js';
import { validateProjectOwnership } from '../utils/project-validation.js';
import type { DbInstance } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AccessLevel = 'view' | 'edit' | 'manage';
export type ResourceKind = 'project' | 'folder' | 'artifact';
export type GranteeKind = 'user' | 'team';

const LEVEL_RANK: Record<AccessLevel, number> = { view: 1, edit: 2, manage: 3 };

type PermissionRow = {
  id: string;
  companyId: string;
  resourceType: string;
  resourceId: string;
  granteeType: string;
  granteeId: string;
  accessLevel: string;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

// ---------------------------------------------------------------------------
// Event emission
// ---------------------------------------------------------------------------

function emitPermission(type: 'permission.granted' | 'permission.revoked', companyId: string, payload: Record<string, unknown>) {
  eventBus.emitEvent({ type, companyId, payload, timestamp: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Resource chain construction (artifact → folder → project)
// ---------------------------------------------------------------------------

/**
 * Build the chain of resources from most specific to least specific for
 * permission resolution. For an artifact: [artifact, folder?, project?].
 * For a folder: [folder, parent folder?, ..., project?]. For a project: [project].
 *
 * Each entry is `{ resourceType, resourceId }`. The chain is used to walk
 * from the specific resource up through ancestors when resolving effective
 * access.
 */
async function buildResourceChain(
  db: DbInstance,
  companyId: string,
  resourceType: ResourceKind,
  resourceId: string,
): Promise<{ resourceType: ResourceKind; resourceId: string }[]> {
  const chain: { resourceType: ResourceKind; resourceId: string }[] = [{ resourceType, resourceId }];

  if (resourceType === 'artifact') {
    // Look up the artifact's folderId and projectId.
    const [artifact] = await db.drizzle
      .select({ folderId: db.schema.artifacts.folderId, projectId: db.schema.artifacts.projectId })
      .from(db.schema.artifacts)
      .where(and(eq(db.schema.artifacts.id, resourceId), eq(db.schema.artifacts.companyId, companyId)));
    if (!artifact) return chain; // artifact not found — caller will 404
    // Walk up through folders.
    if (artifact.folderId) {
      await walkFolderChain(db, companyId, artifact.folderId, chain);
    }
    // If the artifact has a projectId, add it to the chain (project level).
    if (artifact.projectId) {
      chain.push({ resourceType: 'project', resourceId: artifact.projectId });
    }
  } else if (resourceType === 'folder') {
    await walkFolderChain(db, companyId, resourceId, chain);
    // After walking folders, check if the topmost folder has a projectId.
    const topFolder = chain[chain.length - 1];
    if (topFolder.resourceType === 'folder') {
      const [folder] = await db.drizzle
        .select({ projectId: db.schema.artifactFolders.projectId })
        .from(db.schema.artifactFolders)
        .where(and(eq(db.schema.artifactFolders.id, topFolder.resourceId), eq(db.schema.artifactFolders.companyId, companyId)));
      if (folder?.projectId) {
        chain.push({ resourceType: 'project', resourceId: folder.projectId });
      }
    }
  }
  // For 'project', the chain is just [project] — no ancestors.

  return chain;
}

/** Walk up the folder parent chain, appending each folder to the chain. */
async function walkFolderChain(
  db: DbInstance,
  companyId: string,
  folderId: string,
  chain: { resourceType: ResourceKind; resourceId: string }[],
): Promise<void> {
  let currentId: string | null = folderId;
  const visited = new Set<string>();
  for (let depth = 0; depth < 256 && currentId; depth++) {
    if (visited.has(currentId)) break; // cycle guard
    visited.add(currentId);
    chain.push({ resourceType: 'folder', resourceId: currentId });
    const [folder] = await db.drizzle
      .select({ parentId: db.schema.artifactFolders.parentId })
      .from(db.schema.artifactFolders)
      .where(and(eq(db.schema.artifactFolders.id, currentId), eq(db.schema.artifactFolders.companyId, companyId)));
    if (!folder) break;
    currentId = folder.parentId;
  }
}

// ---------------------------------------------------------------------------
// Permission queries
// ---------------------------------------------------------------------------

/**
 * Get all permission records for a specific resource (any grantee).
 * Used to determine if a resource is "restricted" (has any grants).
 */
async function getAllPermissionsForResource(
  db: DbInstance,
  companyId: string,
  resourceType: ResourceKind,
  resourceId: string,
): Promise<PermissionRow[]> {
  const rows = await db.drizzle.select().from(db.schema.artifactPermissions)
    .where(and(
      eq(db.schema.artifactPermissions.companyId, companyId),
      eq(db.schema.artifactPermissions.resourceType, resourceType),
      eq(db.schema.artifactPermissions.resourceId, resourceId),
    ));
  return rows as PermissionRow[];
}

/**
 * Get all permission records that apply to a specific user on a specific
 * resource — both direct user grants and team grants (for teams the user
 * belongs to).
 */
async function getPermissionsForUserOnResource(
  db: DbInstance,
  companyId: string,
  userId: string,
  resourceType: ResourceKind,
  resourceId: string,
): Promise<PermissionRow[]> {
  const teamIds = await getUserTeamIds(db, companyId, userId);
  const baseConditions = [
    eq(db.schema.artifactPermissions.companyId, companyId),
    eq(db.schema.artifactPermissions.resourceType, resourceType),
    eq(db.schema.artifactPermissions.resourceId, resourceId),
  ];
  // Build grantee condition: direct user grant OR team grants.
  const granteeConditions: ReturnType<typeof eq>[] = [
    and(eq(db.schema.artifactPermissions.granteeType, 'user'), eq(db.schema.artifactPermissions.granteeId, userId))!,
  ];
  for (const teamId of teamIds) {
    granteeConditions.push(
      and(eq(db.schema.artifactPermissions.granteeType, 'team'), eq(db.schema.artifactPermissions.granteeId, teamId))!,
    );
  }
  const rows = await db.drizzle.select().from(db.schema.artifactPermissions)
    .where(and(...baseConditions, or(...granteeConditions)!));
  return rows as PermissionRow[];
}

// ---------------------------------------------------------------------------
// Permission resolution (the core RBAC engine)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective access level for a user on a resource.
 *
 * Algorithm:
 * 1. If the user's org role is owner or admin → 'manage' (owner/admin
 *    manage all — VAL-TEAM-014/015).
 * 2. Build the resource chain (most specific → least specific).
 * 3. Check if any level in the chain has any permission grants
 *    (isRestricted). If NOT restricted → default access by org role:
 *    member=edit, viewer=view (open resources — backward compatible).
 * 4. If restricted → walk from most specific to least specific. The FIRST
 *    level with grants for this user determines the access level (specific
 *    grant overrides inherited — VAL-TEAM-013). Take the max of all grants
 *    at that level (combining direct + team grants).
 * 5. If restricted but no grant found for the user at any level → null
 *    (no access — VAL-TEAM-006).
 *
 * Returns 'view' | 'edit' | 'manage' | null (null = no access).
 */
export async function resolveAccess(
  db: DbInstance,
  companyId: string,
  userId: string,
  orgRole: string,
  resourceType: ResourceKind,
  resourceId: string,
): Promise<AccessLevel | null> {
  // 1. Owner/admin manage all.
  if (orgRole === 'owner' || orgRole === 'admin') return 'manage';

  // 2. Build the resource chain.
  const chain = await buildResourceChain(db, companyId, resourceType, resourceId);

  // 3. Check if any level is restricted.
  let isRestricted = false;
  for (const level of chain) {
    const allPerms = await getAllPermissionsForResource(db, companyId, level.resourceType, level.resourceId);
    if (allPerms.length > 0) {
      isRestricted = true;
      break;
    }
  }

  // 4. If not restricted → default access by org role (backward compatible).
  if (!isRestricted) {
    if (orgRole === 'member') return 'edit';
    if (orgRole === 'viewer') return 'view';
    return null;
  }

  // 5. Restricted: walk from most specific to least specific.
  for (const level of chain) {
    const userPerms = await getPermissionsForUserOnResource(db, companyId, userId, level.resourceType, level.resourceId);
    if (userPerms.length > 0) {
      // Take the max access level among all matching grants at this level.
      const maxLevel = userPerms.reduce((max, p) => {
        const rank = LEVEL_RANK[p.accessLevel as AccessLevel] ?? 0;
        return rank > LEVEL_RANK[max] ? p.accessLevel as AccessLevel : max;
      }, 'view' as AccessLevel);
      return maxLevel;
    }
  }

  // 6. Restricted but no grant for this user.
  return null;
}

/**
 * Require at least the given access level. Throws 403 if the user's
 * effective access is below the required level (or null = no access).
 */
export async function requireAccess(
  db: DbInstance,
  companyId: string,
  userId: string,
  orgRole: string,
  resourceType: ResourceKind,
  resourceId: string,
  required: AccessLevel,
): Promise<AccessLevel> {
  const effective = await resolveAccess(db, companyId, userId, orgRole, resourceType, resourceId);
  if (effective === null) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have access to this resource');
  }
  if (LEVEL_RANK[effective] < LEVEL_RANK[required]) {
    throw new AppError(403, 'INSUFFICIENT_ACCESS', `This action requires ${required} access`);
  }
  return effective;
}

// ---------------------------------------------------------------------------
// Permission CRUD (grant/revoke/list)
// ---------------------------------------------------------------------------

/**
 * Validate that a resource belongs to the given company. Throws 400/404
 * if the resource is cross-company or missing.
 */
async function validateResourceOwnership(
  db: DbInstance,
  companyId: string,
  resourceType: ResourceKind,
  resourceId: string,
): Promise<void> {
  if (resourceType === 'project') {
    await validateProjectOwnership(db, companyId, resourceId);
  } else if (resourceType === 'folder') {
    await getFolder(db, companyId, resourceId); // throws 404 if cross-company
  } else if (resourceType === 'artifact') {
    const [artifact] = await db.drizzle.select({ id: db.schema.artifacts.id })
      .from(db.schema.artifacts)
      .where(and(eq(db.schema.artifacts.id, resourceId), eq(db.schema.artifacts.companyId, companyId)));
    if (!artifact) throw new AppError(404, 'ARTIFACT_NOT_FOUND', 'Artifact not found');
  }
}

/**
 * Grant a permission on a resource to a user or team. Upserts: if a grant
 * already exists for the same (resource, grantee), updates the access level.
 *
 * Caller must have manage access on the resource (or be owner/admin —
 * enforced by the route handler).
 */
export async function grantPermission(
  db: DbInstance,
  companyId: string,
  resourceType: ResourceKind,
  resourceId: string,
  granteeType: GranteeKind,
  granteeId: string,
  accessLevel: AccessLevel,
  userId: string | null,
): Promise<PermissionRow> {
  // Validate the resource belongs to the company.
  await validateResourceOwnership(db, companyId, resourceType, resourceId);

  // Validate the grantee belongs to the company.
  if (granteeType === 'team') {
    // Team must belong to the company.
    const [team] = await db.drizzle.select({ id: db.schema.teams.id })
      .from(db.schema.teams)
      .where(and(eq(db.schema.teams.id, granteeId), eq(db.schema.teams.companyId, companyId)));
    if (!team) throw new AppError(400, 'GRANTEE_INVALID', 'Team does not belong to this company');
  }
  // For user grants, we don't strictly validate company membership (the user
  // may be a Clerk org member not tracked in our DB). Cross-company user ids
  // simply won't resolve to anything useful.

  const p = db.schema.artifactPermissions;
  // Upsert: insert or update the access level.
  const [row] = await db.drizzle.insert(p).values({
    companyId, resourceType, resourceId, granteeType, granteeId, accessLevel,
    createdByUserId: userId,
  }).onConflictDoUpdate({
    target: [p.companyId, p.resourceType, p.resourceId, p.granteeType, p.granteeId],
    set: { accessLevel, updatedAt: new Date() },
  }).returning();
  const perm = row as PermissionRow;
  emitPermission('permission.granted', companyId, { permission: perm });
  return perm;
}

/**
 * Revoke a permission on a resource for a grantee. Removes the record
 * entirely (VAL-TEAM-020).
 */
export async function revokePermission(
  db: DbInstance,
  companyId: string,
  resourceType: ResourceKind,
  resourceId: string,
  granteeType: GranteeKind,
  granteeId: string,
): Promise<void> {
  await db.drizzle.delete(db.schema.artifactPermissions).where(and(
    eq(db.schema.artifactPermissions.companyId, companyId),
    eq(db.schema.artifactPermissions.resourceType, resourceType),
    eq(db.schema.artifactPermissions.resourceId, resourceId),
    eq(db.schema.artifactPermissions.granteeType, granteeType),
    eq(db.schema.artifactPermissions.granteeId, granteeId),
  ));
  emitPermission('permission.revoked', companyId, { resourceType, resourceId, granteeType, granteeId });
}

/**
 * List all permission records on a resource. Filters out orphaned team
 * permissions (where the team has been deleted) so the list reflects only
 * effective grants (VAL-TEAM-022).
 */
export async function listPermissions(
  db: DbInstance,
  companyId: string,
  resourceType: ResourceKind,
  resourceId: string,
): Promise<PermissionRow[]> {
  await validateResourceOwnership(db, companyId, resourceType, resourceId);
  const rows = await db.drizzle.select().from(db.schema.artifactPermissions)
    .where(and(
      eq(db.schema.artifactPermissions.companyId, companyId),
      eq(db.schema.artifactPermissions.resourceType, resourceType),
      eq(db.schema.artifactPermissions.resourceId, resourceId),
    ))
    .orderBy(db.schema.artifactPermissions.createdAt);
  // Filter out orphaned team permissions (team deleted → cascade removed
  // the teams row, but the permission record remains as a tombstone).
  const teamIds = rows.filter((r) => r.granteeType === 'team').map((r) => r.granteeId);
  let validTeamIds = new Set<string>();
  if (teamIds.length > 0) {
    const teams = await db.drizzle.select({ id: db.schema.teams.id })
      .from(db.schema.teams)
      .where(and(eq(db.schema.teams.companyId, companyId), inArray(db.schema.teams.id, teamIds)));
    validTeamIds = new Set(teams.map((t) => t.id));
  }
  return (rows as PermissionRow[]).filter(
    (r) => r.granteeType !== 'team' || validTeamIds.has(r.granteeId),
  );
}

// ---------------------------------------------------------------------------
// Bulk filtering for list endpoints (hide no-access artifacts)
// ---------------------------------------------------------------------------

/**
 * Filter a list of artifact ids to those the user can access at the given
 * level. Used by the artifact list endpoint to hide no-access artifacts
 * (VAL-TEAM-006/017: hidden vs forbidden).
 *
 * For owner/admin, all artifacts pass. For member/viewer, open (unrestricted)
 * artifacts pass, and restricted artifacts pass only if the user has a grant
 * at the required level.
 *
 * To keep this efficient, we do a single query for all permissions in the
 * company that touch any of the artifact ids OR their parent folders/projects,
 * then resolve each artifact individually using the cached data.
 */
export async function filterAccessibleArtifacts(
  db: DbInstance,
  companyId: string,
  userId: string,
  orgRole: string,
  artifactIds: string[],
  required: AccessLevel,
): Promise<string[]> {
  if (artifactIds.length === 0) return [];
  if (orgRole === 'owner' || orgRole === 'admin') return artifactIds;

  // Fetch all artifacts' folderId + projectId for chain construction.
  const artifacts = await db.drizzle
    .select({
      id: db.schema.artifacts.id,
      folderId: db.schema.artifacts.folderId,
      projectId: db.schema.artifacts.projectId,
    })
    .from(db.schema.artifacts)
    .where(and(
      eq(db.schema.artifacts.companyId, companyId),
      inArray(db.schema.artifacts.id, artifactIds),
    ));

  const accessible: string[] = [];
  for (const artifact of artifacts) {
    const level = await resolveAccess(db, companyId, userId, orgRole, 'artifact', artifact.id);
    if (level !== null && LEVEL_RANK[level] >= LEVEL_RANK[required]) {
      accessible.push(artifact.id);
    }
  }
  return accessible;
}
