import { Router, type Request, type Response, type NextFunction } from 'express';
import { eq, and, desc, ilike, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import { routeParams } from '../utils/route-params.js';
import { generateRawKey, hashKey, deriveKeyPrefix } from '../services/api-key-service.js';
import type { Permission } from '../middleware/permissions.js';
import type { DbInstance } from '../types.js';

// ---------------------------------------------------------------------------
// Agent API Key management (M2 — VAL-KEY-*)
// ---------------------------------------------------------------------------
//
// POST   /api/companies/:companyId/agent-api-keys
//        Permission: apikeys.manage (owner + admin)
//        Generates an eid_live_<random> key, stores SHA-256 hash, returns
//        the raw key once + metadata (id, name, role, keyPrefix).
//        Role defaults to member; configurable to viewer/member/admin.
//        Optional agentId binding.
//
// GET    /api/companies/:companyId/agent-api-keys
//        Permission: apikeys.manage (owner + admin)
//        Lists keys with metadata only (no raw keys, no keyHash).
//        Includes revoked keys with revokedAt set.
//
// DELETE /api/companies/:companyId/agent-api-keys/:keyId
//        Permission: apikeys.manage (owner + admin)
//        Revokes a key (sets revokedAt). Idempotent for already-revoked keys.
// ---------------------------------------------------------------------------

const CreateKeyBody = z.object({
  name: z.string().min(1, 'Name is required'),
  role: z.enum(['viewer', 'member', 'admin']).default('member'),
  agentId: z.string().optional(),
});

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

type ApiKeyCursor = {
  createdAt: string;
  id: string;
};

function parsePageSize(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_PAGE_SIZE;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new AppError(400, 'INVALID_LIMIT', 'limit must be a positive integer');
  }

  const parsed = Number(value);
  if (parsed < 1) {
    throw new AppError(400, 'INVALID_LIMIT', 'limit must be at least 1');
  }
  return Math.min(parsed, MAX_PAGE_SIZE);
}

function parseCursor(value: unknown): ApiKeyCursor | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new AppError(400, 'INVALID_CURSOR', 'cursor must be a Base64-encoded JSON value');
  }

  try {
    // Node's base64 decoder silently ignores invalid characters, so validate
    // the complete standard Base64 representation before decoding.
    if (
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value) ||
      value.length % 4 !== 0 ||
      (value.includes('=') && !/={1,2}$/.test(value))
    ) {
      throw new Error('invalid Base64');
    }

    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const parsed: unknown = JSON.parse(decoded);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).createdAt !== 'string' ||
      typeof (parsed as Record<string, unknown>).id !== 'string' ||
      !(parsed as Record<string, string>).id
    ) {
      throw new Error('missing cursor fields');
    }

    const createdAt = new Date((parsed as Record<string, string>).createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      throw new Error('invalid cursor date');
    }

    return {
      createdAt: createdAt.toISOString(),
      id: (parsed as Record<string, string>).id,
    };
  } catch {
    throw new AppError(400, 'INVALID_CURSOR', 'cursor must be valid Base64-encoded JSON');
  }
}

function encodeCursor(cursor: ApiKeyCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64');
}

type RequirePermissionFn = (
  permission: Permission,
) => (req: Request, res: Response, next: NextFunction) => Promise<void>;

