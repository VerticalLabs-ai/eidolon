import { Router } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';
import {
  deriveWorkspaceLeaseState,
  leaseWorkspace,
  recordWorkspaceLifecycleEventWithClient,
  recoverWorkspaceLease,
  releaseWorkspaceLease,
  renewWorkspaceLease,
} from '../services/workspace-lifecycle.js';
import {
  captureWorkspaceHead,
  inspectWorkspaceDiff,
  WorkspaceDiffError,
} from '../services/workspace-diff.js';

const CreateEnvironmentBody = z.object({
  name: z.string().min(1).max(255),
  workspacePath: z.string().max(2000).optional(),
  branchName: z.string().max(255).optional(),
  runtimeUrl: z.string().url().optional(),
  metadata: z.record(z.unknown()).default({}),
});

const LeaseEnvironmentBody = z.object({
  agentId: z.string().uuid(),
  executionId: z.string().uuid(),
});

const ReleaseEnvironmentBody = z.object({
  agentId: z.string().uuid(),
  executionId: z.string().uuid(),
  leaseId: z.string().uuid(),
});

const HeartbeatEnvironmentBody = ReleaseEnvironmentBody;

const AssignEnvironmentBody = z.object({
  agentId: z.string().uuid(),
});

const EnvironmentListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const EnvironmentEventsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function workspaceRootForCompany(companyId: string): string {
  const configuredRoot = process.env.EIDOLON_WORKSPACE_ROOT ?? path.join(process.cwd(), '.eidolon', 'workspaces');
  return path.resolve(expandHome(configuredRoot), companyId);
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function realpathForContainment(targetPath: string): Promise<string> {
  let existingPath = targetPath;
  const missingSegments: string[] = [];

  while (!(await pathExists(existingPath))) {
    const parentPath = path.dirname(existingPath);
    if (parentPath === existingPath) break;

    missingSegments.unshift(path.basename(existingPath));
    existingPath = parentPath;
  }

  const realExistingPath = await fs.realpath(existingPath);
  return missingSegments.length > 0
    ? path.resolve(realExistingPath, ...missingSegments)
    : realExistingPath;
}

function assertWorkspacePathInsideRoot(realRoot: string, realWorkspacePath: string): void {
  const relativeToRoot = path.relative(realRoot, realWorkspacePath);

  if (
    relativeToRoot === '..' ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new AppError(
      400,
      'WORKSPACE_PATH_OUTSIDE_ROOT',
      'workspacePath must be within the workspace root',
    );
  }
}

async function revalidateWorkspacePathContainment(
  companyId: string,
  workspacePath: string | null,
): Promise<string | null> {
  if (!workspacePath) return null;

  const root = workspaceRootForCompany(companyId);
  await fs.mkdir(root, { recursive: true });

  const realRoot = await fs.realpath(root);
  const realWorkspacePath = await realpathForContainment(workspacePath);
  assertWorkspacePathInsideRoot(realRoot, realWorkspacePath);
  return realWorkspacePath;
}

async function normalizeWorkspacePath(companyId: string, workspacePath?: string): Promise<string | null> {
  if (!workspacePath) return null;
  if (workspacePath.includes('\0')) {
    throw new AppError(400, 'INVALID_WORKSPACE_PATH', 'workspacePath cannot contain null bytes');
  }

  const root = workspaceRootForCompany(companyId);
  const expanded = expandHome(workspacePath);
  const absolutePath = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(root, expanded);
  await fs.mkdir(root, { recursive: true });

  const realRoot = await fs.realpath(root);
  const realAbsolutePath = await realpathForContainment(absolutePath);
  assertWorkspacePathInsideRoot(realRoot, realAbsolutePath);
  return realAbsolutePath;
}

export function environmentsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { executionEnvironments, workspaceLifecycleEvents, agents, agentExecutions } = db.schema;

  router.get('/', validate(EnvironmentListQuery, 'query'), async (req, res) => {
    const companyId = routeParams(req).companyId;
    const query = (req as any).validated.query as z.infer<typeof EnvironmentListQuery>;
    const rows = await db.drizzle
      .select({
        id: executionEnvironments.id,
        companyId: executionEnvironments.companyId,
        name: executionEnvironments.name,
        provider: executionEnvironments.provider,
        status: executionEnvironments.status,
        workspacePath: executionEnvironments.workspacePath,
        branchName: executionEnvironments.branchName,
        runtimeUrl: executionEnvironments.runtimeUrl,
        leaseOwnerAgentId: executionEnvironments.leaseOwnerAgentId,
        leaseOwnerExecutionId: executionEnvironments.leaseOwnerExecutionId,
        leasedAt: executionEnvironments.leasedAt,
        leaseHeartbeatAt: executionEnvironments.leaseHeartbeatAt,
        leaseExpiresAt: executionEnvironments.leaseExpiresAt,
        releasedAt: executionEnvironments.releasedAt,
        metadata: executionEnvironments.metadata,
        createdAt: executionEnvironments.createdAt,
        updatedAt: executionEnvironments.updatedAt,
      })
      .from(executionEnvironments)
      .where(eq(executionEnvironments.companyId, companyId))
      .orderBy(executionEnvironments.createdAt)
      .limit(query.limit)
      .offset(query.offset);

    const [{ total }] = await db.drizzle
      .select({ total: sql<number>`count(*)` })
      .from(executionEnvironments)
      .where(eq(executionEnvironments.companyId, companyId));

    // leaseId is a fencing token that authorizes heartbeat/release, so it is never listed;
    // callers get the derived lease state instead.
    const listedAt = new Date();
    const data = rows.map((row) => ({
      ...row,
      leaseState: deriveWorkspaceLeaseState(
        { status: row.status, leaseId: 'redacted', leaseExpiresAt: row.leaseExpiresAt },
        listedAt,
      ),
    }));

    res.json({ data, meta: { total: Number(total), limit: query.limit, offset: query.offset } });
  });

  router.post('/', validate(CreateEnvironmentBody), async (req, res) => {
    const body = req.body as z.infer<typeof CreateEnvironmentBody>;
    const companyId = routeParams(req).companyId;
    const now = new Date();

    const workspacePath = await normalizeWorkspacePath(companyId, body.workspacePath);
    const row = await db.drizzle.transaction(async (tx) => {
      const [created] = await tx
        .insert(executionEnvironments)
        .values({
          id: randomUUID(),
          companyId,
          name: body.name,
          provider: 'local',
          status: 'available',
          workspacePath,
          branchName: body.branchName ?? null,
          runtimeUrl: body.runtimeUrl ?? null,
          metadata: body.metadata,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await recordWorkspaceLifecycleEventWithClient(db, tx, {
        companyId,
        environmentId: created.id,
        eventType: 'created',
        now,
      });
      return created;
    });

    eventBus.emitEvent({
      type: 'environment.created',
      companyId,
      payload: { environment: row },
      timestamp: now.toISOString(),
    });

    res.status(201).json({ data: row });
  });

  router.post('/:id/lease', validate(LeaseEnvironmentBody), async (req, res) => {
    const body = req.body as z.infer<typeof LeaseEnvironmentBody>;
    const { id, companyId } = routeParams(req);
    const now = new Date();
    const [agent, execution, environment] = await Promise.all([
      db.drizzle
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, body.agentId), eq(agents.companyId, companyId)))
        .limit(1)
        .then(([row]) => row),
      db.drizzle
        .select({ id: agentExecutions.id })
        .from(agentExecutions)
        .where(
          and(
            eq(agentExecutions.id, body.executionId),
            eq(agentExecutions.companyId, companyId),
            eq(agentExecutions.agentId, body.agentId),
          ),
        )
        .limit(1)
        .then(([row]) => row),
      db.drizzle
        .select({ workspacePath: executionEnvironments.workspacePath })
        .from(executionEnvironments)
        .where(and(eq(executionEnvironments.id, id), eq(executionEnvironments.companyId, companyId)))
        .limit(1)
        .then(([row]) => row),
    ]);
    if (!agent) throw new AppError(404, 'AGENT_NOT_FOUND', `Agent ${body.agentId} not found`);
    if (!execution) {
      throw new AppError(404, 'EXECUTION_NOT_FOUND', `Execution ${body.executionId} not found for agent ${body.agentId}`);
    }
    if (!environment) throw new AppError(404, 'ENVIRONMENT_NOT_FOUND', `Environment ${id} not found`);

    const workspacePath = await revalidateWorkspacePathContainment(companyId, environment.workspacePath);
    let baseSha: string | null = null;
    if (workspacePath) {
      try {
        baseSha = await captureWorkspaceHead(workspacePath);
      } catch (error) {
        if (
          !(error instanceof WorkspaceDiffError) ||
          !['WORKSPACE_PATH_NOT_FOUND', 'WORKSPACE_NOT_GIT_REPOSITORY'].includes(error.code)
        ) {
          throw error;
        }
      }
    }

    const row = await leaseWorkspace(db, {
      companyId,
      environmentId: id,
      agentId: body.agentId,
      executionId: body.executionId,
      baseSha,
      now,
    });

    const safeRow = {
      ...row,
      workspacePath: await revalidateWorkspacePathContainment(companyId, row.workspacePath),
    };

    // The lease token is returned to the caller that minted it, never broadcast to subscribers.
    const { leaseId: _leaseToken, ...broadcastRow } = safeRow;
    eventBus.emitEvent({
      type: 'environment.leased',
      companyId,
      payload: { environment: broadcastRow },
      timestamp: now.toISOString(),
    });

    res.json({ data: safeRow });
  });

  router.post('/:id/release', validate(ReleaseEnvironmentBody), async (req, res) => {
    const body = req.body as z.infer<typeof ReleaseEnvironmentBody>;
    const { id, companyId } = routeParams(req);
    const now = new Date();
    const row = await releaseWorkspaceLease(db, {
      companyId,
      environmentId: id,
      agentId: body.agentId,
      executionId: body.executionId,
      leaseId: body.leaseId,
      now,
    });

    const safeRow = {
      ...row,
      workspacePath: await revalidateWorkspacePathContainment(companyId, row.workspacePath),
    };

    eventBus.emitEvent({
      type: 'environment.released',
      companyId,
      payload: { environment: safeRow },
      timestamp: now.toISOString(),
    });

    res.json({ data: safeRow });
  });

  router.post('/:id/heartbeat', validate(HeartbeatEnvironmentBody), async (req, res) => {
    const body = req.body as z.infer<typeof HeartbeatEnvironmentBody>;
    const { id, companyId } = routeParams(req);
    const row = await renewWorkspaceLease(db, {
      companyId,
      environmentId: id,
      agentId: body.agentId,
      executionId: body.executionId,
      leaseId: body.leaseId,
    });
    res.json({ data: row });
  });

  router.post('/:id/recover', async (req, res) => {
    const { id, companyId } = routeParams(req);
    const row = await recoverWorkspaceLease(db, {
      companyId,
      environmentId: id,
      recoveredByUserId: req.user?.id ?? null,
    });
    eventBus.emitEvent({
      type: 'environment.recovered' as any,
      companyId,
      payload: { environment: row },
      timestamp: new Date().toISOString(),
    });
    res.json({ data: row });
  });

  router.get('/:id/events', validate(EnvironmentEventsQuery, 'query'), async (req, res) => {
    const { id, companyId } = routeParams(req);
    const query = (req as any).validated.query as z.infer<typeof EnvironmentEventsQuery>;
    const environment = await db.drizzle
      .select({ id: executionEnvironments.id })
      .from(executionEnvironments)
      .where(and(eq(executionEnvironments.id, id), eq(executionEnvironments.companyId, companyId)))
      .limit(1)
      .then(([row]) => row);
    if (!environment) throw new AppError(404, 'ENVIRONMENT_NOT_FOUND', `Environment ${id} not found`);

    const [rows, [{ total }]] = await Promise.all([
      db.drizzle
        .select()
        .from(workspaceLifecycleEvents)
        .where(and(
          eq(workspaceLifecycleEvents.environmentId, id),
          eq(workspaceLifecycleEvents.companyId, companyId),
        ))
        .orderBy(desc(workspaceLifecycleEvents.createdAt))
        .limit(query.limit)
        .offset(query.offset),
      db.drizzle
        .select({ total: sql<number>`count(*)` })
        .from(workspaceLifecycleEvents)
        .where(and(
          eq(workspaceLifecycleEvents.environmentId, id),
          eq(workspaceLifecycleEvents.companyId, companyId),
        )),
    ]);
    res.json({ data: rows, meta: { total: Number(total), limit: query.limit, offset: query.offset } });
  });

  router.get('/:id/diff', async (req, res) => {
    const { id, companyId } = routeParams(req);
    const environment = await db.drizzle
      .select()
      .from(executionEnvironments)
      .where(and(eq(executionEnvironments.id, id), eq(executionEnvironments.companyId, companyId)))
      .limit(1)
      .then(([row]) => row);
    if (!environment) throw new AppError(404, 'ENVIRONMENT_NOT_FOUND', `Environment ${id} not found`);
    const workspacePath = await revalidateWorkspacePathContainment(companyId, environment.workspacePath);
    if (!workspacePath) {
      throw new AppError(404, 'WORKSPACE_PATH_NOT_FOUND', `Environment ${id} does not have a workspace path`);
    }
    if (!environment.leaseBaseSha) {
      throw new AppError(409, 'WORKSPACE_DIFF_BASE_UNAVAILABLE', `Environment ${id} has no captured diff base`);
    }

    try {
      const diff = await inspectWorkspaceDiff({ workspacePath, baseSha: environment.leaseBaseSha });
      res.json({
        data: {
          environmentId: id,
          leaseState: deriveWorkspaceLeaseState(environment),
          branch: environment.branchName,
          ...diff,
          generatedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      if (!(error instanceof WorkspaceDiffError)) throw error;
      const status = error.code === 'WORKSPACE_PATH_NOT_FOUND'
        ? 404
        : error.code === 'WORKSPACE_NOT_GIT_REPOSITORY'
          ? 422
          : error.code === 'WORKSPACE_DIFF_BASE_UNAVAILABLE'
            ? 409
            : 500;
      throw new AppError(status, error.code, error.message);
    }
  });

  router.post('/:id/assign', validate(AssignEnvironmentBody), async (req, res) => {
    const body = req.body as z.infer<typeof AssignEnvironmentBody>;
    const { id, companyId } = routeParams(req);
    const now = new Date();

    const [environment] = await db.drizzle
      .select({ id: executionEnvironments.id })
      .from(executionEnvironments)
      .where(
        and(
          eq(executionEnvironments.id, id),
          eq(executionEnvironments.companyId, companyId),
        ),
      )
      .limit(1);

    if (!environment) {
      throw new AppError(404, 'ENVIRONMENT_NOT_FOUND', `Environment ${id} not found`);
    }

    const [agent] = await db.drizzle
      .update(agents)
      .set({ defaultEnvironmentId: id, updatedAt: now })
      .where(and(eq(agents.id, body.agentId), eq(agents.companyId, companyId)))
      .returning();

    if (!agent) {
      throw new AppError(404, 'AGENT_NOT_FOUND', `Agent ${body.agentId} not found`);
    }

    eventBus.emitEvent({
      type: 'environment.assigned',
      companyId,
      payload: { agentId: agent.id, environmentId: id },
      timestamp: now.toISOString(),
    });

    res.json({ data: { agent, environment } });
  });

  return router;
}
