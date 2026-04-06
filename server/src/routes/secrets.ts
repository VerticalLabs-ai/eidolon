import { Router } from 'express';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import { encrypt, decrypt } from '../services/crypto.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

const CreateSecretBody = z.object({
  name: z.string().min(1).max(255),
  value: z.string().min(1),
  provider: z.string().min(1).max(100).default('local'),
  description: z.string().max(1000).optional(),
  createdBy: z.string().max(255).optional(),
});

const UpdateSecretBody = z.object({
  value: z.string().min(1).optional(),
  provider: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).nullable().optional(),
});

export function secretsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { secrets } = db.schema;

  // GET /api/companies/:companyId/secrets - list (never expose value)
  router.get('/', async (req, res) => {
    const rows = await db.drizzle
      .select({
        id: secrets.id,
        companyId: secrets.companyId,
        name: secrets.name,
        provider: secrets.provider,
        description: secrets.description,
        createdBy: secrets.createdBy,
        createdAt: secrets.createdAt,
        updatedAt: secrets.updatedAt,
      })
      .from(secrets)
      .where(eq(secrets.companyId, routeParams(req).companyId));
    res.json({ data: rows });
  });

  // POST /api/companies/:companyId/secrets - create
  router.post('/', validate(CreateSecretBody), async (req, res) => {
    const body = req.body as z.infer<typeof CreateSecretBody>;
    const companyId = routeParams(req).companyId;
    const now = new Date();
    const id = randomUUID();

    const valueEncrypted = encrypt(body.value);

    const [row] = await db.drizzle
      .insert(secrets)
      .values({
        id,
        companyId,
        name: body.name,
        valueEncrypted,
        provider: body.provider,
        description: body.description ?? null,
        createdBy: body.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    eventBus.emitEvent({
      type: 'activity.logged',
      companyId,
      payload: {
        action: 'secret.created',
        entityType: 'secret',
        entityId: id,
        name: body.name,
      },
      timestamp: now.toISOString(),
    });

    // Return without the encrypted value
    res.status(201).json({
      data: {
        id: row.id,
        companyId: row.companyId,
        name: row.name,
        provider: row.provider,
        description: row.description,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    });
  });

  // PATCH /api/companies/:companyId/secrets/:id - update
  router.patch('/:id', validate(UpdateSecretBody), async (req, res) => {
    const body = req.body as z.infer<typeof UpdateSecretBody>;
    const { id, companyId } = routeParams(req);

    const [existing] = await db.drizzle
      .select()
      .from(secrets)
      .where(and(eq(secrets.id, id), eq(secrets.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, 'SECRET_NOT_FOUND', `Secret ${id} not found`);
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.value !== undefined) {
      updates.valueEncrypted = encrypt(body.value);
    }
    if (body.provider !== undefined) {
      updates.provider = body.provider;
    }
    if (body.description !== undefined) {
      updates.description = body.description;
    }

    const [updated] = await db.drizzle
      .update(secrets)
      .set(updates)
      .where(eq(secrets.id, id))
      .returning();

    eventBus.emitEvent({
      type: 'activity.logged',
      companyId,
      payload: {
        action: 'secret.updated',
        entityType: 'secret',
        entityId: id,
        name: updated.name,
      },
      timestamp: new Date().toISOString(),
    });

    res.json({
      data: {
        id: updated.id,
        companyId: updated.companyId,
        name: updated.name,
        provider: updated.provider,
        description: updated.description,
        createdBy: updated.createdBy,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      },
    });
  });

  // DELETE /api/companies/:companyId/secrets/:id - delete
  router.delete('/:id', async (req, res) => {
    const { id, companyId } = routeParams(req);

    const [existing] = await db.drizzle
      .select()
      .from(secrets)
      .where(and(eq(secrets.id, id), eq(secrets.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, 'SECRET_NOT_FOUND', `Secret ${id} not found`);
    }

    await db.drizzle.delete(secrets).where(eq(secrets.id, id));

    eventBus.emitEvent({
      type: 'activity.logged',
      companyId,
      payload: {
        action: 'secret.deleted',
        entityType: 'secret',
        entityId: id,
        name: existing.name,
      },
      timestamp: new Date().toISOString(),
    });

    res.json({ data: { id, deleted: true } });
  });

  return router;
}
