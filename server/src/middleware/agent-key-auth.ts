import { createHash } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import { AppError } from './error-handler.js';
import logger from '../utils/logger.js';
import type { DbInstance } from '../types.js';

/**
 * Agent API key prefix. All agent API keys start with this string.
 * Tokens starting with this prefix are treated as agent key attempts;
 * if the key is not found in the database the request is rejected with
 * 401 (it does NOT fall through to session auth).
 */
export const AGENT_KEY_PREFIX = 'eid_live_';

/**
 * SHA-256 hex hash of a raw agent API key. Used both for storage (by the
 * CRUD service) and for lookup during authentication.
 */
export function hashAgentKey(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Create the agent API key authentication middleware.
 *
 * `tryAgentKeyAuth` is mounted before company-scoped routes. It intercepts
 * Bearer tokens that start with `eid_live_`, looks up the corresponding
 * `agent_api_keys` row by SHA-256 hash, validates expiry and revocation,
 * updates `lastUsedAt`, and sets a synthetic agent identity on the request.
 *
 * If no Bearer token is present, or the token does not start with
 * `eid_live_`, the middleware calls `next()` immediately so the request
 * falls through to service-token or session-based auth.
 *
 * If a token DOES start with `eid_live_` but is not found, expired, or
 * revoked, the middleware rejects with 401 — it does NOT fall through.
 */
export function createAgentKeyMiddleware(db: DbInstance): {
  tryAgentKeyAuth: RequestHandler;
} {
  async function tryAgentKeyAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const bearerToken = req.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!bearerToken) {
      return next();
    }

    // Only treat tokens with the eid_live_ prefix as agent API keys.
    // Other bearer tokens fall through to service-token or session auth.
    if (!bearerToken.startsWith(AGENT_KEY_PREFIX)) {
      return next();
    }

    const keyHash = hashAgentKey(bearerToken);

    try {
      const [key] = await db.drizzle
        .select()
        .from(db.schema.agentApiKeys)
        .where(
          and(
            eq(db.schema.agentApiKeys.keyHash, keyHash),
            isNull(db.schema.agentApiKeys.revokedAt),
          ),
        )
        .limit(1);

      if (!key) {
        return next(new AppError(401, 'UNAUTHORIZED', 'Invalid or unknown API key'));
      }

      // Check expiry if set
      if (key.expiresAt && key.expiresAt.getTime() < Date.now()) {
        return next(new AppError(401, 'UNAUTHORIZED', 'API key has expired'));
      }

      // Update lastUsedAt (fire-and-forget — don't block the request)
      db.drizzle
        .update(db.schema.agentApiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(db.schema.agentApiKeys.id, key.id))
        .execute()
        .catch((err: unknown) => {
          logger.warn({ err, keyId: key.id }, 'Failed to update agent key lastUsedAt');
        });

      // Set synthetic agent identity
      const agentUserId = `agent:${key.id}`;
      req.user = {
        id: agentUserId,
        name: key.name,
        email: '',
      };
      req.organizationMembership = {
        id: key.id,
        role: key.role,
        organizationId: key.companyId,
        userId: agentUserId,
      };

      next();
    } catch (err) {
      logger.debug({ err }, 'Agent key auth: lookup failed');
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication failed'));
    }
  }

  return { tryAgentKeyAuth };
}
