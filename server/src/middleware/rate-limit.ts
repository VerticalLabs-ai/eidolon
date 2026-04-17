import rateLimit, { type Options } from 'express-rate-limit';
import {
  RATE_LIMIT_REQUESTS_PER_WINDOW,
  RATE_LIMIT_WINDOW_MS,
} from '@eidolon/shared';
import logger from '../utils/logger.js';

const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

/**
 * Skip rate limiting entirely in test environments so unit tests don't get
 * throttled, and in `local_trusted` mode where the server is bound to loopback
 * and exposed to a single human operator.
 */
function shouldSkip(): boolean {
  return isTest || process.env.AUTH_MODE === 'local_trusted';
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
