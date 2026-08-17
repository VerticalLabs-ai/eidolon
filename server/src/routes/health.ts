import { Router, type Router as RouterType } from 'express';
import { getConnectedClientCount } from '../realtime/ws-server.js';
import { checkReadiness } from '../services/readiness.js';
import type { DbInstance } from '../types.js';

const router: RouterType = Router();

router.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    wsClients: getConnectedClientCount(),
    memory: {
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    },
  });
});

/**
 * Readiness, separate from the liveness route above.
 *
 * `/api/health` must keep answering `200` for anything that only needs to know
 * the process is up — the desktop local-runtime companion and the deployment
 * runbook both depend on that contract. `/api/ready` is the check a load
 * balancer or operator should use, because it answers `503` when a required
 * dependency is unreachable.
 */
export function readinessRouter(db: DbInstance): RouterType {
  const readiness: RouterType = Router();

  readiness.get('/ready', async (_req, res, next) => {
    try {
      const report = await checkReadiness(db);
      res.status(report.status === 'ok' ? 200 : 503).json(report);
    } catch (error) {
      next(error);
    }
  });

  return readiness;
}

export default router;
