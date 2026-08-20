import { Router } from 'express';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import { isFeatureEnabled } from '../services/feature-flags.js';
import { routeParams } from '../utils/route-params.js';
import { validateProjectOwnership } from '../utils/project-validation.js';
import { MissionStartService } from '../services/mission/start.js';
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

export function missionRunsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const schema = db.schema;

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
      traceId: (req as any).traceId ?? null,
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
  router.get('/:runId', async (req, res) => {
    const { companyId, projectId, runId } = routeParams(req);

    await validateProjectOwnership(db, companyId, projectId);

    const [run] = await db.drizzle
      .select()
      .from(schema.missionRuns)
      .where(
        and(
          eq(schema.missionRuns.id, runId),
          eq(schema.missionRuns.companyId, companyId),
          eq(schema.missionRuns.projectId, projectId),
        ),
      )
      .limit(1);

    if (!run) {
      throw new AppError(404, 'RUN_NOT_FOUND', 'Mission run not found');
    }

    const [reservation] = await db.drizzle
      .select()
      .from(schema.budgetReservations)
      .where(eq(schema.budgetReservations.runId, run.id))
      .limit(1);

    let policyContentHash: string | null = null;
    if (run.policySnapshotId) {
      const [policy] = await db.drizzle
        .select({ contentHash: schema.runPolicySnapshots.contentHash })
        .from(schema.runPolicySnapshots)
        .where(eq(schema.runPolicySnapshots.id, run.policySnapshotId))
        .limit(1);
      policyContentHash = policy?.contentHash ?? null;
    }

    res.setHeader('ETag', `"${run.stateVersion}"`);
    res.json({
      data: {
        run: {
          id: run.id,
          companyId: run.companyId,
          projectId: run.projectId,
          projectThreadId: run.projectThreadId,
          status: run.status,
          stateVersion: run.stateVersion,
          lastEventSequence: Number(run.lastEventSequence),
          resolvedMode: run.resolvedMode,
          policySnapshotId: run.policySnapshotId,
          policyContentHash: policyContentHash,
          requestContentHash: run.requestContentHash,
          createdAt: run.createdAt.toISOString(),
          updatedAt: run.updatedAt.toISOString(),
          budget: reservation
            ? {
                reservedCents: reservation.reservedCents,
                settledCents: reservation.settledCents,
                releasedCents: reservation.releasedCents,
                costCentsCeiling: reservation.reservedCents,
              }
            : null,
        },
        links: {
          ui: `/companies/${companyId}/projects/${projectId}?thread=${run.projectThreadId}&run=${run.id}`,
        },
      },
    });
  });

  return router;
}
