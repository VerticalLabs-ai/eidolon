import type { NextFunction, Request, Response } from 'express';
import logger from '../utils/logger.js';
import { AppError } from './error-handler.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Exact paths / prefixes that bypass origin enforcement. These routes
 * authenticate on their own (HMAC signatures, auth handshakes, MCP stdio
 * probes) so same-site cookies aren't load-bearing for them.
 */
const BYPASS_PREFIXES = [
  '/api/auth/', // Clerk / BetterAuth handshake
  '/api/webhooks/', // Inbound webhook trigger (HMAC-verified)
  '/api/health',
];

function shouldBypass(originalUrl: string): boolean {
  // Strip query string before matching — mount order means req.originalUrl
  // still includes /api.
  const path = originalUrl.split('?', 1)[0];
  return BYPASS_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function allowedOrigins(): string[] {
  const raw = process.env.CORS_ORIGIN ?? '';
  const fromEnv = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (fromEnv.length > 0) return fromEnv;

  // Sensible dev defaults — mirror the BetterAuth / app CORS defaults.
  return [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5173',
  ];
}

function normalize(origin: string | undefined | null): string | null {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/**
 * Origin-based CSRF defense for state-changing requests.
 *
 * Rationale: Clerk (and BetterAuth) rely on same-site cookies for session
 * transport. Same-site already blocks the classic top-level POST / form-
 * submit CSRF paths, but an explicit Origin check closes a few remaining
 * gaps (CORS misconfig, subdomain hijack, browser bugs) at essentially
 * zero cost. The check matches the `fetch` Origin / Referer against the
 * same allowlist the app already ships for CORS.
 *
 * Bypass matrix:
 *   - GET / HEAD / OPTIONS: always allowed (safe methods).
 *   - /api/auth/*           : Clerk/BetterAuth handshake — provider-authed.
 *   - /api/webhooks/*       : HMAC-signed inbound webhooks.
 *   - /api/health           : public liveness.
 *   - `local_trusted` mode  : loopback-only single-operator dev mode.
 *   - `NODE_ENV=test`       : test harness never issues a browser Origin.
 */
export function originCsrf(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (SAFE_METHODS.has(req.method)) return next();
  if (shouldBypass(req.originalUrl)) return next();
  if (process.env.EIDOLON_DISABLE_CSRF === '1') return next();
  if (process.env.AUTH_MODE === 'local_trusted') return next();
  if (process.env.NODE_ENV === 'test') return next();
  if (process.env.VITEST === 'true' || process.env.VITEST_WORKER_ID) return next();

  const origin = normalize(req.get('origin')) ?? normalize(req.get('referer'));

  if (!origin) {
    logger.warn(
      { path: req.path, method: req.method },
      'CSRF: missing Origin/Referer on state-changing request',
    );
    return next(new AppError(403, 'CSRF_MISSING_ORIGIN', 'Missing Origin header'));
  }

  const allowed = allowedOrigins().map(normalize).filter(Boolean) as string[];
  if (!allowed.includes(origin)) {
    logger.warn(
      { path: req.path, method: req.method, origin, allowed },
      'CSRF: Origin not in allowlist',
    );
    return next(
      new AppError(403, 'CSRF_ORIGIN_REJECTED', `Origin "${origin}" is not permitted`),
    );
  }

  next();
}
