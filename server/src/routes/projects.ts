import { Router } from 'express';
import { eq, and, sql, desc, or, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

// Userinfo is rejected alongside non-http(s) schemes: a credential-bearing URL such as
// https://token@host/org/repo would be persisted and rendered verbatim, leaking the secret.
const HttpUrl = z.string().url().refine((value) => {
  try {
    const url = new URL(value);
    const isHttpProtocol = url.protocol === 'http:' || url.protocol === 'https:';
    if (!isHttpProtocol || url.username !== '' || url.password !== '') return false;
    // URL parsing discards an empty userinfo section, so https://@host and
    // https://:@host would survive the username/password check above.
    const afterScheme = value.trim().slice(url.protocol.length).replace(/^[/\\]*/, '');
    const authority = afterScheme.split(/[/\\?#]/, 1)[0] ?? '';
    return !authority.includes('@');
  } catch {
    return false;
  }
}, 'Repository URL must start with http:// or https:// and must not embed credentials');

const CreateProjectBody = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(5000).optional(),
  status: z.enum(['planning', 'active', 'completed', 'archived']).default('planning'),
  repoUrl: HttpUrl.nullable().default(null),
});

const UpdateProjectBody = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(5000).nullable().optional(),
  status: z.enum(['planning', 'active', 'completed', 'archived']).optional(),
  repoUrl: HttpUrl.nullable().optional(),
});

const ProjectListQuery = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const HomeRouteParams = z.object({
  id: z.string().uuid(),
});

