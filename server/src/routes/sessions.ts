import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import { RuntimeSessionService } from '../services/runtime-sessions.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

const CreateSessionBody = z.object({
  agentId: z.string().uuid(),
  taskId: z.string().uuid().nullable().optional(),
  executionId: z.string().uuid().nullable().optional(),
  environmentId: z.string().uuid().nullable().optional(),
  adapterId: z.string().max(255).nullable().optional(),
  adapterConfig: z.record(z.unknown()).optional(),
  mode: z.enum(['on_demand', 'scheduled', 'continuous', 'manual', 'recovery']).default('on_demand'),
  resumeState: z.record(z.unknown()).default({}),
  finalizeRequired: z.boolean().default(true),
});

const CancelSessionBody = z.object({
  reason: z.string().max(2000).optional(),
});

export function sessionsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const sessions = new RuntimeSessionService(db);

  router.get('/', async (req, res) => {
    const { companyId } = routeParams(req);
    res.json({ data: await sessions.listSessions(companyId) });
  });

  router.post('/', validate(CreateSessionBody), async (req, res) => {
    const { companyId } = routeParams(req);
    try {
      const session = await sessions.createSession({
        companyId,
        ...(req.body as z.infer<typeof CreateSessionBody>),
      });
      res.status(201).json({ data: session });
    } catch (error) {
      throw new AppError(400, 'RUNTIME_SESSION_CREATE_FAILED', error instanceof Error ? error.message : String(error));
    }
  });

  router.post('/:id/cancel', validate(CancelSessionBody), async (req, res) => {
    const { companyId, id } = routeParams(req);
    try {
      const session = await sessions.cancelSession(companyId, id, (req.body as z.infer<typeof CancelSessionBody>).reason);
      res.json({ data: session });
    } catch (error) {
      throw new AppError(404, 'RUNTIME_SESSION_NOT_FOUND', error instanceof Error ? error.message : String(error));
    }
  });

  router.post('/:id/finalize', async (req, res) => {
    const { companyId, id } = routeParams(req);
    try {
      const session = await sessions.finalizeSession(companyId, id);
      res.json({ data: session });
    } catch (error) {
      throw new AppError(404, 'RUNTIME_SESSION_NOT_FOUND', error instanceof Error ? error.message : String(error));
    }
  });

  return router;
}
