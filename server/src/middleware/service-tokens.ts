import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
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

function canonicalJson(value: unknown): string {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function signServiceRequest(
  tokenHash: string,
  method: string,
  path: string,
  timestamp: number,
  body?: unknown,
): string {
  const bodyHash = createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
  const message = `${method.toUpperCase()}\n${path}\n${timestamp}\n${bodyHash}`;
  return createHmac('sha256', Buffer.from(tokenHash, 'hex')).update(message, 'utf8').digest('hex');
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of req.get('cookie')?.split(';') ?? []) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(value.join('='));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
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
  logger.info({
    configuredServiceTokens: tokens.length,
    configuredFingerprints: tokens.map((token) => token.tokenHash.slice(0, 12)),
  }, 'Scoped service tokens configured');
  const requireOrgMember = deps.requireOrgMember();

  function matchToken(req: Request): ScopedServiceToken | null {
    const machineToken = req.get('x-eidolon-service-token');
    const bearerToken = req.get('authorization')?.replace(/^Bearer\s+/i, '');
    const cookieToken = readCookie(req, 'eidolon_service_token');
    const suppliedToken = machineToken ?? bearerToken ?? cookieToken;
    if (!suppliedToken || tokens.length === 0) {
      const name = typeof req.query.service === 'string' ? req.query.service : '';
      const timestamp = typeof req.query.ts === 'string' ? Number(req.query.ts) : NaN;
      const signature = typeof req.query.sig === 'string' ? req.query.sig : '';
      const token = tokens.find((candidate) => candidate.name === name);
      if (!token || !Number.isInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 60 || !/^[a-f0-9]{64}$/.test(signature)) {
        return null;
      }
      const expected = signServiceRequest(
        token.tokenHash,
        req.method,
        req.originalUrl.split('?', 1)[0]!,
        timestamp,
        req.body,
      );
      if (timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))) return token;
      logger.warn({
        signedService: name,
        expectedFingerprint: expected.slice(0, 12),
        suppliedFingerprint: signature.slice(0, 12),
      }, 'Signed service request did not match');
      return null;
    }
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
        serviceCookiePresent: Boolean(cookieToken),
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
