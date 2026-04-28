import { Router } from 'express';
import { and, eq, exists, sql } from 'drizzle-orm';
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
});

const AssignEnvironmentBody = z.object({
  agentId: z.string().uuid(),
});

const EnvironmentListQuery = z.object({
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
  const { executionEnvironments, agents, agentExecutions } = db.schema;

  router.get('/', validate(EnvironmentListQuery, 'query'), async (req, res) => {
    const companyId = routeParams(req).companyId;
    const query = (req as any).validated.query as z.infer<typeof EnvironmentListQuery>;
    const rows = await db.drizzle
      .select()
      .from(executionEnvironments)
      .where(eq(executionEnvironments.companyId, companyId))
      .orderBy(executionEnvironments.createdAt)
      .limit(query.limit)
      .offset(query.offset);

    const [{ total }] = await db.drizzle
      .select({ total: sql<number>`count(*)` })
      .from(executionEnvironments)
      .where(eq(executionEnvironments.companyId, companyId));

    res.json({ data: rows, meta: { total: Number(total), limit: query.limit, offset: query.offset } });
  });

  router.post('/', validate(CreateEnvironmentBody), async (req, res) => {
    const body = req.body as z.infer<typeof CreateEnvironmentBody>;
    const companyId = routeParams(req).companyId;
    const now = new Date();

    const [row] = await db.drizzle
      .insert(executionEnvironments)
      .values({
        id: randomUUID(),
        companyId,
        name: body.name,
        provider: 'local',
        status: 'available',
        workspacePath: await normalizeWorkspacePath(companyId, body.workspacePath),
        branchName: body.branchName ?? null,
        runtimeUrl: body.runtimeUrl ?? null,
        metadata: body.metadata,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

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

    const row = await db.drizzle.transaction(async (tx) => {
      const [leased] = await tx
        .update(executionEnvironments)
        .set({
          status: 'leased',
          leaseOwnerAgentId: body.agentId,
          leaseOwnerExecutionId: body.executionId,
          leasedAt: now,
          releasedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(executionEnvironments.id, id),
            eq(executionEnvironments.companyId, companyId),
            eq(executionEnvironments.status, 'available'),
            exists(
              tx
                .select({ id: agents.id })
                .from(agents)
                .where(and(eq(agents.id, body.agentId), eq(agents.companyId, companyId))),
            ),
            exists(
              tx
                .select({ id: agentExecutions.id })
                .from(agentExecutions)
                .where(
                  and(
                    eq(agentExecutions.id, body.executionId),
                    eq(agentExecutions.agentId, body.agentId),
                    eq(agentExecutions.companyId, companyId),
                  ),
                ),
            ),
          ),
        )
        .returning();

      if (leased) {
        await tx
          .update(agentExecutions)
          .set({ environmentId: leased.id, lastEventAt: now })
          .where(
            and(
              eq(agentExecutions.id, body.executionId),
              eq(agentExecutions.companyId, companyId),
              eq(agentExecutions.agentId, body.agentId),
            ),
          );
      }

      return leased ?? null;
    });

    if (!row) {
      const [agent] = await db.drizzle
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, body.agentId), eq(agents.companyId, companyId)))
        .limit(1);

      if (!agent) {
        throw new AppError(404, 'AGENT_NOT_FOUND', `Agent ${body.agentId} not found`);
      }

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

      const [execution] = await db.drizzle
        .select({ id: agentExecutions.id })
        .from(agentExecutions)
        .where(
          and(
            eq(agentExecutions.id, body.executionId),
            eq(agentExecutions.companyId, companyId),
            eq(agentExecutions.agentId, body.agentId),
          ),
        )
        .limit(1);

      if (!execution) {
        throw new AppError(404, 'EXECUTION_NOT_FOUND', `Execution ${body.executionId} not found for agent ${body.agentId}`);
      }

      throw new AppError(409, 'ENVIRONMENT_NOT_AVAILABLE', `Environment ${id} is not available`);
    }

    const safeRow = {
      ...row,
      workspacePath: await revalidateWorkspacePathContainment(companyId, row.workspacePath),
    };

    eventBus.emitEvent({
      type: 'environment.leased',
      companyId,
      payload: { environment: safeRow },
      timestamp: now.toISOString(),
    });

    res.json({ data: safeRow });
  });

  router.post('/:id/release', validate(ReleaseEnvironmentBody), async (req, res) => {
    const body = req.body as z.infer<typeof ReleaseEnvironmentBody>;
    const { id, companyId } = routeParams(req);
    const now = new Date();

    const row = await db.drizzle.transaction(async (tx) => {
      const [released] = await tx
        .update(executionEnvironments)
        .set({
          status: 'available',
          leaseOwnerAgentId: null,
          leaseOwnerExecutionId: null,
          releasedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(executionEnvironments.id, id),
            eq(executionEnvironments.companyId, companyId),
            eq(executionEnvironments.status, 'leased'),
            eq(executionEnvironments.leaseOwnerAgentId, body.agentId),
            eq(executionEnvironments.leaseOwnerExecutionId, body.executionId),
          ),
        )
        .returning();

      if (released) {
        await tx
          .update(agentExecutions)
          .set({ environmentId: null, lastEventAt: now })
          .where(
            and(
              eq(agentExecutions.id, body.executionId),
              eq(agentExecutions.companyId, companyId),
              eq(agentExecutions.agentId, body.agentId),
            ),
          );
      }

      return released ?? null;
    });

    if (!row) {
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

      throw new AppError(
        409,
        'ENVIRONMENT_LEASE_OWNER_MISMATCH',
        `Environment ${id} can only be released by its lease owner`,
      );
    }

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
