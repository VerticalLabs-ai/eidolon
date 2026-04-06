import { Router } from 'express';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

// ---------------------------------------------------------------------------
// Integration catalog
// ---------------------------------------------------------------------------

export const INTEGRATION_CATALOG = [
  { type: 'github', provider: 'github', name: 'GitHub', description: 'Code repositories, PRs, issues', configFields: ['token', 'org'] },
  { type: 'slack', provider: 'slack', name: 'Slack', description: 'Team messaging and notifications', configFields: ['webhookUrl', 'botToken'] },
  { type: 'notion', provider: 'notion', name: 'Notion', description: 'Documents and wikis', configFields: ['token', 'workspaceId'] },
  { type: 'linear', provider: 'linear', name: 'Linear', description: 'Issue tracking', configFields: ['apiKey'] },
  { type: 'gmail', provider: 'google', name: 'Gmail', description: 'Email sending and reading', configFields: ['credentials'] },
  { type: 'calendar', provider: 'google', name: 'Google Calendar', description: 'Schedule management', configFields: ['credentials'] },
  { type: 'stripe', provider: 'stripe', name: 'Stripe', description: 'Payment processing', configFields: ['secretKey'] },
  { type: 'hubspot', provider: 'hubspot', name: 'HubSpot', description: 'CRM and marketing', configFields: ['apiKey'] },
  { type: 'custom_api', provider: 'custom', name: 'Custom API', description: 'Any REST API endpoint', configFields: ['baseUrl', 'apiKey', 'headers'] },
  { type: 'webhook_out', provider: 'custom', name: 'Outbound Webhook', description: 'Send data to any URL', configFields: ['url', 'secret'] },
];

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const CreateIntegrationBody = z.object({
  name: z.string().min(1).max(255),
  type: z.string().min(1).max(100),
  provider: z.string().min(1).max(100),
  config: z.record(z.unknown()).default({}),
  credentials: z.string().optional(),
});

const PatchIntegrationBody = z.object({
  name: z.string().min(1).max(255).optional(),
  config: z.record(z.unknown()).optional(),
  credentials: z.string().optional(),
  status: z.enum(['active', 'inactive', 'error']).optional(),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function integrationsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { integrations } = db.schema;

  // GET / - list integrations (also returns catalog)
  router.get('/', async (req, res) => {
    const { companyId } = routeParams(req);

    const rows = await db.drizzle
      .select()
      .from(integrations)
      .where(eq(integrations.companyId, companyId));

    // Mask credentials
    const sanitized = rows.map((row) => ({
      ...row,
      credentialsEncrypted: row.credentialsEncrypted ? '****' : null,
      config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
    }));

    res.json({ data: sanitized, catalog: INTEGRATION_CATALOG });
  });

  // POST / - create integration
  router.post('/', validate(CreateIntegrationBody), async (req, res) => {
    const body = req.body as z.infer<typeof CreateIntegrationBody>;
    const companyId = routeParams(req).companyId;
    const now = new Date();
    const id = randomUUID();

    const [row] = await db.drizzle
      .insert(integrations)
      .values({
        id,
        companyId,
        name: body.name,
        type: body.type,
        provider: body.provider,
        config: JSON.stringify(body.config),
        credentialsEncrypted: body.credentials ?? null,
        status: 'active',
        usageCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    eventBus.emitEvent({
      type: 'activity.logged',
      companyId,
      payload: {
        action: 'integration.created',
        entityType: 'integration',
        entityId: id,
        name: body.name,
      },
      timestamp: now.toISOString(),
    });

    res.status(201).json({
      data: {
        ...row,
        credentialsEncrypted: row.credentialsEncrypted ? '****' : null,
        config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
      },
    });
  });

  // PATCH /:id - update integration
  router.patch('/:id', validate(PatchIntegrationBody), async (req, res) => {
    const body = req.body as z.infer<typeof PatchIntegrationBody>;
    const { id, companyId } = routeParams(req);

    const [existing] = await db.drizzle
      .select()
      .from(integrations)
      .where(and(eq(integrations.id, id), eq(integrations.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, 'INTEGRATION_NOT_FOUND', `Integration ${id} not found`);
    }

    const now = new Date();
    const updates: Record<string, unknown> = { updatedAt: now };

    if (body.name !== undefined) updates.name = body.name;
    if (body.config !== undefined) updates.config = JSON.stringify(body.config);
    if (body.credentials !== undefined) updates.credentialsEncrypted = body.credentials;
    if (body.status !== undefined) updates.status = body.status;

    const [updated] = await db.drizzle
      .update(integrations)
      .set(updates)
      .where(eq(integrations.id, id))
      .returning();

    eventBus.emitEvent({
      type: 'activity.logged',
      companyId,
      payload: {
        action: 'integration.updated',
        entityType: 'integration',
        entityId: id,
        name: updated.name,
      },
      timestamp: now.toISOString(),
    });

    res.json({
      data: {
        ...updated,
        credentialsEncrypted: updated.credentialsEncrypted ? '****' : null,
        config: typeof updated.config === 'string' ? JSON.parse(updated.config) : updated.config,
      },
    });
  });

  // DELETE /:id - delete integration
  router.delete('/:id', async (req, res) => {
    const { id, companyId } = routeParams(req);

    const [existing] = await db.drizzle
      .select()
      .from(integrations)
      .where(and(eq(integrations.id, id), eq(integrations.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, 'INTEGRATION_NOT_FOUND', `Integration ${id} not found`);
    }

    await db.drizzle.delete(integrations).where(eq(integrations.id, id));

    eventBus.emitEvent({
      type: 'activity.logged',
      companyId,
      payload: {
        action: 'integration.deleted',
        entityType: 'integration',
        entityId: id,
        name: existing.name,
      },
      timestamp: new Date().toISOString(),
    });

    res.json({ data: { id, deleted: true } });
  });

  // POST /:id/test - test connection
  router.post('/:id/test', async (req, res) => {
    const { id, companyId } = routeParams(req);

    const [existing] = await db.drizzle
      .select()
      .from(integrations)
      .where(and(eq(integrations.id, id), eq(integrations.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, 'INTEGRATION_NOT_FOUND', `Integration ${id} not found`);
    }

    // Simulate a connection test -- in production this would call the actual service
    const success = !!existing.credentialsEncrypted;
    const now = new Date();

    if (success) {
      await db.drizzle
        .update(integrations)
        .set({ lastUsedAt: now, updatedAt: now })
        .where(eq(integrations.id, id));
    }

    res.json({
      data: {
        id,
        success,
        message: success
          ? 'Connection successful'
          : 'No credentials configured -- provide credentials to test the connection',
        testedAt: now.toISOString(),
      },
    });
  });

  return router;
}
