// ---------------------------------------------------------------------------
// Evaluated feature flags for the caller's company
// ---------------------------------------------------------------------------
//
// GET /api/companies/:companyId/flags
//
// Returns: { data: { subject, flags: Record<declaredFlagName, boolean> } }
//
// Auth: requireAuth + requirePermission('company.view'), mounted in app.ts, so
// a caller can only read the evaluation for a company it belongs to.
//
// The response carries declared flag names with a boolean outcome and nothing
// else. It deliberately does not expose:
//   - the raw EIDOLON_FEATURE_FLAGS value, which is operator configuration and
//     may name unreleased work,
//   - rolloutPercentage, which describes the population rather than the caller,
//   - any other subject's assignment.
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { evaluateFeatureFlags } from '../services/feature-flags.js';
import { routeParams } from '../utils/route-params.js';

export function featureFlagsRouter(): Router {
  const router = Router({ mergeParams: true });

  router.get('/', (req, res) => {
    const { companyId } = routeParams(req);
    res.json({ data: { subject: companyId, flags: evaluateFeatureFlags(companyId) } });
  });

  return router;
}
