import { and, eq } from 'drizzle-orm';
import { AppError } from '../middleware/error-handler.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';
type Team = {
  id: string;
  companyId: string;
  name: string;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type TeamMember = {
  id: string;
  teamId: string;
  userId: string;
  createdAt: Date;
};

function emitTeam(type: 'team.created' | 'team.updated' | 'team.deleted', companyId: string, team: unknown) {
  eventBus.emitEvent({ type, companyId, payload: { team }, timestamp: new Date().toISOString() });
}

function emitMember(type: 'team.member.added' | 'team.member.removed', companyId: string, teamId: string, userId: string) {
  eventBus.emitEvent({ type, companyId, payload: { teamId, userId }, timestamp: new Date().toISOString() });
}

/** Get a team, validating company scoping. Throws 404 if not found / cross-company. */
export async function getTeam(db: DbInstance, companyId: string, teamId: string): Promise<Team> {
  const [team] = await db.drizzle.select().from(db.schema.teams)
    .where(and(eq(db.schema.teams.id, teamId), eq(db.schema.teams.companyId, companyId)));
  if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found');
  return team as Team;
}

/** Create a team within a company. Caller must have admin/owner role (enforced by route). */
export async function createTeam(db: DbInstance, companyId: string, name: string, userId: string | null): Promise<Team> {
  const trimmed = name.trim();
  if (!trimmed) throw new AppError(400, 'VALIDATION_ERROR', 'Team name is required');
  if (trimmed.length > 200) throw new AppError(400, 'VALIDATION_ERROR', 'Team name must be 200 characters or fewer');
  const [row] = await db.drizzle.insert(db.schema.teams).values({
    companyId, name: trimmed, createdByUserId: userId,
  }).returning();
  const team = row as Team;
  emitTeam('team.created', companyId, team);
  return team;
}

/** List all teams in a company. */
export async function listTeams(db: DbInstance, companyId: string): Promise<Team[]> {
  const rows = await db.drizzle.select().from(db.schema.teams)
    .where(eq(db.schema.teams.companyId, companyId))
    .orderBy(db.schema.teams.name);
  return rows as Team[];
}

/** Delete a team. Cascades to team_members and cleans up the team's
 * permission records so resources do not remain permanently restricted
 * by orphaned tombstones (VAL-TEAM-022). Without this cleanup, the
 * permission records would keep `isRestricted=true` on resources that
 * no longer have any active grantee, locking them for all non-admin users. */
export async function deleteTeam(db: DbInstance, companyId: string, teamId: string): Promise<void> {
  await getTeam(db, companyId, teamId);
  // Delete the team's permission records first (within the same DB operation
  // batch) so resources are no longer restricted by the deleted team's grants.
  await db.drizzle.delete(db.schema.artifactPermissions)
    .where(and(
      eq(db.schema.artifactPermissions.companyId, companyId),
      eq(db.schema.artifactPermissions.granteeType, 'team'),
      eq(db.schema.artifactPermissions.granteeId, teamId),
    ));
  // Cascade on team_members removes all memberships.
  await db.drizzle.delete(db.schema.teams)
    .where(and(eq(db.schema.teams.id, teamId), eq(db.schema.teams.companyId, companyId)));
  emitTeam('team.deleted', companyId, { id: teamId, companyId });
}

/** Add a user to a team. Idempotent on (teamId, userId) via unique index. */
export async function addTeamMember(db: DbInstance, companyId: string, teamId: string, userId: string): Promise<TeamMember> {
  await getTeam(db, companyId, teamId);
  if (!userId || !userId.trim()) throw new AppError(400, 'VALIDATION_ERROR', 'userId is required');
  // Upsert: if the membership already exists, return it (idempotent — VAL-TEAM-002).
  const existing = await db.drizzle.select().from(db.schema.teamMembers)
    .where(and(eq(db.schema.teamMembers.teamId, teamId), eq(db.schema.teamMembers.userId, userId)));
  if (existing.length > 0) return existing[0] as TeamMember;
  const [row] = await db.drizzle.insert(db.schema.teamMembers).values({
    teamId, userId,
  }).returning();
  const member = row as TeamMember;
  emitMember('team.member.added', companyId, teamId, userId);
  return member;
}

/** Remove a user from a team. Revokes team-derived access (VAL-TEAM-021). */
export async function removeTeamMember(db: DbInstance, companyId: string, teamId: string, userId: string): Promise<void> {
  await getTeam(db, companyId, teamId);
  await db.drizzle.delete(db.schema.teamMembers)
    .where(and(eq(db.schema.teamMembers.teamId, teamId), eq(db.schema.teamMembers.userId, userId)));
  emitMember('team.member.removed', companyId, teamId, userId);
}

/** List members of a team. */
export async function listTeamMembers(db: DbInstance, companyId: string, teamId: string): Promise<TeamMember[]> {
  await getTeam(db, companyId, teamId);
  const rows = await db.drizzle.select().from(db.schema.teamMembers)
    .where(eq(db.schema.teamMembers.teamId, teamId))
    .orderBy(db.schema.teamMembers.createdAt);
  return rows as TeamMember[];
}

/** Get all team ids a user belongs to (within a company). */
export async function getUserTeamIds(db: DbInstance, companyId: string, userId: string): Promise<string[]> {
  // Join teams + team_members to filter by company.
  const rows = await db.drizzle
    .select({ teamId: db.schema.teamMembers.teamId })
    .from(db.schema.teamMembers)
    .innerJoin(db.schema.teams, eq(db.schema.teamMembers.teamId, db.schema.teams.id))
    .where(and(eq(db.schema.teams.companyId, companyId), eq(db.schema.teamMembers.userId, userId)));
  return rows.map((r) => r.teamId);
}
