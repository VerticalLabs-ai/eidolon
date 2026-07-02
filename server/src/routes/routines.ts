import { and, eq } from 'drizzle-orm';
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import eventBus from '../realtime/events.js';
import type { RoutineEvent } from '../realtime/events.js';
import { RoutineTriggerService } from '../services/routine-trigger.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

const CreateRoutineBody = z.object({
  agentId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(255),
  mode: z.enum(['scheduled', 'continuous', 'on_demand']).default('scheduled'),
  jarvisMode: z.enum(['daily_briefing', 'monitoring', 'research', 'follow_up', 'custom']).default('custom'),
  schedule: z.string().max(255).nullable().optional(),
  prompt: z.string().min(1).max(100_000),
  enabled: z.boolean().default(true),
  variables: z.record(z.unknown()).default({}),
  workspacePolicy: z.record(z.unknown()).default({}),
});

export function routinesRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { routines, agents } = db.schema;
  const routineTriggers = new RoutineTriggerService(db);

  router.get('/', async (req, res) => {
    const { companyId } = routeParams(req);
    const rows = await db.drizzle
      .select()
      .from(routines)
      .where(eq(routines.companyId, companyId))
      .orderBy(routines.createdAt);
    res.json({ data: rows });
  });

  router.post('/', validate(CreateRoutineBody), async (req, res) => {
    const { companyId } = routeParams(req);
    const body = req.body as z.infer<typeof CreateRoutineBody>;
    const now = new Date();

    if (body.agentId) {
      const [agent] = await db.drizzle
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, body.agentId), eq(agents.companyId, companyId)))
        .limit(1);
      if (!agent) {
        throw new AppError(404, 'AGENT_NOT_FOUND', `Agent ${body.agentId} not found`);
      }
    }

    const [routine] = await db.drizzle
      .insert(routines)
      .values({
        id: randomUUID(),
        companyId,
        agentId: body.agentId ?? null,
        name: body.name,
        mode: body.mode,
        jarvisMode: body.jarvisMode,
        schedule: body.schedule ?? null,
        prompt: body.prompt,
        enabled: body.enabled,
        variables: body.variables,
        workspacePolicy: body.workspacePolicy,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    res.status(201).json({ data: routine });
  });

  router.post('/:id/trigger', async (req, res) => {
    const { companyId, id } = routeParams(req);
    const triggered = await routineTriggers.trigger(companyId, id);

    if (!triggered) {
      throw new AppError(404, 'ROUTINE_NOT_FOUND', `Routine ${id} not found`);
    }

    const eventTimestamp = new Date().toISOString();
    const routineEventType: RoutineEvent['type'] = triggered.routine.jarvisMode === 'daily_briefing'
      ? 'jarvis.digest_ready'
      : 'routine.triggered';

    eventBus.emitEvent({
      type: routineEventType,
      companyId,
      payload: {
        routineId: id,
        jarvisMode: triggered.routine.jarvisMode,
        agentId: triggered.routine.agentId ?? null,
        taskId: triggered.task.id,
        executionId: triggered.execution?.id ?? null,
        sessionId: triggered.session?.id ?? null,
        status: triggered.status,
      },
      timestamp: eventTimestamp,
    });

    eventBus.emitEvent({
      type: 'task.created',
      companyId,
      payload: { task: triggered.task, source: 'routine_trigger', routineId: id },
      timestamp: eventTimestamp,
    });

    eventBus.emitEvent({
      type: 'task.thread_item_seen',
      companyId,
      payload: { taskId: triggered.task.id, item: triggered.threadItem },
      timestamp: eventTimestamp,
    });

    res.json({ data: triggered });
  });

  return router;
}
