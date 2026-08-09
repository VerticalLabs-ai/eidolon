import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { routeParams } from '../utils/route-params.js';
import {
  createFolder,
  listFolders,
  getFolder,
  updateFolder,
  deleteFolder,
} from '../services/folder-service.js';
import type { DbInstance } from '../types.js';

const CreateBody = z.object({
  name: z.string().trim().min(1).max(200),
  projectId: z.string().uuid().nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
});

const UpdateBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  parentId: z.string().uuid().nullable().optional(),
});

const ListQuery = z.object({
  projectId: z.union([z.string().uuid(), z.literal('null')]).optional(),
});

export function foldersRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });

  router.post('/folders', validate(CreateBody), async (req, res) => {
    const { companyId } = routeParams(req);
    const row = await createFolder(db, companyId, (req as any).validated.body);
    res.status(201).json({ data: row });
  });

  router.get('/folders', validate(ListQuery, 'query'), async (req, res) => {
    const { companyId } = routeParams(req);
    const query = (req as any).validated.query;
    const projectId = query.projectId === 'null' ? null : query.projectId;
    const rows = await listFolders(db, companyId, projectId);
    res.json({ data: rows });
  });

  router.get('/folders/:id', async (req, res) => {
    const { companyId, id } = routeParams(req);
    res.json({ data: await getFolder(db, companyId, id) });
  });

  router.patch('/folders/:id', validate(UpdateBody), async (req, res) => {
    const { companyId, id } = routeParams(req);
    res.json({ data: await updateFolder(db, companyId, id, (req as any).validated.body) });
  });

  router.delete('/folders/:id', async (req, res) => {
    const { companyId, id } = routeParams(req);
    await deleteFolder(db, companyId, id);
    res.status(204).end();
  });

  return router;
}
