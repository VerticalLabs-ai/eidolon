import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from './error-handler.js';
import logger from '../utils/logger.js';

export type ServiceScope = 'prompts:read' | 'prompts:write';

export interface ScopedServiceToken {
  name: string;
  companyId: string;
  tokenHash: string;
  scopes: ServiceScope[];
}

interface ServiceTokenMiddlewareDeps {
  requireAuth: RequestHandler;
  requireOrgMember: () => RequestHandler;
  tokens?: ScopedServiceToken[];
}

declare global {
  namespace Express {
    interface Request {
      servicePrincipal?: {
        name: string;
        companyId: string;
        scopes: ServiceScope[];
      };
    }
  }
}

export function hashServiceToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function parseServiceTokens(raw = process.env.EIDOLON_SERVICE_TOKENS_JSON): ScopedServiceToken[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.error('EIDOLON_SERVICE_TOKENS_JSON is not valid JSON; service-token access disabled');
    return [];
  }
  if (!Array.isArray(parsed)) {
    logger.error('EIDOLON_SERVICE_TOKENS_JSON must be an array; service-token access disabled');
    return [];
  }

  const allowed = new Set<ServiceScope>(['prompts:read', 'prompts:write']);
  const valid = parsed.filter((entry): entry is ScopedServiceToken => {
    if (!entry || typeof entry !== 'object') return false;
    const candidate = entry as Partial<ScopedServiceToken>;
    return typeof candidate.name === 'string'
      && candidate.name.length > 0
      && typeof candidate.companyId === 'string'
      && candidate.companyId.length > 0
      && typeof candidate.tokenHash === 'string'
      && /^[a-f0-9]{64}$/.test(candidate.tokenHash)
      && Array.isArray(candidate.scopes)
      && candidate.scopes.length > 0
      && candidate.scopes.every((scope) => allowed.has(scope));
  });
  if (valid.length !== parsed.length) {
    logger.error('Invalid scoped service-token entries ignored');
  }
  return valid;
}

function hasScope(token: Pick<ScopedServiceToken, 'scopes'>, required: ServiceScope): boolean {
  return token.scopes.includes(required)
    || (required === 'prompts:read' && token.scopes.includes('prompts:write'));
}

export function createServiceTokenMiddleware(deps: ServiceTokenMiddlewareDeps) {
  const tokens = deps.tokens ?? parseServiceTokens();
  logger.info({ configuredServiceTokens: tokens.length }, 'Scoped service tokens configured');
  const requireOrgMember = deps.requireOrgMember();

  function matchToken(req: Request): ScopedServiceToken | null {
    const machineToken = req.get('x-eidolon-service-token');
    const bearerToken = req.get('authorization')?.replace(/^Bearer\s+/i, '');
    const suppliedToken = machineToken ?? bearerToken;
    if (!suppliedToken || tokens.length === 0) return null;
    const suppliedHash = hashServiceToken(suppliedToken);
    const supplied = Buffer.from(suppliedHash, 'hex');
    const matched = tokens.find((token) => {
      const expected = Buffer.from(token.tokenHash, 'hex');
      return expected.length === supplied.length && timingSafeEqual(expected, supplied);
    }) ?? null;
    if (!matched) {
      logger.warn({
        machineHeaderPresent: Boolean(machineToken),
        bearerHeaderPresent: Boolean(bearerToken),
        suppliedFingerprint: suppliedHash.slice(0, 12),
        configuredFingerprints: tokens.map((token) => token.tokenHash.slice(0, 12)),
      }, 'Scoped service token did not match');
    }
    return matched;
  }

  function requireServiceOrOrgMember(scope: ServiceScope): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
      const service = matchToken(req);
      if (service) {
        const companyId = String(req.params.companyId ?? '');
        if (service.companyId !== companyId) {
          return next(new AppError(403, 'SERVICE_TOKEN_COMPANY_MISMATCH', 'Service token is not valid for this company'));
        }
        if (!hasScope(service, scope)) {
          return next(new AppError(403, 'SERVICE_TOKEN_SCOPE_REQUIRED', `Service token requires ${scope}`));
        }
        req.servicePrincipal = {
          name: service.name,
          companyId: service.companyId,
          scopes: service.scopes,
        };
        return next();
      }

      deps.requireAuth(req, res, (error?: unknown) => {
        if (error) return next(error);
        requireOrgMember(req, res, next);
      });
    };
  }

  function requireServiceScope(scope: ServiceScope): RequestHandler {
    return (req: Request, _res: Response, next: NextFunction): void => {
      if (req.servicePrincipal && !hasScope(req.servicePrincipal, scope)) {
        return next(new AppError(403, 'SERVICE_TOKEN_SCOPE_REQUIRED', `Service token requires ${scope}`));
      }
      next();
    };
  }

  return { requireServiceOrOrgMember, requireServiceScope };
}
