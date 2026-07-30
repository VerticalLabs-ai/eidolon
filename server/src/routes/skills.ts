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

const ResetSkillBody = z.object({
  agentIds: z.array(z.string().uuid()).min(1).optional(),
  reason: z.string().max(1000).optional(),
});

type SkillRow = typeof import('@eidolon/db').schema.companySkills.$inferSelect;
type AssignmentRow = typeof import('@eidolon/db').schema.agentSkills.$inferSelect;
type AgentSkillState = Pick<typeof import('@eidolon/db').schema.agents.$inferSelect, 'id' | 'skillsEnabled'>;

function countBy<T extends string>(values: T[]): Record<T, number> {
  return values.reduce(
    (acc, value) => {
      acc[value] = (acc[value] ?? 0) + 1;
      return acc;
    },
    {} as Record<T, number>,
  );
}

function buildSkillAudit(
  skills: SkillRow[],
  assignments: AssignmentRow[],
  agentsById: Map<string, AgentSkillState>,
) {
  const assignmentsBySkill = new Map<string, AssignmentRow[]>();
  for (const assignment of assignments) {
    const rows = assignmentsBySkill.get(assignment.skillId) ?? [];
    rows.push(assignment);
    assignmentsBySkill.set(assignment.skillId, rows);
  }

  const skillAudits = skills.map((skill) => {
    const rows = assignmentsBySkill.get(skill.id) ?? [];
    const statusCounts = countBy(rows.map((row) => row.syncStatus));
    const issues: string[] = [];

    if (rows.length === 0) issues.push('no_assignments');
    if (skill.trustLevel === 'scripts_executables') issues.push('executable_trust');
    if (skill.trustLevel === 'scripts_executables' && !skill.entrypoint) {
      issues.push('missing_entrypoint');
    }
    if ((statusCounts.failed ?? 0) > 0) issues.push('failed_sync');
    if ((statusCounts.pending ?? 0) > 0) issues.push('pending_sync');

    const mismatchedAgentIds = rows
      .filter((row) => {
        const agent = agentsById.get(row.agentId);
        return !agent || !(agent.skillsEnabled ?? []).includes(skill.name);
      })
      .map((row) => row.agentId);
    if (mismatchedAgentIds.length > 0) issues.push('agent_catalog_mismatch');

    return {
      id: skill.id,
      name: skill.name,
      version: skill.version,
      source: skill.source,
      provenance: skill.provenance,
      trustLevel: skill.trustLevel,
      tags: skill.tags,
      assignmentCount: rows.length,
      agentIds: rows.map((row) => row.agentId),
      statusCounts,
      mismatchedAgentIds,
      issues,
      updatedAt: skill.updatedAt,
    };
  });

  return {
    totals: {
      skills: skills.length,
      assignments: assignments.length,
      assignedAgents: new Set(assignments.map((row) => row.agentId)).size,
      unassignedSkills: skillAudits.filter((skill) => skill.assignmentCount === 0).length,
      executableSkills: skills.filter((skill) => skill.trustLevel === 'scripts_executables').length,
      failedAssignments: assignments.filter((row) => row.syncStatus === 'failed').length,
      pendingAssignments: assignments.filter((row) => row.syncStatus === 'pending').length,
      syncedAssignments: assignments.filter((row) => row.syncStatus === 'synced').length,
      disabledAssignments: assignments.filter((row) => row.syncStatus === 'disabled').length,
      skillsWithIssues: skillAudits.filter((skill) => skill.issues.length > 0).length,
    },
    byTrustLevel: countBy(skills.map((skill) => skill.trustLevel)),
    byProvenance: countBy(skills.map((skill) => skill.provenance)),
    skills: skillAudits,
  };
}

function buildAgentskillsExport(skill: SkillRow, assignments: AssignmentRow[]) {
  const entrypoint = safeRelativeSkillPath(skill.entrypoint);

  return {
    schema: 'agentskills.io/v1',
    exportedAt: new Date().toISOString(),
    skill: {
      name: skill.name,
      version: skill.version,
      source: skill.source,
      provenance: skill.provenance,
      trustLevel: skill.trustLevel,
      entrypoint,
      tags: skill.tags,
      metadata: skill.metadata,
      content: skill.content,
    },
    files: [
      {
        path: entrypoint,
        content: skill.content,
      },
    ],
    assignments: assignments.map((assignment) => ({
      agentId: assignment.agentId,
      syncStatus: assignment.syncStatus,
      materializedPath: assignment.materializedPath,
      lastSyncedAt: assignment.lastSyncedAt,
    })),
  };
}

