import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { routeParams } from '../utils/route-params.js';
import { createArtifact, getArtifact, listArtifacts, updateArtifact, setArtifactStatus, listRevisions, getRevision } from '../services/artifact-service.js';
import { moveArtifactToFolder } from '../services/folder-service.js';
import { agentBelongsToCompany } from '../utils/agent-validation.js';
import { ArtifactTypeSchema, DashboardContentSchema } from '@eidolon/shared';
import { AppError } from '../middleware/error-handler.js';
import { resolveAccess, requireAccess, filterAccessibleArtifacts, type AccessLevel } from '../services/permission-service.js';
import { resolveDataSource, type DashboardDataSource } from '../services/dashboard-data-source.js';
import type { DbInstance } from '../types.js';

const CreateBody = z.object({
  type: ArtifactTypeSchema, title: z.string().trim().min(1).max(500),
  content: z.unknown(), projectId: z.string().uuid().nullable().optional(), folderId: z.string().uuid().nullable().optional(),
});
const UpdateBody = z.object({
  version: z.number().int().positive().optional(), title: z.string().trim().min(1).max(500).optional(),
  content: z.unknown().optional(), projectId: z.string().uuid().nullable().optional(), message: z.string().max(2000).optional(),
  folderId: z.string().uuid().nullable().optional(),
});
const ListQuery = z.object({
  projectId: z.union([z.string().uuid(), z.literal('null')]).optional(),
  unscoped: z.coerce.boolean().optional(),
  type: ArtifactTypeSchema.optional(),
  status: z.enum(['active', 'archived', 'deleted']).default('active'),
  folderId: z.union([z.string().uuid(), z.literal('null')]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0),
  sort: z.enum(['updatedAt', 'title', 'type', 'createdAt']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

async function editor(db: DbInstance, companyId: string, req: any) {
  // Support agent-authored artifacts via X-Eidolon-Agent-Id header (used by
  // MCP-server tool calls and built-in agent tools). The header is
  // caller-controlled, so the agent id is only trusted for attribution when it
  // names an agent that actually belongs to the path company.
  // VAL-ART-098: when the header is PRESENT but the agent does NOT belong to
  // the path company, reject with 403 (do NOT fall back to user-authored).
  // Only fall back to the user-authored flow when the header is ABSENT.
  const agentId = req.get('X-Eidolon-Agent-Id');
  if (agentId) {
    if (await agentBelongsToCompany(db, companyId, agentId)) {
      return { agentId, userId: null, editSource: 'agent' as const };
    }
    throw new AppError(403, 'AGENT_NOT_IN_COMPANY', 'The specified agent does not belong to this company');
  }
  return { userId: req.user?.id ?? null, editSource: 'user' as const };
}

export function artifactsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });

  // Helper: get the acting user's id + org role from the request.
  function actor(req: any): { userId: string; orgRole: string } {
    return {
      userId: req.organizationMembership?.userId ?? req.user?.id ?? 'dev-user-000',
      orgRole: req.organizationMembership?.role ?? 'owner',
    };
  }

  router.get('/projects/:projectId/artifacts', async (req, res) => {
    const { companyId, projectId } = routeParams(req);
    const result = await listArtifacts(db, companyId, { projectId, limit: 50, offset: 0 });
    // Filter by view access (hide no-access artifacts — VAL-TEAM-006/017).
    const { userId, orgRole } = actor(req);
    const accessibleIds = await filterAccessibleArtifacts(db, companyId, userId, orgRole, result.rows.map((r: any) => r.id), 'view');
    const filteredRows = result.rows.filter((r: any) => accessibleIds.includes(r.id));
    res.json({ data: filteredRows, meta: { total: result.total, limit: 50, offset: 0 } });
  });
  router.post('/artifacts', validate(CreateBody), async (req, res) => {
    const { companyId } = routeParams(req);
    // If a projectId is specified, require edit access on the project
    // (or it must be unrestricted). Company-level (no projectId) creation
    // requires member+ role (enforced by requireOrgMember on mount).
    const body = (req as any).validated.body;
    const { userId, orgRole } = actor(req);
    if (body.projectId) {
      try {
        await requireAccess(db, companyId, userId, orgRole, 'project', body.projectId, 'edit');
      } catch (err) {
        if (err instanceof AppError && err.code === 'FORBIDDEN') {
          // If the project is unrestricted, member/viewer can create.
          // requireAccess throws only when access is denied — rethrow.
          throw err;
        }
        throw err;
      }
    }
    const row = await createArtifact(db, companyId, body, await editor(db, companyId, req));
    res.status(201).json({ data: row });
  });
  router.get('/artifacts', validate(ListQuery, 'query'), async (req, res) => {
    const { companyId } = routeParams(req);
    const query = (req as any).validated.query;
    // Normalize projectId: 'null' string or unscoped flag → null (unscoped filter)
    const filters: any = { limit: query.limit, offset: query.offset, status: query.status, type: query.type, sort: query.sort, order: query.order };
    if (query.unscoped === true || query.projectId === 'null') {
      filters.projectId = null;
      filters.filterNullProject = true;
    } else if (query.projectId && query.projectId !== 'null') {
      filters.projectId = query.projectId;
    }
    // Normalize folderId: 'null' string → filter for unfiled artifacts (folderId IS NULL).
    if (query.folderId === 'null') {
      filters.filterNullFolder = true;
    } else if (query.folderId && query.folderId !== 'null') {
      filters.folderId = query.folderId;
    }
    const result = await listArtifacts(db, companyId, filters);
    // Filter by view access (hide no-access artifacts — VAL-TEAM-006/017).
    const { userId, orgRole } = actor(req);
    const accessibleIds = await filterAccessibleArtifacts(db, companyId, userId, orgRole, result.rows.map((r: any) => r.id), 'view');
    const filteredRows = result.rows.filter((r: any) => accessibleIds.includes(r.id));
    res.json({ data: filteredRows, meta: { total: result.total, limit: query.limit, offset: query.offset } });
  });
  router.get('/artifacts/:id/revisions/:version', async (req, res) => {
    const { companyId, id } = routeParams(req);
    const { userId, orgRole } = actor(req);
    await requireAccess(db, companyId, userId, orgRole, 'artifact', id, 'view');
    res.json({ data: await getRevision(db, companyId, id, Number(req.params.version)) });
  });
  router.post('/artifacts/:id/revisions/:version/restore', async (req, res) => {
    const { companyId, id } = routeParams(req);
    const { userId, orgRole } = actor(req);
    await requireAccess(db, companyId, userId, orgRole, 'artifact', id, 'manage');
    const revision = await getRevision(db, companyId, id, Number(req.params.version));
    const row = await updateArtifact(db, companyId, id, { version: (await getArtifact(db, companyId, id)).version, content: revision.content, message: 'restore revision' }, await editor(db, companyId, req));
    res.json({ data: row });
  });
  router.get('/artifacts/:id/revisions', async (req, res) => {
    const { companyId, id } = routeParams(req);
    const { userId, orgRole } = actor(req);
    await requireAccess(db, companyId, userId, orgRole, 'artifact', id, 'view');
    res.json({ data: await listRevisions(db, companyId, id) });
  });
  router.get('/artifacts/:id', async (req, res) => {
    const { companyId, id } = routeParams(req);
    const { userId, orgRole } = actor(req);
    await requireAccess(db, companyId, userId, orgRole, 'artifact', id, 'view');
    res.json({ data: await getArtifact(db, companyId, id) });
  });
  router.patch('/artifacts/:id', validate(UpdateBody), async (req, res) => {
    const { companyId, id } = routeParams(req);
    const body = (req as any).validated.body;
    // Metadata-only folder move: when the PATCH supplies `folderId` and no
    // content/title, treat it as a move (no version bump, no revision).
    if (body.folderId !== undefined && body.content === undefined && body.title === undefined) {
      const { userId, orgRole } = actor(req);
      await requireAccess(db, companyId, userId, orgRole, 'artifact', id, 'edit');
      await moveArtifactToFolder(db, companyId, id, body.folderId);
      const row = await getArtifact(db, companyId, id);
      res.json({ data: row });
      return;
    }
    // Content/title edit requires edit access.
    const { userId, orgRole } = actor(req);
    await requireAccess(db, companyId, userId, orgRole, 'artifact', id, 'edit');
    res.json({ data: await updateArtifact(db, companyId, id, body, await editor(db, companyId, req)) });
  });
  router.delete('/artifacts/:id', async (req, res) => {
    const { companyId, id } = routeParams(req);
    const { userId, orgRole } = actor(req);
    // Delete requires manage access.
    await requireAccess(db, companyId, userId, orgRole, 'artifact', id, 'manage');
    res.json({ data: await setArtifactStatus(db, companyId, id, 'deleted', await editor(db, companyId, req)) });
  });
  router.post('/artifacts/:id/archive', async (req, res) => {
    const { companyId, id } = routeParams(req);
    const { userId, orgRole } = actor(req);
    await requireAccess(db, companyId, userId, orgRole, 'artifact', id, 'manage');
    res.json({ data: await setArtifactStatus(db, companyId, id, 'archived', await editor(db, companyId, req)) });
  });
  router.post('/artifacts/:id/restore', async (req, res) => {
    const { companyId, id } = routeParams(req);
    const { userId, orgRole } = actor(req);
    await requireAccess(db, companyId, userId, orgRole, 'artifact', id, 'manage');
    res.json({ data: await setArtifactStatus(db, companyId, id, 'active', await editor(db, companyId, req)) });
  });

  // -------------------------------------------------------------------------
  // Dashboard data-source resolution (VAL-DASHBOARD-005/008)
  // -------------------------------------------------------------------------
  // Resolves a single data source configured on a dashboard artifact into
  // live data for widget rendering. The artifact must be a dashboard owned
  // by the path company; the data source id must be declared in the
  // dashboard's content. Resolution is server-side under company scoping.
  router.get('/artifacts/:id/dashboard/sources/:dataSourceId/resolve', async (req, res) => {
    const { companyId, id } = routeParams(req);
    const { userId, orgRole } = actor(req);
    await requireAccess(db, companyId, userId, orgRole, 'artifact', id, 'view');
    const artifact = await getArtifact(db, companyId, id);
    if (artifact.type !== 'dashboard') {
      throw new AppError(400, 'NOT_A_DASHBOARD', 'Artifact is not a dashboard');
    }
    const parsed = DashboardContentSchema.safeParse(artifact.content);
    if (!parsed.success) {
      throw new AppError(400, 'INVALID_ARTIFACT_CONTENT', 'Dashboard content is invalid', parsed.error.flatten());
    }
    const dataSourceId = req.params.dataSourceId;
    const source = parsed.data.dataSources.find((ds) => ds.id === dataSourceId);
    if (!source) {
      throw new AppError(404, 'DATA_SOURCE_NOT_FOUND', `Data source ${dataSourceId} not found on dashboard ${id}`);
    }
    const resolved = await resolveDataSource(db, companyId, source as DashboardDataSource);
    res.json({ data: resolved });
  });

  // Resolve all data sources on a dashboard in one call (used by the editor
  // for initial load + refresh — VAL-DASHBOARD-005/008).
  router.get('/artifacts/:id/dashboard/resolve', async (req, res) => {
    const { companyId, id } = routeParams(req);
    const { userId, orgRole } = actor(req);
    await requireAccess(db, companyId, userId, orgRole, 'artifact', id, 'view');
    const artifact = await getArtifact(db, companyId, id);
    if (artifact.type !== 'dashboard') {
      throw new AppError(400, 'NOT_A_DASHBOARD', 'Artifact is not a dashboard');
    }
    const parsed = DashboardContentSchema.safeParse(artifact.content);
    if (!parsed.success) {
      throw new AppError(400, 'INVALID_ARTIFACT_CONTENT', 'Dashboard content is invalid', parsed.error.flatten());
    }
    const results = await Promise.all(
      parsed.data.dataSources.map((ds) =>
        resolveDataSource(db, companyId, ds as DashboardDataSource).catch((err) => ({
          dataSourceId: ds.id,
          type: ds.type,
          error: err instanceof AppError ? err.message : String(err),
        })),
      ),
    );
    res.json({ data: { sources: results } });
  });

  return router;
}
