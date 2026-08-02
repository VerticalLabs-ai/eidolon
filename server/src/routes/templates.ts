import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import { TemplateService } from '../services/templates.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

const SaveTemplateBody = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  category: z.enum(['general', 'software', 'marketing', 'ecommerce', 'consulting', 'content']).default('general'),
  author: z.string().optional(),
  version: z.string().default('1.0.0'),
  config: z.object({
    name: z.string(),
    description: z.string().nullable().optional(),
    mission: z.string().nullable().optional(),
    budgetMonthlyCents: z.number().int().nonnegative().default(0),
    agents: z.array(z.object({
      name: z.string(),
      role: z.string(),
      title: z.string(),
      provider: z.string().default('anthropic'),
      model: z.string().default('claude-opus-4-7'),
      systemPrompt: z.string().nullable().optional(),
      capabilities: z.array(z.string()).default([]),
      budgetMonthlyCents: z.number().int().nonnegative().default(0),
      reportsTo: z.string().nullable().optional(),
    })).default([]),
    goals: z.array(z.object({
      title: z.string(),
      description: z.string().nullable().optional(),
      level: z.string().default('company'),
    })).default([]),
    prompts: z.array(z.object({
      name: z.string(),
      category: z.string().default('general'),
      content: z.string(),
      variables: z.array(z.string()).default([]),
    })).default([]),
  }),
  tags: z.array(z.string()).default([]),
  isPublic: z.boolean().default(false),
});

const UpdateTemplateBody = SaveTemplateBody.partial();

const ImportOverridesBody = z.object({
  companyName: z.string().min(1).max(255).optional(),
  budgetMultiplier: z.number().positive().default(1),
});

export function templatesRouter(db: DbInstance, requireAuth?: RequestHandler): Router {
  const router = Router();
  const service = new TemplateService(db);

  // GET /api/templates - list all templates
  router.get('/', async (req, res) => {
    const category = req.query.category as string | undefined;
    const templates = await service.listTemplates(category);
    res.json({ data: templates });
  });

  // GET /api/templates/:id - get template detail
  router.get('/:id', async (req, res) => {
    const template = await service.getTemplate(routeParams(req).id);
    if (!template) {
      throw new AppError(404, 'NOT_FOUND', `Template ${routeParams(req).id} not found`);
    }
    res.json({ data: template });
  });

  if (requireAuth) {
    router.use(requireAuth);
  }

  // POST /api/templates - save a new template
  router.post('/', validate(SaveTemplateBody), async (req, res) => {
    const body = req.body as z.infer<typeof SaveTemplateBody>;
    const template = await service.saveTemplate(body as any);
    res.status(201).json({ data: template });
  });

  // PATCH /api/templates/:id - update a user-created template
  router.patch('/:id', validate(UpdateTemplateBody), async (req, res) => {
    try {
      const template = await service.updateTemplate(
        routeParams(req).id,
        req.body as any,
      );
      if (!template) {
        throw new AppError(404, 'NOT_FOUND', `Template ${routeParams(req).id} not found`);
      }
      res.json({ data: template });
    } catch (error) {
      if (error instanceof Error && error.message.includes('built-in')) {
        throw new AppError(403, 'CANNOT_UPDATE_BUILT_IN', error.message);
      }
      throw error;
    }
  });

  // DELETE /api/templates/:id - delete a user-created template
  router.delete('/:id', async (req, res) => {
    try {
      const deleted = await service.deleteTemplate(routeParams(req).id);
      if (!deleted) {
        throw new AppError(404, 'NOT_FOUND', `Template ${routeParams(req).id} not found`);
      }
      res.status(204).send();
    } catch (error) {
      if (error instanceof Error && error.message.includes('built-in')) {
        throw new AppError(403, 'CANNOT_DELETE_BUILT_IN', error.message);
      }
      throw error;
    }
  });

  // POST /api/templates/:id/import - import a template to create a new company
  router.post('/:id/import', validate(ImportOverridesBody), async (req, res) => {
    const template = await service.getTemplate(routeParams(req).id);
    if (!template) {
      throw new AppError(404, 'NOT_FOUND', `Template ${routeParams(req).id} not found`);
    }

    const body = req.body as z.infer<typeof ImportOverridesBody>;
    const config = template.config as any;
    const result = await service.importTemplate(config, {
      companyName: body.companyName,
      budgetMultiplier: body.budgetMultiplier,
    });

    // Increment download count
    await service.incrementDownloadCount(routeParams(req).id);

    res.status(201).json({ data: result });
  });

  return router;
}

export function companyExportRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const service = new TemplateService(db);

  // POST /api/companies/:companyId/export - export company as template
  router.post('/', async (req, res) => {
    const companyId = routeParams(req).companyId;
    const config = await service.exportCompany(companyId);

    // Optionally save it as a template too
    const saveName = (req.body as any)?.name ?? config.name;
    const template = await service.saveTemplate({
      name: `${saveName} Template`,
      description: (req.body as any)?.description ?? `Template exported from ${config.name}`,
      category: (req.body as any)?.category ?? 'general',
      author: (req.body as any)?.author ?? 'user',
      version: (req.body as any)?.version ?? '1.0.0',
      config,
      tags: (req.body as any)?.tags ?? [],
      isPublic: false,
    });

    res.status(201).json({ data: { template, config } });
  });

  // PATCH /api/companies/:companyId/export/:templateId - refresh a template from the latest company state
  router.patch('/:templateId', async (req, res) => {
    const companyId = routeParams(req).companyId;
    const templateId = routeParams(req).templateId;
    const config = await service.exportCompany(companyId);

    try {
      const template = await service.updateTemplate(templateId, {
        name: (req.body as any)?.name,
        description: (req.body as any)?.description,
        category: (req.body as any)?.category,
        author: (req.body as any)?.author,
        version: (req.body as any)?.version,
        config,
        tags: (req.body as any)?.tags,
      });
      if (!template) {
        throw new AppError(404, 'NOT_FOUND', `Template ${templateId} not found`);
      }
      res.json({ data: { template, config } });
    } catch (error) {
      if (error instanceof Error && error.message.includes('built-in')) {
        throw new AppError(403, 'CANNOT_UPDATE_BUILT_IN', error.message);
      }
      throw error;
    }
  });

  return router;
}
