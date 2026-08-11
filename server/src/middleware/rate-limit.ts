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

/**
 * Strict rate-limit for auth-sensitive endpoints (MFA verify, step-up
 * re-auth, local-trusted session creation) — the brute-force surface
 * (VAL-SEC-009).
 *
 * Unlike `apiRateLimit`/`authRateLimit`, this limiter is **always active** in
 * dev and `local_trusted` mode so the 429 posture is demonstrable without
 * flipping `NODE_ENV=production`. The test suite opts out via the
 * `EIDOLON_RATE_LIMIT_TEST_BYPASS=1` env var (set in `test-setup.ts`) so the
 * deterministic real-Postgres suite never self-throttles.
 *
 * The limit defaults to 10 requests per 15-minute window per IP — tight
 * enough that a rapid repeated burst (e.g. curl loop brute-forcing MFA
 * codes) is throttled with 429, while a normal interactive flow (a handful
 * of verify/step-up calls) is unaffected. Override with
 * `RATE_LIMIT_AUTH_SENSITIVE_MAX`.
 */
function shouldSkipAuthSensitive(): boolean {
  if (process.env.EIDOLON_RATE_LIMIT_TEST_BYPASS === '1') return true;
  return false;
}

export const authSensitiveRateLimit = rateLimit({
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: shouldSkipAuthSensitive,
  windowMs: RATE_LIMIT_WINDOW_MS,
  // Function form so the limit can be tuned at runtime (e.g. a low limit for
  // validation/verification of the 429 posture) without redeploying.
  max: () => Number(process.env.RATE_LIMIT_AUTH_SENSITIVE_MAX ?? 10),
  handler: (req, res, _next, options) => {
    logger.warn(
      {
        ip: req.ip,
        path: req.path,
        method: req.method,
        limit: options.max,
      },
      'Auth-sensitive rate limit exceeded',
    );
    res.status(429).json({
      status: 429,
      code: 'RATE_LIMITED',
      message: 'Too many requests to this sensitive endpoint. Please wait and try again.',
    });
  },
});
