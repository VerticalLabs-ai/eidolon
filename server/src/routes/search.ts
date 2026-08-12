// ---------------------------------------------------------------------------
// Cross-artifact search route (M1 — Artifact Intelligence & Discovery)
// ---------------------------------------------------------------------------
//
// GET /api/companies/:companyId/search
//
// Query params:
//   q              (required) search term, min 2 chars after trim
//   type           (optional) restrict artifacts to a single ArtifactType
//   folderId       (optional) restrict artifacts to a folder
//   authorId       (optional) restrict artifacts to a creator (created_by_user_id)
//   dateFrom       (optional) ISO date — artifacts/threads/tasks updated/created on or after
//   dateTo         (optional) ISO date — artifacts/threads/tasks updated/created on or before
//   limit          (optional, default 20, max 100) page size
//   offset         (optional, default 0) page offset
//   includeArchived(optional, default false) include archived artifacts
//
// Returns: { results: SearchResult[], total: number, query: string }
//
// Auth: requireAuth + requireOrgMember (mounted in app.ts). Empty or
// whitespace-only query → 400. Query shorter than 2 chars → 400.
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { z } from 'zod';
import { ArtifactTypeSchema } from '@eidolon/shared';
import { AppError } from '../middleware/error-handler.js';
import { routeParams } from '../utils/route-params.js';
import { search } from '../services/search-service.js';
import type { DbInstance } from '../types.js';

const MAX_LIMIT = 100;
const MAX_OFFSET = 10_000;
const DEFAULT_LIMIT = 20;
const MIN_QUERY_LENGTH = 2;

/** Coerce a query-param value to a single string (Express 5 may return arrays). */
function asString(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
  return typeof v === 'string' ? v : undefined;
}

export function searchRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });

  router.get('/', async (req, res) => {
    const { companyId } = routeParams(req);
    const rawQ = asString(req.query.q);

    // ── Query validation ────────────────────────────────────────────────
    if (rawQ === undefined) {
      throw new AppError(400, 'SEARCH_QUERY_REQUIRED', 'Query parameter "q" is required');
    }
    const q = rawQ.trim();
    if (q.length === 0) {
      throw new AppError(400, 'SEARCH_QUERY_EMPTY', 'Query must not be empty');
    }
    if (q.length < MIN_QUERY_LENGTH) {
      throw new AppError(
        400,
        'SEARCH_QUERY_TOO_SHORT',
        `Query must be at least ${MIN_QUERY_LENGTH} characters`,
      );
    }

    // ── Parse optional filters ──────────────────────────────────────────
    const typeRaw = asString(req.query.type);
    let type: z.infer<typeof ArtifactTypeSchema> | undefined;
    if (typeRaw !== undefined) {
      const parsed = ArtifactTypeSchema.safeParse(typeRaw);
      if (!parsed.success) {
        throw new AppError(400, 'SEARCH_INVALID_TYPE', `Invalid artifact type: ${typeRaw}`);
      }
      type = parsed.data;
    }

    const folderId = asString(req.query.folderId);
    const authorId = asString(req.query.authorId);

    const dateFromRaw = asString(req.query.dateFrom);
    const dateToRaw = asString(req.query.dateTo);
    let dateFrom: Date | undefined;
    let dateTo: Date | undefined;
    if (dateFromRaw !== undefined) {
      const d = new Date(dateFromRaw);
      if (Number.isNaN(d.getTime())) {
        throw new AppError(400, 'SEARCH_INVALID_DATE', `Invalid dateFrom: ${dateFromRaw}`);
      }
      dateFrom = d;
    }
    if (dateToRaw !== undefined) {
      const d = new Date(dateToRaw);
      if (Number.isNaN(d.getTime())) {
        throw new AppError(400, 'SEARCH_INVALID_DATE', `Invalid dateTo: ${dateToRaw}`);
      }
      dateTo = d;
    }

    // ── Pagination ──────────────────────────────────────────────────────
    const limitRaw = asString(req.query.limit);
    let limit = DEFAULT_LIMIT;
    if (limitRaw !== undefined) {
      const n = Number(limitRaw);
      if (!Number.isInteger(n) || n < 1) {
        throw new AppError(400, 'SEARCH_INVALID_LIMIT', 'limit must be a positive integer');
      }
      limit = Math.min(n, MAX_LIMIT);
    }

    const offsetRaw = asString(req.query.offset);
    let offset = 0;
    if (offsetRaw !== undefined) {
      const n = Number(offsetRaw);
      if (!Number.isInteger(n) || n < 0 || n > MAX_OFFSET) {
        throw new AppError(400, 'SEARCH_INVALID_OFFSET', `offset must be a non-negative integer no greater than ${MAX_OFFSET}`);
      }
      offset = n;
    }

    const includeArchivedRaw = asString(req.query.includeArchived);
    const includeArchived = includeArchivedRaw === 'true' || includeArchivedRaw === '1';

    // ── Execute search ──────────────────────────────────────────────────
    const result = await search(db, {
      companyId,
      query: q,
      type,
      folderId,
      authorId,
      dateFrom,
      dateTo,
      includeArchived,
      limit,
      offset,
    });

    res.json(result);
  });

  return router;
}
