import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';
import logger from '../utils/logger.js';

const RUNTIME_TOTALS_WINDOW_DAYS = 30;
const RUNTIME_TOTALS_CACHE_TTL_MS = 15_000;
const RUNTIME_TOTALS_CACHE_MAX_ENTRIES = 500;
const RUNTIME_STATE_REQUEST_TIMEOUT_MS = 10_000;

type RuntimeTotals = {
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  executions: number;
};

type RuntimeTotalsCacheEntry = {
  expiresAt: number;
  totals: RuntimeTotals;
};

const runtimeTotalsCache = new Map<string, RuntimeTotalsCacheEntry>();
let runtimeTotalsCachePruneInProgress = false;

function deleteRuntimeTotalsCacheEntry(key: string): void {
  runtimeTotalsCache.delete(key);
}

function upsertRuntimeTotalsCacheEntry(key: string, entry: RuntimeTotalsCacheEntry): void {
  deleteRuntimeTotalsCacheEntry(key);
  runtimeTotalsCache.set(key, entry);
}

function pruneRuntimeTotalsCache(now = Date.now()): void {
  if (runtimeTotalsCachePruneInProgress) {
    logger.debug(
      { runtimeTotalsCachePruneInProgress },
      'pruneRuntimeTotalsCache skipped because a prune is already in progress',
    );
    return;
  }

  runtimeTotalsCachePruneInProgress = true;
  try {
    const expiredKeys: string[] = [];
    for (const [key, entry] of runtimeTotalsCache) {
      if (entry.expiresAt <= now) expiredKeys.push(key);
    }

    for (const key of expiredKeys) {
      deleteRuntimeTotalsCacheEntry(key);
    }

    while (runtimeTotalsCache.size > RUNTIME_TOTALS_CACHE_MAX_ENTRIES) {
      const oldestKey = runtimeTotalsCache.keys().next().value;
      if (oldestKey === undefined) break;
      deleteRuntimeTotalsCacheEntry(oldestKey);
    }
  } finally {
    runtimeTotalsCachePruneInProgress = false;
  }
}

function readRuntimeTotalsCache(key: string, now: number): RuntimeTotals | null {
  const entry = runtimeTotalsCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    deleteRuntimeTotalsCacheEntry(key);
    return null;
  }

  // Refresh Map iteration order for LRU eviction without changing the cached totals object.
  upsertRuntimeTotalsCacheEntry(key, entry);
  return entry.totals;
}

function writeRuntimeTotalsCache(key: string, totals: RuntimeTotals): void {
  upsertRuntimeTotalsCacheEntry(key, {
    expiresAt: Date.now() + RUNTIME_TOTALS_CACHE_TTL_MS,
    totals,
  });
}

const runtimeTotalsCacheCleanup = setInterval(
  () => pruneRuntimeTotalsCache(),
  RUNTIME_TOTALS_CACHE_TTL_MS,
);
runtimeTotalsCacheCleanup.unref?.();

const RuntimeStateQuery = z.object({
  runningLimit: z.coerce.number().int().min(1).max(200).default(50),
  runningOffset: z.coerce.number().int().min(0).default(0),
  retryingLimit: z.coerce.number().int().min(1).max(200).default(50),
  retryingOffset: z.coerce.number().int().min(0).default(0),
  recoveryLimit: z.coerce.number().int().min(1).max(200).default(50),
  recoveryOffset: z.coerce.number().int().min(0).default(0),
  recentErrorsLimit: z.coerce.number().int().min(1).max(200).default(10),
  recentErrorsOffset: z.coerce.number().int().min(0).default(0),
  environmentLeaseLimit: z.coerce.number().int().min(1).max(200).default(50),
  environmentLeaseOffset: z.coerce.number().int().min(0).default(0),
});

type RuntimeStateQueryParams = z.infer<typeof RuntimeStateQuery>;
type ValidatedQueryRequest<TQuery> = Request & {
  validated: {
    query: TQuery;
  };
};

function validatedQuery<TQuery>(req: Request): TQuery {
  return (req as ValidatedQueryRequest<TQuery>).validated.query;
}

