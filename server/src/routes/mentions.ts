import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';
import { MentionService } from '../services/mention-service.js';

const MentionSearchQuery = z.object({
  q: z.string().max(255).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export function mentionsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });

  // GET /api/companies/:companyId/mentions/search
  // Returns company-scoped agents + teammates for the mention picker.
  router.get('/search', validate(MentionSearchQuery, 'query'), async (req, res) => {
    const { companyId } = routeParams(req);
    const query = (req as any).validated.query as z.infer<typeof MentionSearchQuery>;

    const mentionService = new MentionService(db);
    const results = await mentionService.searchMentionable(companyId, query.q ?? '', query.limit);

    res.json({ data: results });
  });

  return router;
}
