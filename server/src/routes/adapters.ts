import { Router } from 'express';
import { listAdapters } from '../providers/index.js';

/**
 * GET /api/adapters — return the set of registered agent runtimes with their
 * capability flags and supported models. This lets the UI show capability
 * badges (streaming, tools, vision, reasoning, …) next to each provider and
 * will later let the orchestrator route work based on declared capabilities.
 */
export function adaptersRouter(): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const adapters = listAdapters().map((a) => ({
      id: a.id ?? a.name,
      name: a.name,
      kind: a.kind ?? 'provider',
      locality: a.locality ?? (a.capabilities.local ? 'local' : 'cloud'),
      description: a.description ?? null,
      supportedModes: a.supportedModes ?? ['on_demand'],
      capabilities: a.capabilities,
      models: a.models,
    }));
    res.json({ data: adapters });
  });

  return router;
}