export function runtimeRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { agents, agentExecutions, executionEnvironments, tasks } = db.schema;

  router.get('/state', validate(RuntimeStateQuery, 'query'), async (req, res, next) => {
    const timeoutController = new AbortController();
    const assertRequestActive = () => {
      if (timeoutController.signal.aborted) {
        throw new Error('runtime_state_timeout');
      }
    };

    // Drizzle/PGlite queries in this route do not accept AbortSignal, so timeout handling is
    // cooperative: stop follow-up work and suppress late responses once the timeout fires.
    res.setTimeout(RUNTIME_STATE_REQUEST_TIMEOUT_MS, () => {
      timeoutController.abort();
      if (!res.headersSent) {
        res.status(503).json({
          error: {
            code: 'runtime_state_timeout',
            message: 'Runtime state request timed out',
          },
        });
      }
    });

    try {
      const companyId = routeParams(req).companyId;
      const query = validatedQuery<RuntimeStateQueryParams>(req);
      const generatedAt = new Date();
      const totalsWindowStart = new Date(
        generatedAt.getTime() - RUNTIME_TOTALS_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      );
      const totalsCacheKey = `${companyId}:${RUNTIME_TOTALS_WINDOW_DAYS}`;

      const runningQuery = db.drizzle
        .select({
          executionId: agentExecutions.id,
          agentId: agentExecutions.agentId,
          agentName: agents.name,
          taskId: agentExecutions.taskId,
          taskTitle: tasks.title,
          status: agentExecutions.status,
          livenessStatus: agentExecutions.livenessStatus,
          executionMode: agentExecutions.executionMode,
          startedAt: agentExecutions.startedAt,
          lastEventAt: agentExecutions.lastEventAt,
          lastUsefulAction: agentExecutions.lastUsefulAction,
          nextActionHint: agentExecutions.nextActionHint,
          inputTokens: agentExecutions.inputTokens,
          outputTokens: agentExecutions.outputTokens,
          costCents: agentExecutions.costCents,
          environmentId: agentExecutions.environmentId,
          runtimeTotal: sql<number>`count(*) over()`,
        })
        .from(agentExecutions)
        .leftJoin(agents, eq(agentExecutions.agentId, agents.id))
        .leftJoin(tasks, eq(agentExecutions.taskId, tasks.id))
        .where(and(eq(agentExecutions.companyId, companyId), eq(agentExecutions.status, 'running')))
        .orderBy(desc(agentExecutions.startedAt))
        .limit(query.runningLimit)
        .offset(query.runningOffset);

      const retryingQuery = db.drizzle
        .select({
          executionId: agentExecutions.id,
          agentId: agentExecutions.agentId,
          agentName: agents.name,
          taskId: agentExecutions.taskId,
          taskTitle: tasks.title,
          status: agentExecutions.status,
          retryAttempt: agentExecutions.retryAttempt,
          retryStatus: agentExecutions.retryStatus,
          retryDueAt: agentExecutions.retryDueAt,
          failureCategory: agentExecutions.failureCategory,
          nextActionHint: agentExecutions.nextActionHint,
          runtimeTotal: sql<number>`count(*) over()`,
        })
        .from(agentExecutions)
        .leftJoin(agents, eq(agentExecutions.agentId, agents.id))
        .leftJoin(tasks, eq(agentExecutions.taskId, tasks.id))
        .where(
          and(
            eq(agentExecutions.companyId, companyId),
            inArray(agentExecutions.retryStatus, ['scheduled', 'retrying']),
          ),
        )
        .orderBy(agentExecutions.retryDueAt)
        .limit(query.retryingLimit)
        .offset(query.retryingOffset);

      const runningCountQuery = db.drizzle
        .select({ total: sql<number>`count(*)` })
        .from(agentExecutions)
        .where(and(eq(agentExecutions.companyId, companyId), eq(agentExecutions.status, 'running')));

      const retryingCountQuery = db.drizzle
        .select({ total: sql<number>`count(*)` })
        .from(agentExecutions)
        .where(
          and(
            eq(agentExecutions.companyId, companyId),
            inArray(agentExecutions.retryStatus, ['scheduled', 'retrying']),
          ),
        );

      const runningStatePromise = runningQuery.then(async (running) => {
        assertRequestActive();
        if (running.length > 0) {
          return { running, runningTotal: Number(running[0].runtimeTotal) };
        }

        const [runningCountFallback] = await runningCountQuery;
        return { running, runningTotal: Number(runningCountFallback?.total ?? 0) };
      });

      const retryingStatePromise = retryingQuery.then(async (retrying) => {
        assertRequestActive();
        if (retrying.length > 0) {
          return { retrying, retryingTotal: Number(retrying[0].runtimeTotal) };
        }

        const [retryingCountFallback] = await retryingCountQuery;
        return { retrying, retryingTotal: Number(retryingCountFallback?.total ?? 0) };
      });

      const recoveryExecutionsPromise = db.drizzle
        .select({
          executionId: agentExecutions.id,
          recoveryTaskId: agentExecutions.recoveryTaskId,
        })
        .from(agentExecutions)
        .where(
          and(
            eq(agentExecutions.companyId, companyId),
            eq(agentExecutions.livenessStatus, 'recovering'),
            isNotNull(agentExecutions.recoveryTaskId),
          ),
        )
        .orderBy(desc(agentExecutions.lastEventAt))
        .limit(query.recoveryLimit)
        .offset(query.recoveryOffset);

      const recoveryTasksPromise = recoveryExecutionsPromise.then((recoveryExecutions) => {
        const recoveryTaskIds = recoveryExecutions
          .map((row) => row.recoveryTaskId)
          .filter((id): id is string => Boolean(id));

        return recoveryTaskIds.length > 0
          ? db.drizzle
              .select({
                id: tasks.id,
                title: tasks.title,
                status: tasks.status,
                assigneeAgentId: tasks.assigneeAgentId,
                parentId: tasks.parentId,
                updatedAt: tasks.updatedAt,
              })
              .from(tasks)
              .where(and(eq(tasks.companyId, companyId), inArray(tasks.id, recoveryTaskIds)))
          : [];
      });

      const recoveryCountPromise = db.drizzle
        .select({ total: sql<number>`count(*)` })
        .from(agentExecutions)
        .where(
          and(
            eq(agentExecutions.companyId, companyId),
            eq(agentExecutions.livenessStatus, 'recovering'),
            isNotNull(agentExecutions.recoveryTaskId),
          ),
        );

      const cachedTotals = readRuntimeTotalsCache(totalsCacheKey, generatedAt.getTime());
      const totalsPromise = cachedTotals
        ? Promise.resolve(cachedTotals)
        : db.drizzle
            .select({
              inputTokens: sql<number>`coalesce(sum(${agentExecutions.inputTokens}), 0)`,
              outputTokens: sql<number>`coalesce(sum(${agentExecutions.outputTokens}), 0)`,
              costCents: sql<number>`coalesce(sum(${agentExecutions.costCents}), 0)`,
              executions: sql<number>`count(*)`,
            })
            .from(agentExecutions)
            .where(
              and(
                eq(agentExecutions.companyId, companyId),
                gte(agentExecutions.createdAt, totalsWindowStart),
              ),
            )
            .then(([totals]) => {
              const normalizedTotals = {
                inputTokens: Number(totals?.inputTokens ?? 0),
                outputTokens: Number(totals?.outputTokens ?? 0),
                costCents: Number(totals?.costCents ?? 0),
                executions: Number(totals?.executions ?? 0),
              };
              writeRuntimeTotalsCache(totalsCacheKey, normalizedTotals);
              return normalizedTotals;
            });

      const recentErrorsPromise = db.drizzle
        .select({
          executionId: agentExecutions.id,
          agentId: agentExecutions.agentId,
          taskId: agentExecutions.taskId,
          status: agentExecutions.status,
          failureCategory: agentExecutions.failureCategory,
          error: agentExecutions.error,
          completedAt: agentExecutions.completedAt,
          lastEventAt: agentExecutions.lastEventAt,
        })
        .from(agentExecutions)
        .where(and(eq(agentExecutions.companyId, companyId), isNotNull(agentExecutions.error)))
        .orderBy(
          sql`${agentExecutions.lastEventAt} DESC NULLS LAST`,
          sql`${agentExecutions.completedAt} DESC NULLS LAST`,
        )
        .limit(query.recentErrorsLimit)
        .offset(query.recentErrorsOffset);

      const recentErrorsCountPromise = db.drizzle
        .select({ total: sql<number>`count(*)` })
        .from(agentExecutions)
        .where(and(eq(agentExecutions.companyId, companyId), isNotNull(agentExecutions.error)));

      const leasedEnvironmentsWhere = and(
        eq(executionEnvironments.companyId, companyId),
        eq(executionEnvironments.status, 'leased'),
      );

      const environmentLeasesPromise = Promise.all([
        db.drizzle
          .select({
            id: executionEnvironments.id,
            name: executionEnvironments.name,
            workspacePath: executionEnvironments.workspacePath,
            status: executionEnvironments.status,
            leaseOwnerAgentId: executionEnvironments.leaseOwnerAgentId,
            leaseOwnerExecutionId: executionEnvironments.leaseOwnerExecutionId,
            leasedAt: executionEnvironments.leasedAt,
          })
          .from(executionEnvironments)
          .where(leasedEnvironmentsWhere)
          .orderBy(desc(executionEnvironments.leasedAt))
          .limit(query.environmentLeaseLimit)
          .offset(query.environmentLeaseOffset),
        db.drizzle
          .select({ total: sql<number>`count(*)` })
          .from(executionEnvironments)
          .where(leasedEnvironmentsWhere),
      ]);

      const [
        { running, runningTotal },
        { retrying, retryingTotal },
        recoveryExecutions,
        recoveryTasks,
        [recoveryCount],
        totals,
        recentErrors,
        [recentErrorsCount],
        [environmentLeases, [environmentLeaseCount]],
      ] = await Promise.all([
        runningStatePromise,
        retryingStatePromise,
        recoveryExecutionsPromise,
        recoveryTasksPromise,
        recoveryCountPromise,
        totalsPromise,
        recentErrorsPromise,
        recentErrorsCountPromise,
        environmentLeasesPromise,
      ]);
      assertRequestActive();

      const recoveryTaskIds = recoveryExecutions
        .map((row) => row.recoveryTaskId)
        .filter((id): id is string => Boolean(id));
      // inArray does not preserve recoveryTaskIds order, so rebuild fetched recoveryTasks through
      // a lookup map and reassemble orderedRecoveryTasks in the original execution order.
      const recoveryTaskById = new Map(recoveryTasks.map((task) => [task.id, task]));
      const orderedRecoveryTasks = recoveryTaskIds
        .map((id) => recoveryTaskById.get(id))
        .filter((task): task is NonNullable<typeof task> => Boolean(task));

      const environmentLeaseTotal = Number(environmentLeaseCount?.total ?? 0);
      const recoveryTotal = Number(recoveryCount?.total ?? 0);
      const recentErrorsTotal = Number(recentErrorsCount?.total ?? 0);

      assertRequestActive();
      if (res.headersSent) return;

      res.json({
        data: {
          generatedAt: generatedAt.toISOString(),
          counts: {
            running: runningTotal,
            retrying: retryingTotal,
            recoveryTasks: recoveryTotal,
            recentErrors: recentErrorsTotal,
            environmentLeases: environmentLeaseTotal,
          },
          pageSize: {
            running: running.length,
            retrying: retrying.length,
            recoveryTasks: orderedRecoveryTasks.length,
            recentErrors: recentErrors.length,
            environmentLeases: environmentLeases.length,
          },
          pagination: {
            running: {
              limit: query.runningLimit,
              offset: query.runningOffset,
              total: runningTotal,
            },
            retrying: {
              limit: query.retryingLimit,
              offset: query.retryingOffset,
              total: retryingTotal,
            },
            recoveryTasks: {
              limit: query.recoveryLimit,
              offset: query.recoveryOffset,
              total: recoveryTotal,
            },
            recentErrors: {
              limit: query.recentErrorsLimit,
              offset: query.recentErrorsOffset,
              total: recentErrorsTotal,
            },
            environmentLeases: {
              limit: query.environmentLeaseLimit,
              offset: query.environmentLeaseOffset,
              total: environmentLeaseTotal,
            },
          },
          running: running.map(({ runtimeTotal: _, ...row }) => ({
            ...row,
            startedAt: row.startedAt ? row.startedAt.toISOString() : null,
            lastEventAt: row.lastEventAt?.toISOString() ?? null,
          })),
          retrying: retrying.map(({ runtimeTotal: _, ...row }) => ({
            ...row,
            retryDueAt: row.retryDueAt?.toISOString() ?? null,
          })),
          recoveryTasks: orderedRecoveryTasks.map((row) => ({
            ...row,
            updatedAt: row.updatedAt?.toISOString() ?? null,
          })),
          totals: {
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            totalTokens: totals.inputTokens + totals.outputTokens,
            costCents: totals.costCents,
            executions: totals.executions,
            windowDays: RUNTIME_TOTALS_WINDOW_DAYS,
          },
          recentErrors: recentErrors.map((row) => ({
            ...row,
            completedAt: row.completedAt?.toISOString() ?? null,
            lastEventAt: row.lastEventAt?.toISOString() ?? null,
          })),
          environmentLeases: environmentLeases.map((row) => ({
            ...row,
            leasedAt: row.leasedAt?.toISOString() ?? null,
          })),
        },
      });
    } catch (error) {
      if (res.headersSent) return;
      next(error);
    }
  });

  return router;
}