export function projectsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const {
    projects,
    tasks,
    goals,
    agentFiles,
    agentExecutions,
    taskThreadItems,
    activityLog,
    projectThreads,
    projectPlans,
    projectPlanSteps,
    projectDecisions,
    projectOutcomes,
  } = db.schema;

  // GET /api/companies/:companyId/projects - list all projects for a company
  router.get('/', validate(ProjectListQuery, 'query'), async (req, res) => {
    const companyId = routeParams(req).companyId;
    const query = req.query as unknown as z.infer<typeof ProjectListQuery>;

    const conditions = [eq(projects.companyId, companyId)];

    if (query.status) {
      conditions.push(eq(projects.status, query.status as any));
    }

    const rows = await db.drizzle
      .select()
      .from(projects)
      .where(and(...conditions))
      .orderBy(desc(projects.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    const [{ total }] = await db.drizzle
      .select({ total: sql<number>`count(*)` })
      .from(projects)
      .where(and(...conditions));

    res.json({ data: rows, meta: { total: Number(total), limit: query.limit, offset: query.offset } });
  });

  // GET /api/companies/:companyId/projects/:id - get single project with counts
  router.get('/:id', async (req, res) => {
    const { id, companyId } = routeParams(req);

    const [row] = await db.drizzle
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.id, id),
          eq(projects.companyId, companyId),
        ),
      )
      .limit(1);

    if (!row) {
      throw new AppError(404, 'PROJECT_NOT_FOUND', `Project ${id} not found`);
    }

    // Task count for this project
    const [{ taskCount }] = await db.drizzle
      .select({ taskCount: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, companyId),
          eq(tasks.projectId, id),
        ),
      );

    const [{ goalCount }] = await db.drizzle
      .select({ goalCount: sql<number>`count(*)` })
      .from(goals)
      .where(
        and(
          eq(goals.companyId, companyId),
          eq(goals.projectId, id),
        ),
      );

    // Agent count - count distinct assignee agents from tasks in this project
    const [{ agentCount }] = await db.drizzle
      .select({
        agentCount: sql<number>`count(distinct ${tasks.assigneeAgentId})`,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, companyId),
          eq(tasks.projectId, id),
          sql`${tasks.assigneeAgentId} is not null`,
        ),
      );

    res.json({
      data: {
        ...row,
        taskCount: Number(taskCount),
        goalCount: Number(goalCount),
        agentCount: Number(agentCount),
      },
    });
  });

  // GET /api/companies/:companyId/projects/:id/home - composed home summary
  router.get('/:id/home', validate(HomeRouteParams, 'params'), async (req, res) => {
    const { id } = (req as any).validated.params as z.infer<typeof HomeRouteParams>;
    const companyId = routeParams(req).companyId;

    // Company-boundary enforcement: project must belong to route companyId
    const [project] = await db.drizzle
      .select({
        id: projects.id,
        name: projects.name,
        description: projects.description,
        status: projects.status,
        repoUrl: projects.repoUrl,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
      })
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.companyId, companyId)))
      .limit(1);

    if (!project) {
      throw new AppError(404, 'PROJECT_NOT_FOUND', `Project ${id} not found`);
    }

    // Run all independent composition queries in parallel
    const [
      taskCountRow,
      goalCountRow,
      agentCountRow,
      fileCountRow,
      breakdownRows,
      activeWorkRows,
      needsAttentionRows,
      failedWorkRows,
      recentActivityRows,
      recentFilesRows,
      goalProgressRow,
      recentThreadItemsRows,
      pendingDecisionsRows,
      activePlanProgressRows,
    ] = await Promise.all([
      // counts.taskCount
      db.drizzle
        .select({ count: sql<number>`count(*)` })
        .from(tasks)
        .where(and(eq(tasks.companyId, companyId), eq(tasks.projectId, id))),
      // counts.goalCount
      db.drizzle
        .select({ count: sql<number>`count(*)` })
        .from(goals)
        .where(and(eq(goals.companyId, companyId), eq(goals.projectId, id))),
      // counts.agentCount — distinct non-null assignees
      db.drizzle
        .select({
          count: sql<number>`count(distinct ${tasks.assigneeAgentId})`,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.companyId, companyId),
            eq(tasks.projectId, id),
            sql`${tasks.assigneeAgentId} is not null`,
          ),
        ),
      // counts.fileCount
      db.drizzle
        .select({ count: sql<number>`count(*)` })
        .from(agentFiles)
        .where(
          and(
            eq(agentFiles.companyId, companyId),
            eq(agentFiles.projectId, id),
            eq(agentFiles.isDirectory, false),
          ),
        ),
      // taskStatusBreakdown — per-status counts
      db.drizzle
        .select({
          status: tasks.status,
          count: sql<number>`count(*)`,
        })
        .from(tasks)
        .where(and(eq(tasks.companyId, companyId), eq(tasks.projectId, id)))
        .groupBy(tasks.status),
      // activeWork — in_progress + review, top 10 by updatedAt desc
      db.drizzle
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.companyId, companyId),
            eq(tasks.projectId, id),
            inArray(tasks.status, ['in_progress', 'review']),
          ),
        )
        .orderBy(desc(tasks.updatedAt), desc(tasks.id))
        .limit(10),
      // needsAttention — review + timed_out OR pending thread items, top 10
      db.drizzle
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.companyId, companyId),
            eq(tasks.projectId, id),
            or(
              inArray(tasks.status, ['review', 'timed_out']),
              sql`EXISTS (SELECT 1 FROM ${taskThreadItems} WHERE ${taskThreadItems.companyId} = ${companyId} AND ${taskThreadItems.taskId} = ${tasks.id} AND ${taskThreadItems.status} = 'pending')`,
            ),
          ),
        )
        .orderBy(desc(tasks.updatedAt), desc(tasks.id))
        .limit(10),
      // failedWork — failed executions joined to tasks via task linkage, top 10
      db.drizzle
        .select({
          id: agentExecutions.id,
          companyId: agentExecutions.companyId,
          agentId: agentExecutions.agentId,
          taskId: agentExecutions.taskId,
          status: agentExecutions.status,
          summary: agentExecutions.summary,
          error: agentExecutions.error,
          startedAt: agentExecutions.startedAt,
          completedAt: agentExecutions.completedAt,
          createdAt: agentExecutions.createdAt,
          updatedAt: agentExecutions.updatedAt,
        })
        .from(agentExecutions)
        .innerJoin(tasks, eq(tasks.id, agentExecutions.taskId))
        .where(
          and(
            eq(agentExecutions.companyId, companyId),
            eq(agentExecutions.status, 'failed'),
            eq(tasks.projectId, id),
          ),
        )
        .orderBy(desc(agentExecutions.updatedAt), desc(agentExecutions.id))
        .limit(10),
      // recentActivity — top 5 project activity events (same scoping as activity.ts)
      db.drizzle
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            or(
              and(eq(activityLog.entityType, 'project'), eq(activityLog.entityId, id)),
              and(
                sql`${activityLog.action} like 'project.%'`,
                sql`${activityLog.metadata}->'project'->>'id' = ${id}`,
              ),
              and(
                sql`${activityLog.action} like 'task.%'`,
                sql`${activityLog.metadata}->'task'->>'projectId' = ${id}`,
              ),
              and(
                sql`${activityLog.action} like 'task.%'`,
                sql`${activityLog.metadata}->>'projectId' = ${id}`,
              ),
            ),
          ),
        )
        .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
        .limit(5),
      // recentFiles — top 5 project files by createdAt desc
      db.drizzle
        .select({
          id: agentFiles.id,
          companyId: agentFiles.companyId,
          agentId: agentFiles.agentId,
          name: agentFiles.name,
          path: agentFiles.path,
          mimeType: agentFiles.mimeType,
          sizeBytes: agentFiles.sizeBytes,
          storageType: agentFiles.storageType,
          parentId: agentFiles.parentId,
          isDirectory: agentFiles.isDirectory,
          taskId: agentFiles.taskId,
          executionId: agentFiles.executionId,
          projectId: agentFiles.projectId,
          createdAt: agentFiles.createdAt,
          updatedAt: agentFiles.updatedAt,
        })
        .from(agentFiles)
        .where(
          and(
            eq(agentFiles.companyId, companyId),
            eq(agentFiles.projectId, id),
            eq(agentFiles.isDirectory, false),
          ),
        )
        .orderBy(desc(agentFiles.createdAt), desc(agentFiles.id))
        .limit(5),
      // goalProgress — count + avg progress
      db.drizzle
        .select({
          count: sql<number>`count(*)`,
          aggregateProgress: sql<number>`coalesce(avg(${goals.progress}), 0)`,
        })
        .from(goals)
        .where(and(eq(goals.companyId, companyId), eq(goals.projectId, id))),
      // recentThreadItems — top 5 items from active project threads (VER-514)
      db.drizzle
        .select({
          id: taskThreadItems.id,
          companyId: taskThreadItems.companyId,
          taskId: taskThreadItems.taskId,
          kind: taskThreadItems.kind,
          authorUserId: taskThreadItems.authorUserId,
          authorAgentId: taskThreadItems.authorAgentId,
          content: taskThreadItems.content,
          payload: taskThreadItems.payload,
          interactionType: taskThreadItems.interactionType,
          status: taskThreadItems.status,
          idempotencyKey: taskThreadItems.idempotencyKey,
          relatedApprovalId: taskThreadItems.relatedApprovalId,
          relatedExecutionId: taskThreadItems.relatedExecutionId,
          resolvedByUserId: taskThreadItems.resolvedByUserId,
          resolutionNote: taskThreadItems.resolutionNote,
          projectId: taskThreadItems.projectId,
          projectThreadId: taskThreadItems.projectThreadId,
          createdAt: taskThreadItems.createdAt,
          updatedAt: taskThreadItems.updatedAt,
          resolvedAt: taskThreadItems.resolvedAt,
        })
        .from(taskThreadItems)
        .innerJoin(projectThreads, eq(projectThreads.id, taskThreadItems.projectThreadId))
        .where(
          and(
            eq(taskThreadItems.companyId, companyId),
            eq(projectThreads.companyId, companyId),
            eq(projectThreads.projectId, id),
            eq(projectThreads.status, 'active'),
          ),
        )
        .orderBy(desc(taskThreadItems.createdAt), desc(taskThreadItems.id))
        .limit(5),
      // pendingDecisions — top 5 pending decisions (VER-514)
      db.drizzle
        .select()
        .from(projectDecisions)
        .where(
          and(
            eq(projectDecisions.companyId, companyId),
            eq(projectDecisions.projectId, id),
            eq(projectDecisions.status, 'pending'),
          ),
        )
        .orderBy(desc(projectDecisions.createdAt), desc(projectDecisions.id))
        .limit(5),
      // activePlanProgress — top 3 active plans (VER-514)
      // Step counts are fetched separately after Promise.all resolves.
      db.drizzle
        .select()
        .from(projectPlans)
        .where(
          and(
            eq(projectPlans.companyId, companyId),
            eq(projectPlans.projectId, id),
            eq(projectPlans.status, 'active'),
          ),
        )
        .orderBy(desc(projectPlans.createdAt), desc(projectPlans.id))
        .limit(3),
    ]);

    // Build the per-status breakdown map (all statuses default to 0)
    const statuses = ['backlog', 'todo', 'in_progress', 'review', 'done', 'cancelled', 'timed_out'] as const;
    const taskStatusBreakdown: Record<string, number> = {};
    for (const s of statuses) {
      taskStatusBreakdown[s] = 0;
    }
    for (const row of breakdownRows) {
      taskStatusBreakdown[row.status] = Number(row.count);
    }

    const taskCount = Number(taskCountRow[0].count);
    const goalCount = Number(goalCountRow[0].count);
    const agentCount = Number(agentCountRow[0].count);
    const fileCount = Number(fileCountRow[0].count);

    const goalProgressCount = Number(goalProgressRow[0].count);
    const goalProgressAggregate = goalProgressCount > 0
      ? Number(goalProgressRow[0].aggregateProgress)
      : 0;

    // Fetch step counts for active plans (two-step approach for PGlite compatibility)
    const activePlanIds = activePlanProgressRows.map((p) => p.id);
    let activePlanProgress: Array<typeof activePlanProgressRows[number] & { stepCount: number; completedStepCount: number }> = [];
    if (activePlanIds.length > 0) {
      const stepCounts = await db.drizzle
        .select({
          planId: projectPlanSteps.planId,
          stepCount: sql<number>`count(*)`.as('step_count'),
          completedStepCount:
            sql<number>`count(*) filter (where ${projectPlanSteps.status} = 'completed')`.as('completed_step_count'),
        })
        .from(projectPlanSteps)
        .where(inArray(projectPlanSteps.planId, activePlanIds))
        .groupBy(projectPlanSteps.planId);

      const countsByPlan = new Map<string, { stepCount: number; completedStepCount: number }>();
      for (const sc of stepCounts) {
        countsByPlan.set(sc.planId, {
          stepCount: Number(sc.stepCount),
          completedStepCount: Number(sc.completedStepCount),
        });
      }

      activePlanProgress = activePlanProgressRows.map((p) => ({
        ...p,
        stepCount: countsByPlan.get(p.id)?.stepCount ?? 0,
        completedStepCount: countsByPlan.get(p.id)?.completedStepCount ?? 0,
      }));
    }

    res.json({
      data: {
        project,
        counts: {
          taskCount,
          goalCount,
          agentCount,
          fileCount,
        },
        taskStatusBreakdown,
        activeWork: activeWorkRows,
        needsAttention: needsAttentionRows,
        failedWork: failedWorkRows,
        recentActivity: recentActivityRows,
        recentFiles: recentFilesRows,
        goalProgress: {
          count: goalProgressCount,
          aggregateProgress: goalProgressAggregate,
        },
        // VER-514 composed fields
        recentThreadItems: recentThreadItemsRows,
        pendingDecisions: pendingDecisionsRows,
        activePlanProgress,
      },
    });
  });

  // GET /api/companies/:companyId/projects/:id/work - composed work summary (VER-514)
  router.get('/:id/work', validate(HomeRouteParams, 'params'), async (req, res) => {
    const { id } = (req as any).validated.params as z.infer<typeof HomeRouteParams>;
    const companyId = routeParams(req).companyId;

    // Company-boundary enforcement: project must belong to route companyId
    const [project] = await db.drizzle
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.companyId, companyId)))
      .limit(1);

    if (!project) {
      throw new AppError(404, 'PROJECT_NOT_FOUND', `Project ${id} not found`);
    }

    // Run all independent composition queries in parallel
    const [
      planRows,
      outcomeRows,
      activeThreadCountRow,
      pendingInteractionCountRow,
    ] = await Promise.all([
      // plans — all plans for the project (step counts fetched separately below)
      db.drizzle
        .select()
        .from(projectPlans)
        .where(
          and(
            eq(projectPlans.companyId, companyId),
            eq(projectPlans.projectId, id),
          ),
        )
        .orderBy(desc(projectPlans.createdAt), desc(projectPlans.id)),
      // outcomes — recent outcomes (top 20)
      db.drizzle
        .select()
        .from(projectOutcomes)
        .where(
          and(
            eq(projectOutcomes.companyId, companyId),
            eq(projectOutcomes.projectId, id),
          ),
        )
        .orderBy(desc(projectOutcomes.createdAt), desc(projectOutcomes.id))
        .limit(20),
      // activeThreadCount — count of active project threads
      db.drizzle
        .select({ count: sql<number>`count(*)` })
        .from(projectThreads)
        .where(
          and(
            eq(projectThreads.companyId, companyId),
            eq(projectThreads.projectId, id),
            eq(projectThreads.status, 'active'),
          ),
        ),
      // pendingInteractionCount — count of pending interaction items from project threads
      db.drizzle
        .select({ count: sql<number>`count(*)` })
        .from(taskThreadItems)
        .innerJoin(projectThreads, eq(projectThreads.id, taskThreadItems.projectThreadId))
        .where(
          and(
            eq(taskThreadItems.companyId, companyId),
            eq(projectThreads.companyId, companyId),
            eq(projectThreads.projectId, id),
            eq(projectThreads.status, 'active'),
            eq(taskThreadItems.kind, 'interaction'),
            eq(taskThreadItems.status, 'pending'),
          ),
        ),
    ]);

    // Fetch step counts for plans (two-step approach for PGlite compatibility)
    const planIds = planRows.map((p) => p.id);
    const stepStatuses = ['pending', 'in_progress', 'completed', 'blocked', 'skipped'] as const;
    type StepStatusCounts = Record<(typeof stepStatuses)[number], number>;
    let plans: Array<
      typeof planRows[number] & {
        stepCount: number;
        completedStepCount: number;
        stepStatusCounts: StepStatusCounts;
      }
    > = [];
    if (planIds.length > 0) {
      const stepCounts = await db.drizzle
        .select({
          planId: projectPlanSteps.planId,
          stepCount: sql<number>`count(*)`.as('step_count'),
          completedStepCount:
            sql<number>`count(*) filter (where ${projectPlanSteps.status} = 'completed')`.as('completed_step_count'),
          pendingCount:
            sql<number>`count(*) filter (where ${projectPlanSteps.status} = 'pending')`.as('pending_count'),
          inProgressCount:
            sql<number>`count(*) filter (where ${projectPlanSteps.status} = 'in_progress')`.as('in_progress_count'),
          blockedCount:
            sql<number>`count(*) filter (where ${projectPlanSteps.status} = 'blocked')`.as('blocked_count'),
          skippedCount:
            sql<number>`count(*) filter (where ${projectPlanSteps.status} = 'skipped')`.as('skipped_count'),
        })
        .from(projectPlanSteps)
        .where(
          and(
            eq(projectPlanSteps.companyId, companyId),
            inArray(projectPlanSteps.planId, planIds),
          ),
        )
        .groupBy(projectPlanSteps.planId);

      const countsByPlan = new Map<
        string,
        { stepCount: number; completedStepCount: number; stepStatusCounts: StepStatusCounts }
      >();
      for (const sc of stepCounts) {
        countsByPlan.set(sc.planId, {
          stepCount: Number(sc.stepCount),
          completedStepCount: Number(sc.completedStepCount),
          stepStatusCounts: {
            pending: Number(sc.pendingCount),
            in_progress: Number(sc.inProgressCount),
            completed: Number(sc.completedStepCount),
            blocked: Number(sc.blockedCount),
            skipped: Number(sc.skippedCount),
          },
        });
      }

      plans = planRows.map((p) => ({
        ...p,
        stepCount: countsByPlan.get(p.id)?.stepCount ?? 0,
        completedStepCount: countsByPlan.get(p.id)?.completedStepCount ?? 0,
        stepStatusCounts: countsByPlan.get(p.id)?.stepStatusCounts ?? {
          pending: 0,
          in_progress: 0,
          completed: 0,
          blocked: 0,
          skipped: 0,
        },
      }));
    }

    res.json({
      data: {
        plans,
        outcomes: outcomeRows,
        threadSummary: {
          activeThreadCount: Number(activeThreadCountRow[0].count),
          pendingInteractionCount: Number(pendingInteractionCountRow[0].count),
        },
      },
    });
  });

  // POST /api/companies/:companyId/projects - create
  router.post('/', validate(CreateProjectBody), async (req, res) => {
    const body = req.body as z.infer<typeof CreateProjectBody>;
    const companyId = routeParams(req).companyId;
    const now = new Date();

    const [row] = await db.drizzle
      .insert(projects)
      .values({
        companyId,
        name: body.name,
        description: body.description ?? null,
        status: body.status,
        repoUrl: body.repoUrl,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    eventBus.emitEvent({
      type: 'project.created',
      companyId,
      payload: { project: row },
      timestamp: now.toISOString(),
    });

    res.status(201).json({ data: row });
  });

  // PATCH /api/companies/:companyId/projects/:id - update
  router.patch('/:id', validate(UpdateProjectBody), async (req, res) => {
    const body = req.body as z.infer<typeof UpdateProjectBody>;
    const { id, companyId } = routeParams(req);

    const [existing] = await db.drizzle
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, 'PROJECT_NOT_FOUND', `Project ${id} not found`);
    }

    const [updated] = await db.drizzle
      .update(projects)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();

    eventBus.emitEvent({
      type: 'project.updated',
      companyId,
      payload: { project: updated, changes: Object.keys(body) },
      timestamp: new Date().toISOString(),
    });

    res.json({ data: updated });
  });

  // DELETE /api/companies/:companyId/projects/:id - archive
  router.delete('/:id', async (req, res) => {
    const { id, companyId } = routeParams(req);

    const [existing] = await db.drizzle
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, 'PROJECT_NOT_FOUND', `Project ${id} not found`);
    }

    const [archived] = await db.drizzle
      .update(projects)
      .set({ status: 'archived', updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();

    eventBus.emitEvent({
      type: 'project.deleted',
      companyId,
      payload: { project: archived },
      timestamp: new Date().toISOString(),
    });

    res.json({ data: archived });
  });

  return router;
}
