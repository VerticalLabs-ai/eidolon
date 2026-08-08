import { Router } from 'express';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { validate } from '../middleware/validate.js';
import { routeParams } from '../utils/route-params.js';
import { AppError } from '../middleware/error-handler.js';
import { getArtifact } from '../services/artifact-service.js';
import {
  joinPresence,
  leavePresence,
  setTyping,
  getArtifactPresence,
  getProjectPresence,
} from '../realtime/presence-store.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';

// ---------------------------------------------------------------------------
// Presence REST surface (M3)
// ---------------------------------------------------------------------------
//
// Presence is driven by REST mutations that emit `presence.*` events on the
// company WS channel. The UI calls these on editor mount/unmount/typing and
// reacts to the WS events for live indicators. This keeps user identity
// authenticated (the WS bus itself carries no auth) while events fan out over
// the existing company-scoped WS transport.
//
// In `local_trusted` mode a request may supply `userId`/`name` in the body to
// simulate a second viewer (validated against the test_users table or the dev
// user), which is how multi-client fan-out is verified with a single browser
// + a curl/ws "other actor". In Clerk mode the body identity is ignored and
// the authenticated `req.user` is used.
// ---------------------------------------------------------------------------

const JoinBody = z.object({
  userId: z.string().max(255).optional(),
  name: z.string().max(255).optional(),
});
const TypingBody = z.object({
  typing: z.boolean(),
  userId: z.string().max(255).optional(),
  name: z.string().max(255).optional(),
});
const ProjectQuery = z.object({
  projectId: z.string().uuid(),
});

function emitPresence(
  type: 'presence.join' | 'presence.leave' | 'presence.typing',
  companyId: string,
  payload: Record<string, unknown>,
): void {
  eventBus.emitEvent({ type, companyId, payload, timestamp: new Date().toISOString() });
}

export function presenceRouter(db: DbInstance): Router {
  // Capture auth mode at router creation time (during createApp()). In tests,
  // createTestApp() sets AUTH_MODE only during createApp() and restores it
  // afterward, so checking process.env.AUTH_MODE at request time would always
  // be undefined. This mirrors the local-trusted-auth router pattern.
  const isLocalTrusted = process.env.AUTH_MODE === 'local_trusted';
  const router = Router({ mergeParams: true });

  /**
   * Resolve the acting user for a presence request. In local_trusted mode an
   * optional body `userId`/`name` simulates a second viewer; the userId must
   * be the dev user or a test_users row for the company. In Clerk mode the
   * authenticated `req.user` is always used.
   */
  async function resolveActor(
    req: any,
    companyId: string,
    bodyUserId?: string,
    bodyName?: string,
  ): Promise<{ userId: string; name: string }> {
    if (!isLocalTrusted || !bodyUserId) {
      const id = req.user?.id ?? 'unknown';
      const name = req.user?.name ?? req.user?.email ?? 'User';
      return { userId: id, name };
    }
    if (bodyUserId === 'dev-user-000') {
      return { userId: 'dev-user-000', name: bodyName || 'Dev User' };
    }
    const [testUser] = await db.drizzle
      .select()
      .from(db.schema.testUsers)
      .where(
        and(
          eq(db.schema.testUsers.id, bodyUserId),
          eq(db.schema.testUsers.companyId, companyId),
        ),
      )
      .limit(1);
    if (!testUser) {
      throw new AppError(
        403,
        'PRESENCE_USER_NOT_FOUND',
        'The specified user is not a member of this company',
      );
    }
    return { userId: testUser.id, name: bodyName || testUser.name };
  }

  // -------------------------------------------------------------------------
  // Artifact-scoped presence
  // -------------------------------------------------------------------------

  // POST /api/companies/:companyId/artifacts/:id/presence/join
  router.post('/artifacts/:id/presence/join', validate(JoinBody), async (req, res) => {
    const { companyId, id } = routeParams(req);
    const artifact = await getArtifact(db, companyId, id); // validates company scope
    const body = (req as any).validated.body as z.infer<typeof JoinBody>;
    const actor = await resolveActor(req, companyId, body.userId, body.name);

    const isNew = joinPresence({
      userId: actor.userId,
      companyId,
      artifactId: id,
      projectId: artifact.projectId ?? null,
      name: actor.name,
    });

    if (isNew) {
      emitPresence('presence.join', companyId, {
        artifactId: id,
        userId: actor.userId,
        name: actor.name,
        projectId: artifact.projectId ?? null,
      });
    }
    res.json({
      data: {
        artifactId: id,
        userId: actor.userId,
        presence: getArtifactPresence(id),
      },
    });
  });

  // POST /api/companies/:companyId/artifacts/:id/presence/leave
  router.post('/artifacts/:id/presence/leave', validate(JoinBody), async (req, res) => {
    const { companyId, id } = routeParams(req);
    await getArtifact(db, companyId, id); // validate scope
    const body = (req as any).validated.body as z.infer<typeof JoinBody>;
    const actor = await resolveActor(req, companyId, body.userId, body.name);

    const removed = leavePresence(id, actor.userId);
    if (removed) {
      emitPresence('presence.leave', companyId, {
        artifactId: id,
        userId: removed.userId,
        name: removed.name,
      });
    }
    res.json({ data: { artifactId: id, userId: actor.userId, presence: getArtifactPresence(id) } });
  });

  // POST /api/companies/:companyId/artifacts/:id/presence/typing
  router.post('/artifacts/:id/presence/typing', validate(TypingBody), async (req, res) => {
    const { companyId, id } = routeParams(req);
    await getArtifact(db, companyId, id); // validate scope
    const body = (req as any).validated.body as z.infer<typeof TypingBody>;
    const actor = await resolveActor(req, companyId, body.userId, body.name);

    const transition = setTyping(id, actor.userId, body.typing);
    if (transition === 'started' || transition === 'cleared') {
      emitPresence('presence.typing', companyId, {
        artifactId: id,
        userId: actor.userId,
        name: actor.name,
        typing: transition === 'started',
      });
    }
    res.json({
      data: { artifactId: id, userId: actor.userId, typing: body.typing, presence: getArtifactPresence(id) },
    });
  });

  // GET /api/companies/:companyId/artifacts/:id/presence
  router.get('/artifacts/:id/presence', async (req, res) => {
    const { companyId, id } = routeParams(req);
    await getArtifact(db, companyId, id); // validate scope
    res.json({ data: { artifactId: id, presence: getArtifactPresence(id) } });
  });

  // -------------------------------------------------------------------------
  // Project-aggregated presence (VAL-CROSS-014)
  // -------------------------------------------------------------------------

  // GET /api/companies/:companyId/presence?projectId=...
  router.get('/presence', validate(ProjectQuery, 'query'), async (req, res) => {
    const { companyId } = routeParams(req);
    const query = (req as any).validated.query as z.infer<typeof ProjectQuery>;
    res.json({ data: { projectId: query.projectId, presence: getProjectPresence(companyId, query.projectId) } });
  });

  return router;
}
