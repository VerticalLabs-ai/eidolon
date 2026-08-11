import { Router } from 'express';
import { CreateTeamBodySchema, AddTeamMemberBodySchema } from '@eidolon/shared';
import { validate } from '../middleware/validate.js';
import { routeParams } from '../utils/route-params.js';
import { AppError } from '../middleware/error-handler.js';
import {
  createTeam,
  listTeams,
  getTeam,
  deleteTeam,
  addTeamMember,
  removeTeamMember,
  listTeamMembers,
} from '../services/team-service.js';
import type { DbInstance } from '../types.js';

/** Require admin/owner org role for privilege-affecting team operations
 * (create/delete teams, add/remove members). VAL-TEAM-001/002/010/024. */
function requireAdminRole(req: any): void {
  const role = req.organizationMembership?.role ?? 'member';
  if (role !== 'admin' && role !== 'owner') {
    throw new AppError(403, 'INSUFFICIENT_ROLE', 'This action requires admin or owner role');
  }
}

export function teamsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });

  // POST /teams — create a team (admin/owner only)
  router.post('/teams', validate(CreateTeamBodySchema), async (req, res) => {
    requireAdminRole(req);
    const { companyId } = routeParams(req);
    const userId = req.organizationMembership?.userId ?? req.user?.id ?? null;
    const team = await createTeam(db, companyId, (req as any).validated.body.name, userId);
    res.status(201).json({ data: team });
  });

  // GET /teams — list all teams in the company
  router.get('/teams', async (req, res) => {
    const { companyId } = routeParams(req);
    const teams = await listTeams(db, companyId);
    // Fetch member counts for each team.
    const teamsWithCounts = await Promise.all(
      teams.map(async (t) => {
        const members = await listTeamMembers(db, companyId, t.id);
        return { ...t, memberCount: members.length };
      }),
    );
    res.json({ data: teamsWithCounts });
  });

  // GET /teams/:teamId — get a single team
  router.get('/teams/:teamId', async (req, res) => {
    const { companyId } = routeParams(req);
    const teamId = String(req.params.teamId);
    const team = await getTeam(db, companyId, teamId);
    res.json({ data: team });
  });

  // DELETE /teams/:teamId — delete a team (admin/owner only)
  router.delete('/teams/:teamId', async (req, res) => {
    requireAdminRole(req);
    const { companyId } = routeParams(req);
    const teamId = String(req.params.teamId);
    await deleteTeam(db, companyId, teamId);
    res.status(204).end();
  });

  // POST /teams/:teamId/members — add a member (admin/owner only)
  // Privilege-affecting: adding a member grants that user the team's
  // permissions (including manage). Enforce requireAdminRole so a
  // viewer/member cannot self-escalate (VAL-TEAM-010/024).
  router.post('/teams/:teamId/members', validate(AddTeamMemberBodySchema), async (req, res) => {
    requireAdminRole(req);
    const { companyId } = routeParams(req);
    const teamId = String(req.params.teamId);
    const member = await addTeamMember(db, companyId, teamId, (req as any).validated.body.userId);
    res.status(201).json({ data: member });
  });

  // DELETE /teams/:teamId/members/:userId — remove a member (admin/owner only)
  // Privilege-affecting: removing a member revokes their team-derived access
  // and could be used for denial-of-service on a user's access. Enforce
  // requireAdminRole (VAL-TEAM-010/024).
  router.delete('/teams/:teamId/members/:userId', async (req, res) => {
    requireAdminRole(req);
    const { companyId } = routeParams(req);
    const teamId = String(req.params.teamId);
    const userId = String(req.params.userId);
    await removeTeamMember(db, companyId, teamId, userId);
    res.status(204).end();
  });

  // GET /teams/:teamId/members — list members
  router.get('/teams/:teamId/members', async (req, res) => {
    const { companyId } = routeParams(req);
    const teamId = String(req.params.teamId);
    const members = await listTeamMembers(db, companyId, teamId);
    res.json({ data: members });
  });

  return router;
}
