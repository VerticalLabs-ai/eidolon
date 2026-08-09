import { Router } from 'express';
import { GrantPermissionBodySchema, ListPermissionsQuerySchema } from '@eidolon/shared';
import { validate } from '../middleware/validate.js';
import { routeParams } from '../utils/route-params.js';
import {
  grantPermission,
  revokePermission,
  listPermissions,
  requireAccess,
  resolveAccess,
  type AccessLevel,
  type ResourceKind,
  type GranteeKind,
} from '../services/permission-service.js';
import type { DbInstance } from '../types.js';

export function permissionsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });

  // Helper: get the acting user's id + org role from the request.
  function actor(req: any): { userId: string; orgRole: string } {
    return {
      userId: req.organizationMembership?.userId ?? req.user?.id ?? 'dev-user-000',
      orgRole: req.organizationMembership?.role ?? 'owner',
    };
  }

  // POST /permissions — grant a permission (requires manage on the resource)
  router.post('/permissions', validate(GrantPermissionBodySchema), async (req, res) => {
    const { companyId } = routeParams(req);
    const body = (req as any).validated.body;
    const { userId, orgRole } = actor(req);
    // Require manage access on the resource to grant permissions
    // (VAL-TEAM-010: manage access permits permission management).
    await requireAccess(
      db, companyId, userId, orgRole,
      body.resourceType as ResourceKind, body.resourceId, 'manage',
    );
    const perm = await grantPermission(
      db, companyId,
      body.resourceType as ResourceKind, body.resourceId,
      body.granteeType as GranteeKind, body.granteeId,
      body.accessLevel as AccessLevel,
      userId,
    );
    // VAL-SEC-007: direct audit insert with the acting user (the event-based
    // logger skips permission.granted to avoid a duplicate).
    await db.drizzle.insert(db.schema.activityLog).values({
      companyId,
      actorType: 'user',
      actorId: userId,
      action: 'permission.granted',
      entityType: 'permission',
      entityId: body.resourceId,
      description: `Granted ${body.accessLevel} on ${body.resourceType} ${body.resourceId} to ${body.granteeType} ${body.granteeId}`,
      metadata: { resourceType: body.resourceType, resourceId: body.resourceId, granteeType: body.granteeType, granteeId: body.granteeId, accessLevel: body.accessLevel },
      createdAt: new Date(),
    });
    res.status(201).json({ data: perm });
  });

  // DELETE /permissions — revoke a permission (requires manage on the resource)
  router.delete('/permissions', validate(GrantPermissionBodySchema), async (req, res) => {
    const { companyId } = routeParams(req);
    const body = (req as any).validated.body;
    const { userId, orgRole } = actor(req);
    await requireAccess(
      db, companyId, userId, orgRole,
      body.resourceType as ResourceKind, body.resourceId, 'manage',
    );
    await revokePermission(
      db, companyId,
      body.resourceType as ResourceKind, body.resourceId,
      body.granteeType as GranteeKind, body.granteeId,
      userId,
    );
    // VAL-SEC-007: direct audit insert with the acting user.
    await db.drizzle.insert(db.schema.activityLog).values({
      companyId,
      actorType: 'user',
      actorId: userId,
      action: 'permission.revoked',
      entityType: 'permission',
      entityId: body.resourceId,
      description: `Revoked permission on ${body.resourceType} ${body.resourceId} from ${body.granteeType} ${body.granteeId}`,
      metadata: { resourceType: body.resourceType, resourceId: body.resourceId, granteeType: body.granteeType, granteeId: body.granteeId },
      createdAt: new Date(),
    });
    res.status(204).end();
  });

  // GET /permissions?resourceType=&resourceId= — list permissions on a resource
  router.get('/permissions', validate(ListPermissionsQuerySchema, 'query'), async (req, res) => {
    const { companyId } = routeParams(req);
    const query = (req as any).validated.query;
    const { userId, orgRole } = actor(req);
    // Require view access to see the permission list
    await requireAccess(
      db, companyId, userId, orgRole,
      query.resourceType as ResourceKind, query.resourceId, 'view',
    );
    const perms = await listPermissions(
      db, companyId,
      query.resourceType as ResourceKind, query.resourceId,
    );
    res.json({ data: perms });
  });

  // GET /permissions/resolve?resourceType=&resourceId= — resolve the acting
  // user's effective access level on a resource. Used by the UI to determine
  // hidden vs read-only vs editable state.
  router.get('/permissions/resolve', validate(ListPermissionsQuerySchema, 'query'), async (req, res) => {
    const { companyId } = routeParams(req);
    const query = (req as any).validated.query;
    const { userId, orgRole } = actor(req);
    const level = await resolveAccess(
      db, companyId, userId, orgRole,
      query.resourceType as ResourceKind, query.resourceId,
    );
    res.json({ data: { accessLevel: level } });
  });

  return router;
}
