import { Router } from 'express';
import type { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import { missionErrorSanitizer } from '../middleware/mission-error-sanitizer.js';
import { isFeatureEnabled } from '../services/feature-flags.js';
import { routeParams } from '../utils/route-params.js';
import { validateIdempotencyKey } from '../services/mission/idempotency.js';
import { ModeRegistryService } from '../services/mission/mode-registry.js';
import {
  CreateProfileBody,
  UpdateProfileBody,
  ListProfilesQuery,
} from '../services/mission/mode-profile-schema.js';
import type { DbInstance } from '../types.js';

/**
 * Mode registry routes for company-defined custom Mission mode profiles.
 *
 * Declared routes (VAL-MODEQ-153):
 *   GET   /api/companies/:companyId/mission-mode-profiles
 *   POST  /api/companies/:companyId/mission-mode-profiles
 *   GET   /api/companies/:companyId/mission-mode-profiles/:profileId
 *   PATCH /api/companies/:companyId/mission-mode-profiles/:profileId
 *
 * Writes require company.settings.update permission (owner/admin only),
 * Idempotency-Key header, and PATCH If-Match row version. Reads require
 * company.view. Foreign IDs return 404 (non-enumerating). Disabled IDs
 * remain readable to administrators but are absent from selectable results.
 *
 * Profile deletion is not a Phase 1 operation; disabled (enabled=false)
 * is the sole unavailable lifecycle (VAL-MODEQ-124).
 */

function requireMissionEnabled(companyId: string): void {
  if (!isFeatureEnabled('missionAgentIntelligence', companyId)) {
    throw new AppError(
      404,
      'FEATURE_NOT_AVAILABLE',
      'Mission mode profiles are not available for this company',
    );
  }
}

/** Parse If-Match header as integer version: "<version>". */
function parseProfileIfMatch(header: string | undefined): number {
  if (!header) {
    throw new AppError(
      428,
      'PRECONDITION_REQUIRED',
      'If-Match header with profile version is required for PATCH',
    );
  }
  const match = /^"(\d+)"$/.exec(header.trim());
  if (!match) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'If-Match must be a quoted profile version, e.g. "3"',
    );
  }
  return Number(match[1]);
}

export function missionModeProfilesRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });

  // GET /api/companies/:companyId/mission-mode-profiles
  // List company profiles, ordered by normalized name/profile-ID, at most
  // 100 per page with opaque keyset cursors. includeDisabled is admin-only
  // (the route middleware enforces company.settings.update for non-GET).
  // Here we check the caller's role for includeDisabled.
  router.get('/', async (req, res) => {
    const { companyId } = routeParams(req);

    const parsed = ListProfilesQuery.safeParse(req.query);
    if (!parsed.success) {
      throw parsed.error;
    }
    const { limit, cursor, includeDisabled } = parsed.data;

    // includeDisabled requires admin permission; viewers/members get
    // enabled-only results. The route-level middleware already ensured
    // company.view, so we check the membership role here.
    const role = (req.organizationMembership?.role ?? 'viewer') as
      'owner' | 'admin' | 'member' | 'viewer';
    const canSeeDisabled = role === 'owner' || role === 'admin';

    const service = new ModeRegistryService(db);
    const result = await service.listProfiles({
      companyId,
      limit,
      cursor,
      includeDisabled: includeDisabled && canSeeDisabled,
    });

    res.json({ data: { profiles: result.profiles, nextCursor: result.nextCursor } });
  });

  // POST /api/companies/:companyId/mission-mode-profiles
  router.post('/', validate(CreateProfileBody), async (req, res) => {
    const { companyId } = routeParams(req);
    const body = req.body as z.infer<typeof CreateProfileBody>;

    requireMissionEnabled(companyId);
    // Validate Idempotency-Key is present and well-formed (creates reject
    // without it). The key is validated but not stored for profile creation.
    validateIdempotencyKey(req.get('Idempotency-Key'));

    const service = new ModeRegistryService(db);
    const result = await service.createProfile({
      companyId,
      body,
      actorType: 'user',
      actorId: req.user?.id ?? null,
      traceId: req.traceId ?? null,
    });

    res
      .status(201)
      .setHeader('ETag', `"${result.profile.version}"`)
      .json({ data: { profile: result.profile } });
  });

  // GET /api/companies/:companyId/mission-mode-profiles/:profileId
  // Reads a single profile by ID. Foreign IDs return 404 (non-enumerating).
  // Disabled profiles remain readable (to all company members with view
  // permission) so administrators can inspect/manage them.
  router.get('/:profileId', async (req, res) => {
    const { companyId, profileId } = routeParams(req);

    const service = new ModeRegistryService(db);
    const profile = await service.getProfile({ companyId, profileId });

    if (!profile) {
      throw new AppError(404, 'PROFILE_NOT_FOUND', 'Profile not found');
    }

    res.setHeader('ETag', `"${profile.version}"`).json({ data: { profile } });
  });

  // PATCH /api/companies/:companyId/mission-mode-profiles/:profileId
  // Update a profile. Requires If-Match row version. Can update name,
  // description, config, and enabled (disable/enable). Version increments
  // on every successful update. Stale version → 412 PROFILE_VERSION_MISMATCH.
  router.patch('/:profileId', validate(UpdateProfileBody), async (req, res) => {
    const { companyId, profileId } = routeParams(req);
    const body = req.body as z.infer<typeof UpdateProfileBody>;

    requireMissionEnabled(companyId);
    validateIdempotencyKey(req.get('Idempotency-Key'));
    const expectedVersion = parseProfileIfMatch(req.get('If-Match'));

    const service = new ModeRegistryService(db);
    const result = await service.updateProfile({
      companyId,
      profileId,
      body,
      expectedVersion,
      actorType: 'user',
      actorId: req.user?.id ?? null,
      traceId: req.traceId ?? null,
    });

    res
      .setHeader('ETag', `"${result.profile.version}"`)
      .json({ data: { profile: result.profile } });
  });

  // Mission error sanitizer for safe error responses.
  router.use(missionErrorSanitizer);

  return router;
}
