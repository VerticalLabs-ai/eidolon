import type { RequestHandler } from 'express';
import { AppError } from './error-handler.js';
import { isFeatureEnabled, type FeatureFlagName } from '../services/feature-flags.js';
import { routeParams } from '../utils/route-params.js';

/**
 * Gate a route on a company-scoped feature flag.
 *
 * The evaluator applies flag dependencies, including the Phase 2 requirement
 * that missionAgentIntelligence is enabled. A disabled flag is deliberately
 * reported as not found so callers cannot enumerate unreleased features.
 */
export function requireFeatureFlag(flag: FeatureFlagName): RequestHandler {
  return (req, _res, next) => {
    const { companyId } = routeParams(req);
    if (!isFeatureEnabled(flag, companyId)) {
      next(new AppError(404, 'FEATURE_NOT_AVAILABLE', 'This feature is not available'));
      return;
    }
    next();
  };
}
