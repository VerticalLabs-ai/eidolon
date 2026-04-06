import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { MemoryService } from '../services/memory.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const CreateMemoryBody = z.object({
  content: z.string().min(1).max(10_000),
  memoryType: z
    .enum(['observation', 'decision', 'preference', 'fact', 'lesson'])
    .default('observation'),
  importance: z.number().int().min(1).max(10).default(5),
  sourceTaskId: z.string().uuid().optional(),
  sourceExecutionId: z.string().uuid().optional(),
  tags: z.array(z.string().min(1).max(100)).default([]),
  expiresAt: z.string().datetime().optional(),
});

const RecallBody = z.object({
  context: z.string().min(1).max(10_000),
  limit: z.number().int().min(1).max(50).default(10),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function memoriesRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const memoryService = new MemoryService(db);

  // GET /api/companies/:companyId/agents/:agentId/memories
  router.get('/', async (req, res) => {
    const { companyId, agentId } = routeParams(req);
    const limit = parseInt(req.query.limit as string) || 100;

    const memories = await memoryService.getMemories(agentId, companyId, limit);
    res.json({ data: memories });
  });

  // POST /api/companies/:companyId/agents/:agentId/memories
  router.post('/', validate(CreateMemoryBody), async (req, res) => {
    const { companyId, agentId } = routeParams(req);
    const body = req.body as z.infer<typeof CreateMemoryBody>;

    const memory = await memoryService.remember(agentId, companyId, {
      content: body.content,
      memoryType: body.memoryType,
      importance: body.importance,
      sourceTaskId: body.sourceTaskId,
      sourceExecutionId: body.sourceExecutionId,
      tags: body.tags,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
    });

    res.status(201).json({ data: memory });
  });

  // POST /api/companies/:companyId/agents/:agentId/memories/recall
  router.post('/recall', validate(RecallBody), async (req, res) => {
    const { agentId } = routeParams(req);
    const body = req.body as z.infer<typeof RecallBody>;

    const memories = await memoryService.recall(agentId, body.context, body.limit);
    res.json({ data: memories });
  });

  // DELETE /api/companies/:companyId/agents/:agentId/memories/:memoryId
  router.delete('/:memoryId', async (req, res) => {
    const { memoryId } = routeParams(req);

    await memoryService.forget(memoryId);
    res.status(204).send();
  });

  // DELETE /api/companies/:companyId/agents/:agentId/memories
  router.delete('/', async (req, res) => {
    const { agentId } = routeParams(req);

    await memoryService.clearMemories(agentId);
    res.status(204).send();
  });

  return router;
}