export function agentApiKeysRouter(db: DbInstance, requirePermission: RequirePermissionFn): Router {
  const router = Router({ mergeParams: true });
  const { agentApiKeys } = db.schema;

  // -------------------------------------------------------------------------
  // POST / — create agent API key (permission: apikeys.manage)
  // -------------------------------------------------------------------------

  router.post(
    '/',
    requirePermission('apikeys.manage'),
    validate(CreateKeyBody),
    async (req, res) => {
      const { companyId } = routeParams(req);
      const body = (req as any).validated.body as {
        name: string;
        role: 'viewer' | 'member' | 'admin';
        agentId?: string;
      };
      const actingUserId = req.organizationMembership?.userId ?? req.user?.id ?? 'dev-user-000';

      // Validate agentId: if provided, verify the agent exists AND belongs
      // to the same company as the route's companyId. Return 400 if the
      // agent belongs to a different company or doesn't exist.
      if (body.agentId) {
        const { agents } = db.schema;
        const [agent] = await db.drizzle
          .select({ id: agents.id, companyId: agents.companyId })
          .from(agents)
          .where(eq(agents.id, body.agentId))
          .limit(1);

        if (!agent) {
          throw new AppError(400, 'AGENT_NOT_FOUND', 'The specified agent does not exist');
        }

        if (agent.companyId !== companyId) {
          throw new AppError(
            400,
            'AGENT_COMPANY_MISMATCH',
            'The specified agent does not belong to this company',
          );
        }
      }

      // Generate raw key, hash, and derive prefix
      const rawKey = generateRawKey();
      const keyHash = hashKey(rawKey);
      const keyPrefix = deriveKeyPrefix(rawKey);

      // Insert the new key
      const [key] = await db.drizzle
        .insert(agentApiKeys)
        .values({
          companyId,
          agentId: body.agentId ?? null,
          name: body.name,
          keyHash,
          keyPrefix,
          role: body.role,
          createdByUserId: actingUserId,
        })
        .returning();

      // Audit log
      await db.drizzle.insert(db.schema.activityLog).values({
        companyId,
        actorType: 'user',
        actorId: actingUserId,
        action: 'agent_api_key.created',
        entityType: 'agent_api_key',
        entityId: key.id,
        description: `Created agent API key "${body.name}" with role ${body.role}`,
        metadata: { name: body.name, role: body.role, keyPrefix },
        createdAt: new Date(),
      });

      res.status(201).json({
        data: {
          id: key.id,
          name: key.name,
          role: key.role,
          keyPrefix: key.keyPrefix,
          agentId: key.agentId,
          rawKey, // returned only once
          createdAt: key.createdAt,
        },
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET / — list agent API keys (permission: apikeys.manage)
  // -------------------------------------------------------------------------

  router.get('/', requirePermission('apikeys.manage'), async (req, res) => {
    const { companyId } = routeParams(req);
    const limit = parsePageSize(req.query.limit);
    const cursor = parseCursor(req.query.cursor);
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;

    const conditions = [eq(agentApiKeys.companyId, companyId)];
    if (search) {
      conditions.push(
        or(ilike(agentApiKeys.name, `%${search}%`), ilike(agentApiKeys.keyPrefix, `%${search}%`))!,
      );
    }
    if (cursor) {
      conditions.push(
        sql`(${agentApiKeys.createdAt}, ${agentApiKeys.id}) < (${cursor.createdAt}::timestamp, ${cursor.id})`,
      );
    }

    const keys = await db.drizzle
      .select({
        id: agentApiKeys.id,
        name: agentApiKeys.name,
        keyPrefix: agentApiKeys.keyPrefix,
        role: agentApiKeys.role,
        agentId: agentApiKeys.agentId,
        lastUsedAt: agentApiKeys.lastUsedAt,
        createdAt: agentApiKeys.createdAt,
        revokedAt: agentApiKeys.revokedAt,
      })
      .from(agentApiKeys)
      .where(and(...conditions))
      .orderBy(desc(agentApiKeys.createdAt), desc(agentApiKeys.id))
      .limit(limit + 1);

    const hasMore = keys.length > limit;
    const data = hasMore ? keys.slice(0, limit) : keys;
    const lastKey = data[data.length - 1];
    const nextCursor =
      hasMore && lastKey
        ? encodeCursor({ createdAt: lastKey.createdAt.toISOString(), id: lastKey.id })
        : null;

    res.json({ data, nextCursor, hasMore });
  });

  // -------------------------------------------------------------------------
  // DELETE /:keyId — revoke agent API key (permission: apikeys.manage)
  // -------------------------------------------------------------------------

  router.delete('/:keyId', requirePermission('apikeys.manage'), async (req, res) => {
    const { companyId, keyId } = routeParams(req);
    const actingUserId = req.organizationMembership?.userId ?? req.user?.id ?? 'dev-user-000';

    // Find the key within this company.
    const [key] = await db.drizzle
      .select()
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.id, keyId), eq(agentApiKeys.companyId, companyId)))
      .limit(1);

    if (!key) {
      throw new AppError(404, 'API_KEY_NOT_FOUND', 'API key not found in this company');
    }

    // If already revoked, return success (idempotent).
    if (key.revokedAt) {
      res.json({
        data: {
          id: key.id,
          revokedAt: key.revokedAt,
        },
      });
      return;
    }

    // Set revokedAt (soft delete).
    const revokedAt = new Date();
    await db.drizzle
      .update(agentApiKeys)
      .set({ revokedAt, updatedAt: revokedAt })
      .where(eq(agentApiKeys.id, key.id));

    // Audit log
    await db.drizzle.insert(db.schema.activityLog).values({
      companyId,
      actorType: 'user',
      actorId: actingUserId,
      action: 'agent_api_key.revoked',
      entityType: 'agent_api_key',
      entityId: key.id,
      description: `Revoked agent API key "${key.name}"`,
      metadata: { name: key.name, keyPrefix: key.keyPrefix },
      createdAt: new Date(),
    });

    res.json({
      data: {
        id: key.id,
        revokedAt,
      },
    });
  });

  return router;
}
