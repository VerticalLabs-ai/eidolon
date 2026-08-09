import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { routeParams } from '../utils/route-params.js';
import { ArtifactTypeSchema } from '@eidolon/shared';
import {
  saveProjectTemplate,
  listProjectTemplates,
  getProjectTemplate,
  deleteProjectTemplate,
  createProjectFromTemplate,
  saveArtifactTemplate,
  listArtifactTemplates,
  getArtifactTemplate,
  deleteArtifactTemplate,
  createArtifactFromTemplate,
} from '../services/workspace-template-service.js';
import type { DbInstance } from '../types.js';

const SaveProjectTemplateBody = z.object({
  projectId: z.string().uuid(),
  name: z.string().trim().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
});

const CreateProjectFromTemplateBody = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(5000).nullable().optional(),
  idempotencyKey: z.string().trim().min(1).max(255).optional(),
});

const ListArtifactTemplatesQuery = z.object({
  type: ArtifactTypeSchema.optional(),
});

const SaveArtifactTemplateBody = z.object({
  artifactId: z.string().uuid(),
  name: z.string().trim().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
});

const CreateArtifactFromTemplateBody = z.object({
  projectId: z.string().uuid().nullable().optional(),
  folderId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(500).optional(),
});

export function workspaceTemplatesRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });

  // ── Project templates ───────────────────────────────────────────────
  router.post('/project-templates', validate(SaveProjectTemplateBody), async (req, res) => {
    const { companyId } = routeParams(req);
    const body = (req as any).validated.body as z.infer<typeof SaveProjectTemplateBody>;
    const userId = req.user?.id ?? null;
    const row = await saveProjectTemplate(db, companyId, {
      projectId: body.projectId,
      name: body.name,
      description: body.description,
      userId,
    });
    res.status(201).json({ data: row });
  });

  router.get('/project-templates', async (req, res) => {
    const { companyId } = routeParams(req);
    const rows = await listProjectTemplates(db, companyId);
    res.json({ data: rows });
  });

  router.get('/project-templates/:id', async (req, res) => {
    const { companyId, id } = routeParams(req);
    res.json({ data: await getProjectTemplate(db, companyId, id) });
  });

  router.delete('/project-templates/:id', async (req, res) => {
    const { companyId, id } = routeParams(req);
    await deleteProjectTemplate(db, companyId, id);
    res.status(204).end();
  });

  router.post('/project-templates/:id/create-project', validate(CreateProjectFromTemplateBody), async (req, res) => {
    const { companyId, id } = routeParams(req);
    const body = (req as any).validated.body as z.infer<typeof CreateProjectFromTemplateBody>;
    const userId = req.user?.id ?? null;
    const result = await createProjectFromTemplate(db, companyId, id, {
      name: body.name,
      description: body.description,
      idempotencyKey: body.idempotencyKey,
      userId,
    });
    res.status(201).json({ data: result });
  });

  // ── Artifact templates ──────────────────────────────────────────────
  router.post('/artifact-templates', validate(SaveArtifactTemplateBody), async (req, res) => {
    const { companyId } = routeParams(req);
    const body = (req as any).validated.body as z.infer<typeof SaveArtifactTemplateBody>;
    const userId = req.user?.id ?? null;
    const row = await saveArtifactTemplate(db, companyId, {
      artifactId: body.artifactId,
      name: body.name,
      description: body.description,
      userId,
    });
    res.status(201).json({ data: row });
  });

  router.get('/artifact-templates', validate(ListArtifactTemplatesQuery, 'query'), async (req, res) => {
    const { companyId } = routeParams(req);
    const query = (req as any).validated.query as z.infer<typeof ListArtifactTemplatesQuery>;
    const rows = await listArtifactTemplates(db, companyId, query.type);
    res.json({ data: rows });
  });

  router.get('/artifact-templates/:id', async (req, res) => {
    const { companyId, id } = routeParams(req);
    res.json({ data: await getArtifactTemplate(db, companyId, id) });
  });

  router.delete('/artifact-templates/:id', async (req, res) => {
    const { companyId, id } = routeParams(req);
    await deleteArtifactTemplate(db, companyId, id);
    res.status(204).end();
  });

  router.post('/artifact-templates/:id/create-artifact', validate(CreateArtifactFromTemplateBody), async (req, res) => {
    const { companyId, id } = routeParams(req);
    const body = (req as any).validated.body as z.infer<typeof CreateArtifactFromTemplateBody>;
    const userId = req.user?.id ?? null;
    const row = await createArtifactFromTemplate(db, companyId, id, {
      projectId: body.projectId,
      folderId: body.folderId,
      title: body.title,
      userId,
    });
    res.status(201).json({ data: row });
  });

  return router;
}
