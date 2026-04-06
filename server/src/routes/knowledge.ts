import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import { KnowledgeService } from '../services/knowledge.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

const CreateDocumentBody = z.object({
  title: z.string().min(1).max(500),
  content: z.string().min(1),
  contentType: z.string().max(50).optional(),
  source: z.string().max(100).optional(),
  sourceUrl: z.string().max(2000).optional(),
  tags: z.array(z.string()).optional(),
  createdBy: z.string().max(255).optional(),
});

const UpdateDocumentBody = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
});

const SearchBody = z.object({
  query: z.string().min(1).max(1000),
  topK: z.number().int().min(1).max(20).optional(),
});

export function knowledgeRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const knowledgeService = new KnowledgeService(db);

  // GET /api/companies/:companyId/knowledge - list documents
  router.get('/', async (req, res) => {
    const docs = await knowledgeService.listDocuments(routeParams(req).companyId);
    res.json({ data: docs });
  });

  // POST /api/companies/:companyId/knowledge - add document
  router.post('/', validate(CreateDocumentBody), async (req, res) => {
    const body = req.body as z.infer<typeof CreateDocumentBody>;
    const companyId = routeParams(req).companyId;

    const doc = await knowledgeService.addDocument(companyId, {
      title: body.title,
      content: body.content,
      contentType: body.contentType,
      source: body.source,
      sourceUrl: body.sourceUrl,
      tags: body.tags,
      createdBy: body.createdBy,
    });

    eventBus.emitEvent({
      type: 'activity.logged',
      companyId,
      payload: {
        action: 'knowledge.document.created',
        entityType: 'knowledge_document',
        entityId: doc.id,
        title: body.title,
      },
      timestamp: new Date().toISOString(),
    });

    res.status(201).json({ data: doc });
  });

  // GET /api/companies/:companyId/knowledge/:id - get document with chunks
  router.get('/:id', async (req, res) => {
    const result = await knowledgeService.getDocument(
      routeParams(req).id,
      routeParams(req).companyId,
    );

    if (!result) {
      throw new AppError(404, 'DOCUMENT_NOT_FOUND', `Document ${routeParams(req).id} not found`);
    }

    res.json({ data: result });
  });

  // PATCH /api/companies/:companyId/knowledge/:id - update document
  router.patch('/:id', validate(UpdateDocumentBody), async (req, res) => {
    const body = req.body as z.infer<typeof UpdateDocumentBody>;
    const { id, companyId } = routeParams(req);

    try {
      const updated = await knowledgeService.updateDocument(id, companyId, {
        title: body.title,
        content: body.content,
        tags: body.tags,
      });

      eventBus.emitEvent({
        type: 'activity.logged',
        companyId,
        payload: {
          action: 'knowledge.document.updated',
          entityType: 'knowledge_document',
          entityId: id,
        },
        timestamp: new Date().toISOString(),
      });

      res.json({ data: updated });
    } catch (err: any) {
      if (err.message?.includes('not found')) {
        throw new AppError(404, 'DOCUMENT_NOT_FOUND', `Document ${id} not found`);
      }
      throw err;
    }
  });

  // DELETE /api/companies/:companyId/knowledge/:id - delete document
  router.delete('/:id', async (req, res) => {
    const { id, companyId } = routeParams(req);

    await knowledgeService.deleteDocument(id, companyId);

    eventBus.emitEvent({
      type: 'activity.logged',
      companyId,
      payload: {
        action: 'knowledge.document.deleted',
        entityType: 'knowledge_document',
        entityId: id,
      },
      timestamp: new Date().toISOString(),
    });

    res.json({ data: { id, deleted: true } });
  });

  // POST /api/companies/:companyId/knowledge/search - search knowledge base
  router.post('/search', validate(SearchBody), async (req, res) => {
    const body = req.body as z.infer<typeof SearchBody>;
    const results = await knowledgeService.searchCompanyKnowledge(
      routeParams(req).companyId,
      body.query,
      body.topK,
    );

    res.json({ data: results });
  });

  return router;
}
