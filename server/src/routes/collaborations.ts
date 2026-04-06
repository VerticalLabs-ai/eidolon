import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import { CollaborationService } from '../services/collaboration.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

const CreateCollaborationBody = z.object({
  type: z.enum(['delegation', 'request_help', 'review', 'escalation']),
  fromAgentId: z.string().min(1),
  toAgentId: z.string().min(1).optional(),
  taskId: z.string().optional(),
  requestContent: z.string().min(1).optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  parentCollaborationId: z.string().optional(),
});

const RespondBody = z.object({
  responseContent: z.string().min(1),
});

export function collaborationsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const service = new CollaborationService(db);

  // GET /api/companies/:companyId/collaborations - list all collaborations
  router.get('/', async (req, res) => {
    const companyId = routeParams(req).companyId;
    const limit = parseInt(req.query.limit as string) || 50;
    const collaborations = await service.getHistory(companyId, limit);
    res.json({ data: collaborations });
  });

  // POST /api/companies/:companyId/collaborations - create a collaboration
  router.post('/', validate(CreateCollaborationBody), async (req, res) => {
    const companyId = routeParams(req).companyId;
    const body = req.body as z.infer<typeof CreateCollaborationBody>;

    let result;

    switch (body.type) {
      case 'delegation': {
        if (!body.toAgentId) throw new AppError(400, 'VALIDATION_ERROR', 'toAgentId required for delegation');
        if (!body.requestContent) throw new AppError(400, 'VALIDATION_ERROR', 'requestContent required for delegation');
        result = await service.delegate(body.fromAgentId, body.toAgentId, companyId, {
          taskId: body.taskId,
          requestContent: body.requestContent,
          priority: body.priority,
          parentCollaborationId: body.parentCollaborationId,
        });
        break;
      }
      case 'request_help': {
        if (!body.toAgentId) throw new AppError(400, 'VALIDATION_ERROR', 'toAgentId required for request_help');
        if (!body.requestContent) throw new AppError(400, 'VALIDATION_ERROR', 'requestContent required for request_help');
        result = await service.requestHelp(body.fromAgentId, body.toAgentId, companyId, body.requestContent, body.taskId);
        break;
      }
      case 'review': {
        if (!body.taskId) throw new AppError(400, 'VALIDATION_ERROR', 'taskId required for review');
        result = await service.requestReview(body.fromAgentId, body.taskId, companyId);
        break;
      }
      case 'escalation': {
        if (!body.taskId) throw new AppError(400, 'VALIDATION_ERROR', 'taskId required for escalation');
        if (!body.requestContent) throw new AppError(400, 'VALIDATION_ERROR', 'requestContent (reason) required for escalation');
        result = await service.escalate(body.fromAgentId, body.taskId, companyId, body.requestContent);
        break;
      }
      default:
        throw new AppError(400, 'INVALID_TYPE', `Unknown collaboration type: ${body.type}`);
    }

    res.status(201).json({ data: result });
  });

  // GET /api/companies/:companyId/collaborations/:id - get single collaboration
  router.get('/:id', async (req, res) => {
    const collab = await service.getById(routeParams(req).id);
    if (!collab) {
      throw new AppError(404, 'NOT_FOUND', `Collaboration ${routeParams(req).id} not found`);
    }
    res.json({ data: collab });
  });

  // POST /api/companies/:companyId/collaborations/:id/respond - respond to a collaboration
  router.post('/:id/respond', validate(RespondBody), async (req, res) => {
    const body = req.body as z.infer<typeof RespondBody>;
    const collab = await service.getById(routeParams(req).id);
    if (!collab) {
      throw new AppError(404, 'NOT_FOUND', `Collaboration ${routeParams(req).id} not found`);
    }
    if (collab.status !== 'pending') {
      throw new AppError(400, 'INVALID_STATUS', `Collaboration is already ${collab.status}`);
    }
    const result = await service.respond(routeParams(req).id, body.responseContent);
    res.json({ data: result });
  });

  return router;
}

export function agentCollaborationsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const service = new CollaborationService(db);

  // GET /api/companies/:companyId/agents/:agentId/collaborations
  router.get('/', async (req, res) => {
    const { companyId, agentId } = routeParams(req);
    const collaborations = await service.getForAgent(agentId, companyId);
    res.json({ data: collaborations });
  });

  // GET /api/companies/:companyId/agents/:agentId/collaborations/pending
  router.get('/pending', async (req, res) => {
    const pending = await service.getPendingForAgent(routeParams(req).agentId);
    res.json({ data: pending });
  });

  return router;
}