function safeRelativeSkillPath(value: string | null): string {
  const normalized = (value?.trim() || 'SKILL.md').replace(/\\/g, '/');
  const segments = normalized.split('/');
  const isUnsafe =
    normalized.startsWith('/') ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.includes('\0') ||
    segments.some((segment) => !segment || segment === '.' || segment === '..');

  return isUnsafe ? 'SKILL.md' : normalized;
}

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

  router.get('/audit', async (req, res) => {
    const { companyId } = routeParams(req);
    const [skills, assignments, companyAgents] = await Promise.all([
      db.drizzle
        .select()
        .from(companySkills)
        .where(eq(companySkills.companyId, companyId))
        .orderBy(companySkills.name),
      db.drizzle
        .select()
        .from(agentSkills)
        .where(eq(agentSkills.companyId, companyId))
        .orderBy(agentSkills.createdAt),
      db.drizzle
        .select({ id: agents.id, skillsEnabled: agents.skillsEnabled })
        .from(agents)
        .where(eq(agents.companyId, companyId)),
    ]);

    res.json({
      data: buildSkillAudit(
        skills,
        assignments,
        new Map(companyAgents.map((agent) => [agent.id, agent])),
      ),
    });
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

  router.get('/:id/export', async (req, res) => {
    const { companyId, id } = routeParams(req);
    const [skill] = await db.drizzle
      .select()
      .from(companySkills)
      .where(and(eq(companySkills.id, id), eq(companySkills.companyId, companyId)))
      .limit(1);

    if (!skill) {
      throw new AppError(404, 'SKILL_NOT_FOUND', `Skill ${id} not found`);
    }

    const assignments = await db.drizzle
      .select()
      .from(agentSkills)
      .where(and(eq(agentSkills.companyId, companyId), eq(agentSkills.skillId, id)))
      .orderBy(agentSkills.createdAt);

    res.json({ data: buildAgentskillsExport(skill, assignments) });
  });

  router.post('/:id/reset', validate(ResetSkillBody), async (req, res) => {
    const { companyId, id } = routeParams(req);
    const body = req.body as z.infer<typeof ResetSkillBody>;
    const now = new Date();

    const result = await db.drizzle.transaction(async (tx) => {
      const [skill] = await tx
        .select()
        .from(companySkills)
        .where(and(eq(companySkills.id, id), eq(companySkills.companyId, companyId)))
        .limit(1);

      if (!skill) {
        throw new AppError(404, 'SKILL_NOT_FOUND', `Skill ${id} not found`);
      }

      const existingAssignments = await tx
        .select()
        .from(agentSkills)
        .where(and(eq(agentSkills.companyId, companyId), eq(agentSkills.skillId, id)));

      const targetAgentIds = body.agentIds?.length
        ? new Set(body.agentIds)
        : new Set(existingAssignments.map((assignment) => assignment.agentId));

      if (body.agentIds?.length) {
        const companyAgents = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.companyId, companyId));
        const knownAgentIds = new Set(companyAgents.map((agent) => agent.id));
        const unknownAgentId = body.agentIds.find((agentId) => !knownAgentIds.has(agentId));
        if (unknownAgentId) {
          throw new AppError(404, 'AGENT_NOT_FOUND', `Agent ${unknownAgentId} not found`);
        }

        const assignedAgentIds = new Set(existingAssignments.map((assignment) => assignment.agentId));
        const unassignedAgentId = body.agentIds.find((agentId) => !assignedAgentIds.has(agentId));
        if (unassignedAgentId) {
          throw new AppError(
            404,
            'SKILL_ASSIGNMENT_NOT_FOUND',
            `Skill ${id} is not assigned to agent ${unassignedAgentId}`,
          );
        }
      }

      const resetAssignments = [];
      for (const assignment of existingAssignments) {
        if (!targetAgentIds.has(assignment.agentId)) continue;

        const [updated] = await tx
          .update(agentSkills)
          .set({
            syncStatus: 'pending',
            materializedPath: null,
            lastSyncedAt: null,
            updatedAt: now,
          })
          .where(eq(agentSkills.id, assignment.id))
          .returning();
        resetAssignments.push(updated);

        const [agent] = await tx
          .select({ id: agents.id, skillsEnabled: agents.skillsEnabled })
          .from(agents)
          .where(and(eq(agents.id, assignment.agentId), eq(agents.companyId, companyId)))
          .limit(1);

        if (agent) {
          const enabled = new Set(agent.skillsEnabled ?? []);
          enabled.add(skill.name);
          await tx
            .update(agents)
            .set({ skillsEnabled: Array.from(enabled), updatedAt: now })
            .where(and(eq(agents.id, assignment.agentId), eq(agents.companyId, companyId)));
        }
      }

      return { skill, assignments: resetAssignments };
    });

    eventBus.emitEvent({
      type: 'runtime.skill_sync' as any,
      companyId,
      payload: {
        skillId: result.skill.id,
        skillName: result.skill.name,
        reset: true,
        reason: body.reason ?? null,
        assignedAgentIds: result.assignments.map((assignment) => assignment.agentId),
      },
      timestamp: now.toISOString(),
    });

    res.json({ data: result });
  });

  return router;
}
