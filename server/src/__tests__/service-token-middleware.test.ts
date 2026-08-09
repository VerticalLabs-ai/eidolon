import { describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { AppError, errorHandler } from '../middleware/error-handler.js';
import {
  createServiceTokenMiddleware,
  hashServiceToken,
  parseServiceTokens,
  signServiceRequest,
  type ScopedServiceToken,
} from '../middleware/service-tokens.js';

const READ_TOKEN = 'read-secret';
const WRITE_TOKEN = 'write-secret';
const COMPANY_ID = 'company-1';

const tokens: ScopedServiceToken[] = [
  { name: 'reader', companyId: COMPANY_ID, tokenHash: hashServiceToken(READ_TOKEN), scopes: ['prompts:read'] },
  { name: 'writer', companyId: COMPANY_ID, tokenHash: hashServiceToken(WRITE_TOKEN), scopes: ['prompts:write'] },
];

function testApp() {
  const app = express();
  app.use(express.json());
  const requireAuth = (_req: Request, _res: Response, next: NextFunction) =>
    next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
  const requireOrgMember = () => (_req: Request, _res: Response, next: NextFunction) => next();
  const { requireServiceOrOrgMember, requireServiceScope } = createServiceTokenMiddleware({
    requireAuth,
    requireOrgMember,
    tokens,
  });

  app.get(
    '/companies/:companyId/prompts',
    requireServiceOrOrgMember('prompts:read'),
    (req, res) => res.json({ principal: req.servicePrincipal }),
  );
  app.post(
    '/companies/:companyId/prompts',
    requireServiceOrOrgMember('prompts:read'),
    requireServiceScope('prompts:write'),
    (_req, res) => res.status(201).json({ ok: true }),
  );
  app.use(errorHandler);
  return app;
}

describe('scoped service tokens', () => {
  it('allows a company-scoped read token and attaches a redacted principal', async () => {
    const response = await request(testApp())
      .get(`/companies/${COMPANY_ID}/prompts`)
      .set('x-eidolon-service-token', READ_TOKEN)
      .expect(200);

    expect(response.body.principal).toEqual({
      name: 'reader',
      companyId: COMPANY_ID,
      scopes: ['prompts:read'],
    });
    expect(JSON.stringify(response.body)).not.toContain(READ_TOKEN);
  });

  it('allows write scope to satisfy read and write checks', async () => {
    await request(testApp())
      .post(`/companies/${COMPANY_ID}/prompts`)
      .set('authorization', `Bearer ${WRITE_TOKEN}`)
      .expect(201);
  });

  it('rejects a read token on prompt mutations', async () => {
    const response = await request(testApp())
      .post(`/companies/${COMPANY_ID}/prompts`)
      .set('authorization', `Bearer ${READ_TOKEN}`)
      .expect(403);
    expect(response.body.code).toBe('SERVICE_TOKEN_SCOPE_REQUIRED');
  });

  it('rejects a valid token used for another company', async () => {
    const response = await request(testApp())
      .get('/companies/company-2/prompts')
      .set('authorization', `Bearer ${READ_TOKEN}`)
      .expect(403);
    expect(response.body.code).toBe('SERVICE_TOKEN_COMPANY_MISMATCH');
  });

  it('falls back to normal session auth for unknown bearer tokens', async () => {
    await request(testApp())
      .get(`/companies/${COMPANY_ID}/prompts`)
      .set('authorization', 'Bearer not-a-service-token')
      .expect(401);
  });

  it('fails closed when token configuration is malformed', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(parseServiceTokens('{')).toEqual([]);
    error.mockRestore();
  });

  it('accepts the server-only service cookie when deployment proxies strip custom headers', async () => {
    await request(testApp())
      .get(`/companies/${COMPANY_ID}/prompts`)
      .set('cookie', `eidolon_service_token=${READ_TOKEN}`)
      .expect(200);
  });

  it('accepts a short-lived signed request when deployment proxies strip credentials', async () => {
    const path = `/companies/${COMPANY_ID}/prompts`;
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signServiceRequest(tokens[0]!.tokenHash, 'GET', path, timestamp);
    await request(testApp())
      .get(`${path}?service=reader&ts=${timestamp}&sig=${signature}`)
      .expect(200);
  });

  it('rejects expired and path-mismatched signatures', async () => {
    const path = `/companies/${COMPANY_ID}/prompts`;
    const expired = Math.floor(Date.now() / 1000) - 61;
    const oldSignature = signServiceRequest(tokens[0]!.tokenHash, 'GET', path, expired);
    await request(testApp()).get(`${path}?service=reader&ts=${expired}&sig=${oldSignature}`).expect(401);

    const timestamp = Math.floor(Date.now() / 1000);
    const wrongPath = signServiceRequest(tokens[0]!.tokenHash, 'GET', '/different', timestamp);
    await request(testApp()).get(`${path}?service=reader&ts=${timestamp}&sig=${wrongPath}`).expect(401);
  });
});
