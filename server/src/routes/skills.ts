import { and, eq } from 'drizzle-orm';
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

const InstallSkillBody = z.object({
  name: z.string().min(1).max(255),
  version: z.string().min(1).max(100).default('1.0.0'),
  source: z.string().min(1).max(2000).default('manual'),
  provenance: z.enum(['bundled', 'catalog', 'runtime', 'adapter', 'github', 'manual']).default('manual'),
  trustLevel: z.enum(['markdown_only', 'assets', 'scripts_executables']).default('markdown_only'),
  entrypoint: z.string().max(1000).optional(),
  content: z.string().min(1).max(200_000),
  metadata: z.record(z.unknown()).default({}),
  tags: z.array(z.string().min(1).max(100)).default([]),
  agentIds: z.array(z.string().uuid()).default([]),
});

export function skillsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { companySkills, agentSkills, agents } = db.schema;

  router.get('/', async (req, res) => {
    const { companyId } = routeParams(req);
    const rows = await db.drizzle
      .select()
      .from(companySkills)
      .where(eq(companySkills.companyId, companyId))
      .orderBy(companySkills.name);
    res.json({ data: rows });
  });

  router.post('/install', validate(InstallSkillBody), async (req, res) => {
    const { companyId } = routeParams(req);
    const body = req.body as z.infer<typeof InstallSkillBody>;
    const now = new Date();

    const result = await db.drizzle.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(companySkills)
        .where(
          and(
            eq(companySkills.companyId, companyId),
            eq(companySkills.name, body.name),
            eq(companySkills.version, body.version),
          ),
        )
        .limit(1);

      const [skill] = existing
        ? await tx
            .update(companySkills)
            .set({
              source: body.source,
              provenance: body.provenance,
              trustLevel: body.trustLevel,
              entrypoint: body.entrypoint ?? null,
              content: body.content,
              metadata: body.metadata,
              tags: body.tags,
              updatedAt: now,
            })
            .where(eq(companySkills.id, existing.id))
            .returning()
        : await tx
            .insert(companySkills)
            .values({
              id: randomUUID(),
              companyId,
              name: body.name,
              version: body.version,
              source: body.source,
              provenance: body.provenance,
              trustLevel: body.trustLevel,
              entrypoint: body.entrypoint ?? null,
              content: body.content,
              metadata: body.metadata,
              tags: body.tags,
              installedByUserId: req.user?.id ?? null,
              createdAt: now,
              updatedAt: now,
            })
            .returning();

      const assignments = [];
      for (const agentId of body.agentIds) {
        const [agent] = await tx
          .select({ id: agents.id, skillsEnabled: agents.skillsEnabled })
          .from(agents)
          .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
          .limit(1);

        if (!agent) {
          throw new AppError(404, 'AGENT_NOT_FOUND', `Agent ${agentId} not found`);
        }

        const [assignment] = await tx
          .insert(agentSkills)
          .values({
            id: randomUUID(),
            companyId,
            agentId,
            skillId: skill.id,
            syncStatus: 'pending',
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [agentSkills.agentId, agentSkills.skillId],
            set: { syncStatus: 'pending', updatedAt: now },
          })
          .returning();
        assignments.push(assignment);

        const enabled = new Set(agent.skillsEnabled ?? []);
        enabled.add(skill.name);
        await tx
          .update(agents)
          .set({ skillsEnabled: Array.from(enabled), updatedAt: now })
          .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
      }

      return { skill, assignments };
    });

    eventBus.emitEvent({
      type: 'runtime.skill_sync' as any,
      companyId,
      payload: {
        skillId: result.skill.id,
        skillName: result.skill.name,
        assignedAgentIds: result.assignments.map((a) => a.agentId),
      },
      timestamp: now.toISOString(),
    });

    res.status(201).json({ data: result });
  });

  router.get('/:id/assignments', async (req, res) => {
    const { companyId, id } = routeParams(req);
    const rows = await db.drizzle
      .select()
      .from(agentSkills)
      .where(and(eq(agentSkills.companyId, companyId), eq(agentSkills.skillId, id)))
      .orderBy(agentSkills.createdAt);
    res.json({ data: rows });
  });

  return router;
}
