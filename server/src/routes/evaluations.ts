import { Router } from 'express';
import { z } from 'zod';
import { EvaluationService } from '../services/evaluation.js';
import { validate } from '../middleware/validate.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const ManualEvaluationBody = z.object({
  executionId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
  qualityScore: z.number().min(1).max(10),
  feedback: z.string().min(1).max(5000),
});

const AutoEvaluationBody = z.object({
  executionId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
  completionTimeMs: z.number().nonnegative(),
  tokenCount: z.number().int().nonnegative(),
  costCents: z.number().int().nonnegative(),
  taskCompleted: z.boolean(),
  errorCount: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function evaluationsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const service = new EvaluationService(db);

  // GET /api/companies/:companyId/evaluations - company-wide evaluations
  router.get('/', async (req, res) => {
    const { companyId } = routeParams(req);
    const limit = parseInt(req.query.limit as string, 10) || 100;
    const data = await service.getCompanyEvaluations(companyId, limit);
    res.json({ data });
  });

  // GET /api/companies/:companyId/evaluations/rankings - agent rankings leaderboard
  router.get('/rankings', async (req, res) => {
    const { companyId } = routeParams(req);
    const data = await service.getCompanyRankings(companyId);
    res.json({ data });
  });

  // GET /api/companies/:companyId/agents/:agentId/evaluations - agent-specific evaluations
  router.get('/agents/:agentId/evaluations', async (req, res) => {
    const { agentId } = routeParams(req);
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const data = await service.getEvaluations(agentId, limit);
    res.json({ data });
  });

  // POST /api/companies/:companyId/agents/:agentId/evaluations - add manual evaluation
  router.post(
    '/agents/:agentId/evaluations',
    validate(ManualEvaluationBody),
    async (req, res) => {
      const { companyId, agentId } = routeParams(req);
      const body = req.body as z.infer<typeof ManualEvaluationBody>;
      const data = await service.manualEvaluate(agentId, companyId, body);
      res.status(201).json({ data });
    },
  );

  // POST /api/companies/:companyId/agents/:agentId/evaluations/auto - auto-evaluate
  router.post(
    '/agents/:agentId/evaluations/auto',
    validate(AutoEvaluationBody),
    async (req, res) => {
      const { companyId, agentId } = routeParams(req);
      const body = req.body as z.infer<typeof AutoEvaluationBody>;
      const data = await service.autoEvaluate(agentId, companyId, body);
      res.status(201).json({ data });
    },
  );

  // GET /api/companies/:companyId/agents/:agentId/performance - performance summary
  router.get('/agents/:agentId/performance', async (req, res) => {
    const { agentId } = routeParams(req);
    const data = await service.getAgentPerformance(agentId);
    res.json({ data });
  });

  return router;
}
