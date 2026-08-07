import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { validate } from '../middleware/validate.js';
import { routeParams } from '../utils/route-params.js';
import { createArtifact, getArtifact, listArtifacts, updateArtifact, setArtifactStatus, listRevisions, getRevision } from '../services/artifact-service.js';
import { ArtifactTypeSchema } from '@eidolon/shared';
import { AppError } from '../middleware/error-handler.js';
import type { DbInstance } from '../types.js';

const AgentIdSchema = z.string().uuid();


const CreateBody = z.object({
  type: ArtifactTypeSchema, title: z.string().trim().min(1).max(500),
  content: z.unknown(), projectId: z.string().uuid().nullable().optional(), folderId: z.string().uuid().nullable().optional(),
});
const UpdateBody = z.object({
  version: z.number().int().positive().optional(), title: z.string().trim().min(1).max(500).optional(),
  content: z.unknown().optional(), projectId: z.string().uuid().nullable().optional(), message: z.string().max(2000).optional(),
});
const ListQuery = z.object({
  projectId: z.union([z.string().uuid(), z.literal('null')]).optional(),
  unscoped: z.coerce.boolean().optional(),
  type: ArtifactTypeSchema.optional(),
  status: z.enum(['active', 'archived', 'deleted']).default('active'), folderId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0),
});

async function editor(req: any, companyId: string, db: DbInstance) {
  // Support agent-authored artifacts via X-Eidolon-Agent-Id header.
  // The agent must belong to the request's company before it can be used for attribution.
  const agentId = req.get('X-Eidolon-Agent-Id');
  if (agentId) {
    if (!AgentIdSchema.safeParse(agentId).success) {
      throw new AppError(400, 'INVALID_AGENT_ID', 'X-Eidolon-Agent-Id must be a UUID');
    }
    const [agent] = await db.drizzle.select({ id: db.schema.agents.id }).from(db.schema.agents)
      .where(and(eq(db.schema.agents.id, agentId), eq(db.schema.agents.companyId, companyId)));
    if (!agent) throw new AppError(403, 'INVALID_AGENT_ID', 'Agent does not belong to this company');
    return { agentId, userId: req.user?.id ?? null, editSource: 'agent' as const };
  }
  return { userId: req.user?.id ?? null, editSource: 'user' as const };
}

export function artifactsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  router.get('/projects/:projectId/artifacts', async (req, res) => {
    const { companyId, projectId } = routeParams(req);
    const result = await listArtifacts(db, companyId, { projectId, limit: 50, offset: 0 });
    res.json({ data: result.rows, meta: { total: result.total, limit: 50, offset: 0 } });
  });
  router.post('/artifacts', validate(CreateBody), async (req, res) => {
    const { companyId } = routeParams(req);
    const row = await createArtifact(db, companyId, (req as any).validated.body, await editor(req, companyId, db));
    res.status(201).json({ data: row });
  });
  router.get('/artifacts', validate(ListQuery, 'query'), async (req, res) => {
    const { companyId } = routeParams(req);
    const query = (req as any).validated.query;
    // Normalize projectId: 'null' string or unscoped flag → null (unscoped filter)
    const filters: any = { limit: query.limit, offset: query.offset, status: query.status, type: query.type, folderId: query.folderId };
    if (query.unscoped === true || query.projectId === 'null') {
      filters.projectId = null;
      filters.filterNullProject = true;
    } else if (query.projectId && query.projectId !== 'null') {
      filters.projectId = query.projectId;
    }
    const result = await listArtifacts(db, companyId, filters);
    res.json({ data: result.rows, meta: { total: result.total, limit: query.limit, offset: query.offset } });
  });
  router.get('/artifacts/:id/revisions/:version', async (req, res) => {
    const { companyId, id } = routeParams(req);
    res.json({ data: await getRevision(db, companyId, id, Number(req.params.version)) });
  });
  router.post('/artifacts/:id/revisions/:version/restore', async (req, res) => {
    const { companyId, id } = routeParams(req);
    const revision = await getRevision(db, companyId, id, Number(req.params.version));
    const row = await updateArtifact(db, companyId, id, { version: (await getArtifact(db, companyId, id)).version, content: revision.content, message: 'restore revision' }, await editor(req, companyId, db));
    res.json({ data: row });
  });
  router.get('/artifacts/:id/revisions', async (req, res) => {
    const { companyId, id } = routeParams(req);
    res.json({ data: await listRevisions(db, companyId, id) });
  });
  router.get('/artifacts/:id', async (req, res) => {
    const { companyId, id } = routeParams(req);
    res.json({ data: await getArtifact(db, companyId, id) });
  });
  router.patch('/artifacts/:id', validate(UpdateBody), async (req, res) => {
    const { companyId, id } = routeParams(req);
    res.json({ data: await updateArtifact(db, companyId, id, (req as any).validated.body, await editor(req, companyId, db)) });
  });
  router.delete('/artifacts/:id', async (req, res) => {
    const { companyId, id } = routeParams(req);
    res.json({ data: await setArtifactStatus(db, companyId, id, 'deleted', await editor(req, companyId, db)) });
  });
  router.post('/artifacts/:id/archive', async (req, res) => {
    const { companyId, id } = routeParams(req);
    res.json({ data: await setArtifactStatus(db, companyId, id, 'archived', await editor(req, companyId, db)) });
  });
  router.post('/artifacts/:id/restore', async (req, res) => {
    const { companyId, id } = routeParams(req);
    res.json({ data: await setArtifactStatus(db, companyId, id, 'active', await editor(req, companyId, db)) });
  });
  return router;
}
