import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import { isFeatureEnabled } from '../services/feature-flags.js';
import { routeParams } from '../utils/route-params.js';
import { validateProjectOwnership } from '../utils/project-validation.js';
import { MissionStartService } from '../services/mission/start.js';
import {
  MissionSnapshotService,
  isValidStatus,
  decodeCursor,
} from '../services/mission/snapshot.js';
import type { DbInstance } from '../types.js';

const MODES = ['fast', 'deep_work', 'analyst', 'auto'] as const;

const StartBody = z.object({
  projectThreadId: z.string().uuid(),
  mode: z.enum(MODES),
  initiatingAgentId: z.string().uuid().optional(),
  request: z.object({
    text: z.string().trim().min(1).max(20_000),
    attachments: z.array(z.string().uuid()).max(20).optional(),
    context: z.record(z.unknown()).optional(),
  }),
  limits: z
    .object({
      costCents: z.number().int().positive().optional(),
      totalTokens: z.number().int().positive().optional(),
      durationSeconds: z.number().int().positive().optional(),
      providerCalls: z.number().int().positive().optional(),
      steps: z.number().int().positive().optional(),
      outputBytes: z.number().int().positive().optional(),
    })
    .optional(),
});

const ListQuery = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});

/** Validate the Idempotency-Key header: 1-128 safe chars, no controls, no
 *  leading/trailing whitespace. Missing or invalid → 400 VALIDATION_ERROR. */
function requireIdempotencyKey(req: { get: (h: string) => string | undefined }): string {
  const raw = req.get('Idempotency-Key');
  if (!raw || raw.length === 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Idempotency-Key header is required');
  }
  const key = raw;
  if (key.length > 128) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Idempotency-Key must be at most 128 characters');
  }
  if (key !== key.trim()) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Idempotency-Key must not have leading or trailing whitespace',
    );
  }
  // eslint-disable-next-line no-control-regex -- intentional: reject control chars in the idempotency key
  if (/[\u0000-\u001F\u007F]/.test(key)) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Idempotency-Key must not contain control characters',
    );
  }
  return key;
}

function requireMissionEnabled(companyId: string): void {
  if (!isFeatureEnabled('missionAgentIntelligence', companyId)) {
    throw new AppError(
      404,
      'FEATURE_NOT_AVAILABLE',
      'Mission runs are not available for this company',
    );
  }
}

/**
 * Parse a strong quoted ETag from an If-None-Match header. Returns the
 * unquoted state-version string, or null when the header is absent or does
 * not match the `"<version>"` strong-ETag shape used by Mission snapshots.
 */
function parseIfNoneMatch(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  // Accept a single strong quoted ETag. Weak prefixes (W/) are not used by
  // Mission snapshots and are not treated as a match.
  const match = /^"([^"]+)"$/.exec(header.trim());
  return match ? match[1] : null;
}

export function missionRunsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });

  // GET /api/companies/:companyId/projects/:projectId/mission-runs
  // Scoped run list with stable opaque keyset pagination and status filter.
  router.get('/', async (req, res) => {
    const { companyId, projectId } = routeParams(req);

    await validateProjectOwnership(db, companyId, projectId);

    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      throw parsed.error; // caught by errorHandler as ZodError → 400 VALIDATION_ERROR
    }
    const { status, limit, cursor } = parsed.data;
    if (status !== undefined && !isValidStatus(status)) {
      throw new AppError(400, 'VALIDATION_ERROR', `Unknown status filter: ${status}`);
    }
    // Decode the cursor early so a malformed cursor is a 400, not a 500.
    decodeCursor(cursor);

    const service = new MissionSnapshotService(db);
    const result = await service.listRuns({ companyId, projectId, status, limit, cursor });

    res.json({ data: { runs: result.runs, nextCursor: result.nextCursor } });
  });

  // POST /api/companies/:companyId/projects/:projectId/mission-runs
  router.post('/', validate(StartBody), async (req, res) => {
    const { companyId, projectId } = routeParams(req);
    const body = req.body as z.infer<typeof StartBody>;

    await validateProjectOwnership(db, companyId, projectId);
    requireMissionEnabled(companyId);
    const idempotencyKey = requireIdempotencyKey(req);

    const service = new MissionStartService(db);
    const result = await service.start({
      companyId,
      projectId,
      idempotencyKey,
      body,
      actorType: 'user',
      actorId: req.user?.id ?? null,
      traceId: req.traceId ?? null,
    });

    const location = `/api/companies/${companyId}/projects/${projectId}/mission-runs/${result.run.id}`;
    const linksUi = `/companies/${companyId}/projects/${projectId}?thread=${body.projectThreadId}&run=${result.run.id}`;

    res
      .status(202)
      .location(location)
      .setHeader('ETag', `"${result.run.stateVersion}"`)
      .json({
        data: { run: result.run, command: result.command },
        links: { ui: linksUi },
      });
  });

  // GET /api/companies/:companyId/projects/:projectId/mission-runs/:runId
  // Authoritative complete snapshot with strong ETag and conditional refresh.
  router.get('/:runId', async (req, res) => {
    const { companyId, projectId, runId } = routeParams(req);

    await validateProjectOwnership(db, companyId, projectId);

    const service = new MissionSnapshotService(db);
    const snapshot = await service.getSnapshot(companyId, projectId, runId);

    const etag = `"${snapshot.stateVersion}"`;
    res.setHeader('ETag', etag);

    // Conditional refresh: a matching strong ETag returns 304 with no body.
    const ifNoneMatch = parseIfNoneMatch(req.get('If-None-Match'));
    if (ifNoneMatch !== null && ifNoneMatch === String(snapshot.stateVersion)) {
      res.status(304).end();
      return;
    }

    res.json({ data: { run: snapshot, links: snapshot.links } });
  });

  return router;
}
