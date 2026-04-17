import rateLimit, { type Options } from 'express-rate-limit';
import {
  RATE_LIMIT_REQUESTS_PER_WINDOW,
  RATE_LIMIT_WINDOW_MS,
} from '@eidolon/shared';
import logger from '../utils/logger.js';

/**
 * Rate limiting is **opt-in**. It only fires when:
 *   - `NODE_ENV=production`, OR
 *   - `RATE_LIMIT_ENABLED=1` is explicitly set.
 *
 * Every other environment — dev, test, local_trusted — skips the limiter so
 * the test suite, local smoke, and loopback dev loops never self-throttle.
 * Production deploys flip this on automatically via NODE_ENV.
 */
function shouldSkip(): boolean {
  if (process.env.RATE_LIMIT_ENABLED === '1') return false;
  if (process.env.NODE_ENV === 'production') return false;
  return true;
}

const commonOptions: Partial<Options> = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: shouldSkip,
  handler: (req, res, _next, options) => {
    logger.warn(
      {
        ip: req.ip,
        path: req.path,
        method: req.method,
        limit: options.max,
      },
      'Rate limit exceeded',
    );
    res.status(options.statusCode).json({
      status: options.statusCode,
      code: 'RATE_LIMITED',
      message:
        'Too many requests from this IP. Please wait and try again shortly.',
    });
  },
};

/**
 * Strict rate-limit for authentication endpoints.
 *
 * 20 requests per 15-minute window per IP covers normal sign-in / sign-up /
 * password-reset flows with comfortable headroom, while blunting credential
 * stuffing and brute-force attempts.
 */
export const authRateLimit = rateLimit({
  ...commonOptions,
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: 20,
});

/**
 * Broader rate-limit for authenticated API traffic. Per-IP rather than
 * per-user because `req.user` is not populated until the auth middleware
 * runs. Cranked higher than RATE_LIMIT_REQUESTS_PER_WINDOW because a single
 * user driving the UI can easily exceed 100 API calls in 15 minutes.
 */
export const apiRateLimit = rateLimit({
  ...commonOptions,
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_REQUESTS_PER_WINDOW * 6,
});
