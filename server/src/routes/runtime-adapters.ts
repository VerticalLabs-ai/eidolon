import { Router } from 'express';
import { listRuntimeAdapterDescriptors } from '../providers/index.js';

export function runtimeAdaptersRouter(): Router {
  const router = Router();

  router.get('/adapters', (_req, res) => {
    res.json({ data: listRuntimeAdapterDescriptors() });
  });

  return router;
}
