import { and, desc, eq, sql } from "drizzle-orm";
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../middleware/error-handler.js";
import { validate } from "../middleware/validate.js";
import eventBus from "../realtime/events.js";
import { encrypt } from "../services/crypto.js";
import { AgentExecutor } from "../services/agent-executor.js";
import { AgenticLoop } from "../services/agentic-loop.js";
import { HeartbeatScheduler } from "../services/scheduler.js";
import type { DbInstance } from "../types.js";
import { routeParams } from "../utils/route-params.js";

const LIVENESS_STATUS_HEALTHY = "healthy";
const LAST_USEFUL_ACTION_MANUAL_EXECUTION = "manual_execution_created";
const NEXT_ACTION_HINT_AWAIT_LOG = "await_log_or_completion";

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const CreateAgentBody = z.object({
  name: z.string().min(1).max(255),
  role: z.enum([
    "ceo",
    "cto",
    "cfo",
    "engineer",
    "designer",
    "marketer",
    "sales",
    "support",
    "hr",
    "custom",
  ]),
  title: z.string().min(1).max(255).optional(),
  provider: z
    .enum([
      "anthropic",
      "openai",
      "google",
      "local",
      "ollama",
    ])
    .default("anthropic"),
  model: z.string().min(1).max(255).default("claude-opus-4-7"),
  status: z
    .enum(["idle", "working", "paused", "error", "offline"])
    .default("idle"),
  reportsTo: z.string().uuid().nullable().default(null),
  capabilities: z.array(z.string().min(1).max(100)).default([]),
  systemPrompt: z.string().max(50_000).optional(),
  budgetMonthlyCents: z.number().int().nonnegative().default(0),
  config: z.record(z.unknown()).default({}),
  metadata: z.record(z.unknown()).default({}),
  permissions: z.array(z.string()).default([]),
  // New fields
  apiKeyEncrypted: z.string().max(2000).optional(),
  apiKeyProvider: z.string().max(100).optional(),
  instructions: z.string().max(100_000).optional(),
  instructionsFormat: z.string().max(50).default("markdown"),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().positive().default(4096),
  toolsEnabled: z.array(z.string()).default([]),
  allowedDomains: z.array(z.string()).default([]),
  maxConcurrentTasks: z.number().int().positive().default(1),
  heartbeatIntervalSeconds: z.number().int().positive().default(300),
  autoAssignTasks: z.number().int().min(0).max(1).default(0),
});

const UpdateAgentBody = z.object({
  name: z.string().min(1).max(255).optional(),
  role: z
    .enum([
      "ceo",
      "cto",
      "cfo",
      "engineer",
      "designer",
      "marketer",
      "sales",
      "support",
      "hr",
      "custom",
    ])
    .optional(),
  title: z.string().min(1).max(255).nullable().optional(),
  provider: z
    .enum(["anthropic", "openai", "google", "local", "ollama"])
    .optional(),
  model: z.string().min(1).max(255).optional(),
  status: z.enum(["idle", "working", "paused", "error", "offline"]).optional(),
  reportsTo: z.string().uuid().nullable().optional(),
  capabilities: z.array(z.string().min(1).max(100)).optional(),
  systemPrompt: z.string().max(50_000).nullable().optional(),
  budgetMonthlyCents: z.number().int().nonnegative().optional(),
  config: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
  permissions: z.array(z.string()).optional(),
  // New fields
  apiKeyEncrypted: z.string().max(2000).nullable().optional(),
  apiKeyProvider: z.string().max(100).nullable().optional(),
  instructions: z.string().max(100_000).nullable().optional(),
  instructionsFormat: z.string().max(50).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  toolsEnabled: z.array(z.string()).optional(),
  allowedDomains: z.array(z.string()).optional(),
  maxConcurrentTasks: z.number().int().positive().optional(),
  heartbeatIntervalSeconds: z.number().int().positive().optional(),
  autoAssignTasks: z.number().int().min(0).max(1).optional(),
});

const UpdateInstructionsBody = z.object({
  instructions: z.string().max(100_000),
  format: z.string().max(50).default("markdown"),
});

const CreateExecutionBody = z.object({
  taskId: z.string().uuid().optional(),
  modelUsed: z.string().max(255).optional(),
  provider: z.string().max(100).optional(),
});

const UpdateExecutionBody = z.object({
  status: z.enum(["running", "completed", "failed", "cancelled"]).optional(),
  livenessStatus: z
    .enum(["healthy", "silent", "stalled", "recovering", "recovered"])
    .optional(),
  lastUsefulAction: z.string().max(5000).nullable().optional(),
  nextActionHint: z.string().max(5000).nullable().optional(),
  continuationAttempted: z.boolean().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  costCents: z.number().int().nonnegative().optional(),
  modelUsed: z.string().max(255).optional(),
  provider: z.string().max(100).optional(),
  summary: z.string().max(10_000).optional(),
  error: z.string().max(10_000).optional(),
  logEntry: z
    .object({
      level: z.string().max(20),
      message: z.string().max(5000),
      // Optional structured transcript fields
      phase: z.enum(["observe", "think", "act", "reflect"]).optional(),
      iteration: z.number().int().positive().optional(),
      content: z.string().max(50_000).optional(),
      toolCalls: z
        .array(
          z.object({
            tool: z.string().max(255),
            serverId: z.string().max(255).optional(),
            args: z.record(z.unknown()),
            result: z.string().max(50_000),
          }),
        )
        .optional(),
    })
    .optional(),
});

const ExecuteAgentBody = z.object({
  taskId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Helper: snapshot agent config fields for revision tracking
// ---------------------------------------------------------------------------

const TRACKED_CONFIG_KEYS = [
  "name",
  "role",
  "title",
  "provider",
  "model",
  "systemPrompt",
  "capabilities",
  "config",
  "permissions",
  "apiKeyEncrypted",
  "apiKeyProvider",
  "instructions",
  "instructionsFormat",
  "temperature",
  "maxTokens",
  "toolsEnabled",
  "allowedDomains",
  "maxConcurrentTasks",
  "heartbeatIntervalSeconds",
  "autoAssignTasks",
  "budgetMonthlyCents",
  "reportsTo",
  "metadata",
] as const;

function snapshotConfig(
  agent: Record<string, unknown>,
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const key of TRACKED_CONFIG_KEYS) {
    if (key in agent) {
      snapshot[key] = agent[key];
    }
  }
  return snapshot;
}

function normalizeAgentProvider(
  provider: "anthropic" | "openai" | "google" | "local" | "ollama",
): "anthropic" | "openai" | "google" | "local" {
  return provider === "ollama" ? "local" : provider;
}

function isEncryptedValue(value: string): boolean {
  const parts = value.split(":");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

function normalizeApiKeyForStorage(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value.length === 0) {
    return null;
  }

  return isEncryptedValue(value) ? value : encrypt(value);
}

type ExecutionRow = {
  id: string;
  agentId: string;
  taskId: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: Date;
  completedAt: Date | null;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  modelUsed: string | null;
  provider: string | null;
  summary: string | null;
  error: string | null;
  livenessStatus: "healthy" | "silent" | "stalled" | "recovering" | "recovered";
  lastUsefulAction: string | null;
  nextActionHint: string | null;
  continuationAttempts: number;
  lastContinuationAt: Date | null;
  watchdogLastCheckedAt: Date | null;
  recoveryTaskId: string | null;
  retryAttempt: number;
  retryStatus: "none" | "scheduled" | "retrying" | "exhausted" | "released";
  retryDueAt: Date | null;
  failureCategory: string | null;
  lastEventAt: Date | null;
  executionMode: "single" | "agentic-loop" | "manual" | "recovery";
  environmentId: string | null;
  log: Array<{ timestamp: string; level: string; message: string }>;
};

function serializeExecution(
  row: ExecutionRow,
): Record<string, unknown> {
  const log = Array.isArray(row.log) ? row.log : [];
  const latestLog = log.at(-1);
  const startedAt = new Date(row.startedAt);
  const completedAt = row.completedAt ? new Date(row.completedAt) : null;
  const durationMs = completedAt
    ? completedAt.getTime() - startedAt.getTime()
    : row.status === "running"
      ? Date.now() - startedAt.getTime()
      : null;
  const tokensUsed = (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
  const action =
    row.summary ??
    latestLog?.message ??
    ([row.provider, row.modelUsed].filter(Boolean).join(" / ") || "Execution");

  return {
    id: row.id,
    agentId: row.agentId,
    taskId: row.taskId ?? null,
    action,
    status: row.status,
    input: null,
    output: null,
    summary: row.summary ?? null,
    provider: row.provider ?? null,
    modelUsed: row.modelUsed ?? null,
    inputTokens: row.inputTokens ?? 0,
    outputTokens: row.outputTokens ?? 0,
    costCents: row.costCents ?? 0,
    log,
    tokensUsed,
    durationMs,
    error: row.error ?? null,
    livenessStatus: row.livenessStatus,
    lastUsefulAction: row.lastUsefulAction ?? null,
    nextActionHint: row.nextActionHint ?? null,
    continuationAttempts: row.continuationAttempts ?? 0,
    lastContinuationAt: row.lastContinuationAt
      ? new Date(row.lastContinuationAt).toISOString()
      : null,
    watchdogLastCheckedAt: row.watchdogLastCheckedAt
      ? new Date(row.watchdogLastCheckedAt).toISOString()
      : null,
    recoveryTaskId: row.recoveryTaskId ?? null,
    retryAttempt: row.retryAttempt ?? 0,
    retryStatus: row.retryStatus ?? "none",
    retryDueAt: row.retryDueAt ? new Date(row.retryDueAt).toISOString() : null,
    failureCategory: row.failureCategory ?? null,
    lastEventAt: row.lastEventAt ? new Date(row.lastEventAt).toISOString() : null,
    executionMode: row.executionMode ?? "single",
    environmentId: row.environmentId ?? null,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function agentsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { agents, tasks, agentConfigRevisions, agentExecutions } = db.schema;

  // GET /api/companies/:companyId/agents - list by company
  router.get("/", async (req, res) => {
    const rows = await db.drizzle
      .select()
      .from(agents)
      .where(eq(agents.companyId, routeParams(req).companyId));
    res.json({ data: rows });
  });

  // POST /api/companies/:companyId/agents - create
  router.post("/", validate(CreateAgentBody), async (req, res) => {
    const body = req.body as z.infer<typeof CreateAgentBody>;
    const companyId = routeParams(req).companyId;
    const now = new Date();
    const provider = normalizeAgentProvider(body.provider);
    const apiKeyEncrypted = normalizeApiKeyForStorage(body.apiKeyEncrypted);

    const [row] = await db.drizzle
      .insert(agents)
      .values({
        companyId,
        name: body.name,
        role: body.role,
        title: body.title ?? null,
        provider,
        model: body.model,
        status: body.status,
        reportsTo: body.reportsTo,
        capabilities: body.capabilities,
        systemPrompt: body.systemPrompt ?? null,
        budgetMonthlyCents: body.budgetMonthlyCents,
        spentMonthlyCents: 0,
        config: body.config,
        metadata: body.metadata,
        permissions: body.permissions,
        // New fields
        apiKeyEncrypted: apiKeyEncrypted ?? null,
        apiKeyProvider: apiKeyEncrypted ? body.apiKeyProvider ?? provider : body.apiKeyProvider ?? null,
        instructions: body.instructions ?? null,
        instructionsFormat: body.instructionsFormat,
        temperature: body.temperature,
        maxTokens: body.maxTokens,
        toolsEnabled: body.toolsEnabled,
        allowedDomains: body.allowedDomains,
        maxConcurrentTasks: body.maxConcurrentTasks,
        heartbeatIntervalSeconds: body.heartbeatIntervalSeconds,
        autoAssignTasks: body.autoAssignTasks,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    eventBus.emitEvent({
      type: "agent.created",
      companyId,
      payload: { agent: row },
      timestamp: now.toISOString(),
    });

    res.status(201).json({ data: row });
  });

  // GET /api/companies/:companyId/agents/:id - get
  router.get("/:id", async (req, res) => {
    const [row] = await db.drizzle
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.id, routeParams(req).id),
          eq(agents.companyId, routeParams(req).companyId),
        ),
      )
      .limit(1);

    if (!row) {
      throw new AppError(
        404,
        "AGENT_NOT_FOUND",
        `Agent ${routeParams(req).id} not found`,
      );
    }
    res.json({ data: row });
  });

  // PATCH /api/companies/:companyId/agents/:id - update (with revision tracking)
  router.patch("/:id", validate(UpdateAgentBody), async (req, res) => {
    const body = req.body as z.infer<typeof UpdateAgentBody>;
    const { id, companyId } = routeParams(req);

    const [existing] = await db.drizzle
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, "AGENT_NOT_FOUND", `Agent ${id} not found`);
    }

    // Snapshot BEFORE state
    const beforeConfig = snapshotConfig(
      existing as unknown as Record<string, unknown>,
    );

    const statusChanged = body.status && body.status !== existing.status;
    const updates: Record<string, unknown> = {
      ...body,
      updatedAt: new Date(),
    };

    if (body.provider !== undefined) {
      updates.provider = normalizeAgentProvider(body.provider);
    }

    if (body.apiKeyEncrypted !== undefined) {
      const apiKeyEncrypted = normalizeApiKeyForStorage(body.apiKeyEncrypted);
      updates.apiKeyEncrypted = apiKeyEncrypted;
      updates.apiKeyProvider = apiKeyEncrypted
        ? body.apiKeyProvider ??
          (updates.provider as string | undefined) ??
          existing.provider
        : null;
    } else if (body.apiKeyProvider !== undefined) {
      updates.apiKeyProvider = body.apiKeyProvider;
    }

    const [updated] = await db.drizzle
      .update(agents)
      .set(updates)
      .where(eq(agents.id, id))
      .returning();

    // Snapshot AFTER state and record revision
    const afterConfig = snapshotConfig(
      updated as unknown as Record<string, unknown>,
    );
    const changedKeys = Object.keys(body).filter((k) =>
      TRACKED_CONFIG_KEYS.includes(k as any),
    );

    if (changedKeys.length > 0) {
      const revisionId = randomUUID();
      const revisionNow = new Date();

      await db.drizzle.insert(agentConfigRevisions).values({
        id: revisionId,
        companyId,
        agentId: id,
        changedBy: null,
        changedKeys,
        beforeConfig,
        afterConfig,
        createdAt: revisionNow,
      });
    }

    if (statusChanged) {
      eventBus.emitEvent({
        type: "agent.status_changed",
        companyId,
        payload: {
          agentId: id,
          previousStatus: existing.status,
          newStatus: body.status!,
        },
        timestamp: new Date().toISOString(),
      });
    }

    eventBus.emitEvent({
      type: "agent.updated",
      companyId,
      payload: { agent: updated, changes: Object.keys(body) },
      timestamp: new Date().toISOString(),
    });

    res.json({ data: updated });
  });

  // DELETE /api/companies/:companyId/agents/:id - terminate
  router.delete("/:id", async (req, res) => {
    const { id, companyId } = routeParams(req);

    const [existing] = await db.drizzle
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, "AGENT_NOT_FOUND", `Agent ${id} not found`);
    }

    const [terminated] = await db.drizzle
      .update(agents)
      .set({ status: "offline", updatedAt: new Date() })
      .where(eq(agents.id, id))
      .returning();

    eventBus.emitEvent({
      type: "agent.terminated",
      companyId,
      payload: { agent: terminated },
      timestamp: new Date().toISOString(),
    });

    res.json({ data: terminated });
  });

  // POST /api/companies/:companyId/agents/:id/heartbeat
  router.post("/:id/heartbeat", async (req, res) => {
    const { id, companyId } = routeParams(req);
    const now = new Date();

    const [updated] = await db.drizzle
      .update(agents)
      .set({ lastHeartbeatAt: now, updatedAt: now })
      .where(and(eq(agents.id, id), eq(agents.companyId, companyId)))
      .returning();

    if (!updated) {
      throw new AppError(404, "AGENT_NOT_FOUND", `Agent ${id} not found`);
    }

    eventBus.emitEvent({
      type: "agent.heartbeat",
      companyId,
      payload: { agentId: id, heartbeatAt: now.toISOString() },
      timestamp: now.toISOString(),
    });

    res.json({ data: { agentId: id, heartbeatAt: now.toISOString() } });
  });

  // GET /api/companies/:companyId/agents/:id/metrics
  router.get("/:id/metrics", async (req, res) => {
    const { id, companyId } = routeParams(req);

    const [agent] = await db.drizzle
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.companyId, companyId)))
      .limit(1);

    if (!agent) {
      throw new AppError(404, "AGENT_NOT_FOUND", `Agent ${id} not found`);
    }

    const taskStats = await db.drizzle
      .select({
        status: tasks.status,
        count: sql<number>`count(*)`,
      })
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.assigneeAgentId, id)))
      .groupBy(tasks.status);

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const r of taskStats) {
      byStatus[r.status] = Number(r.count);
      total += Number(r.count);
    }

    res.json({
      data: {
        agentId: id,
        status: agent.status,
        budget: {
          monthlyCents: agent.budgetMonthlyCents,
          spentCents: agent.spentMonthlyCents,
          remainingCents: agent.budgetMonthlyCents - agent.spentMonthlyCents,
          utilizationPct:
            agent.budgetMonthlyCents > 0
              ? Math.round(
                  (agent.spentMonthlyCents / agent.budgetMonthlyCents) * 100,
                )
              : 0,
        },
        tasks: { total, byStatus },
        lastHeartbeatAt: agent.lastHeartbeatAt,
      },
    });
  });

  // =========================================================================
  // Instructions endpoints
  // =========================================================================

  // GET /api/companies/:companyId/agents/:id/instructions
  router.get("/:id/instructions", async (req, res) => {
    const { id, companyId } = routeParams(req);

    const [agent] = await db.drizzle
      .select({
        instructions: agents.instructions,
        instructionsFormat: agents.instructionsFormat,
      })
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.companyId, companyId)))
      .limit(1);

    if (!agent) {
      throw new AppError(404, "AGENT_NOT_FOUND", `Agent ${id} not found`);
    }

    res.json({
      data: {
        agentId: id,
        instructions: agent.instructions,
        format: agent.instructionsFormat,
      },
    });
  });

  // PUT /api/companies/:companyId/agents/:id/instructions
  router.put(
    "/:id/instructions",
    validate(UpdateInstructionsBody),
    async (req, res) => {
      const body = req.body as z.infer<typeof UpdateInstructionsBody>;
      const { id, companyId } = routeParams(req);

      const [existing] = await db.drizzle
        .select()
        .from(agents)
        .where(and(eq(agents.id, id), eq(agents.companyId, companyId)))
        .limit(1);

      if (!existing) {
        throw new AppError(404, "AGENT_NOT_FOUND", `Agent ${id} not found`);
      }

      // Snapshot before state for revision
      const beforeConfig = snapshotConfig(
        existing as unknown as Record<string, unknown>,
      );

      const now = new Date();
      const [updated] = await db.drizzle
        .update(agents)
        .set({
          instructions: body.instructions,
          instructionsFormat: body.format,
          updatedAt: now,
        })
        .where(eq(agents.id, id))
        .returning();

      const afterConfig = snapshotConfig(
        updated as unknown as Record<string, unknown>,
      );

      await db.drizzle.insert(agentConfigRevisions).values({
        id: randomUUID(),
        companyId,
        agentId: id,
        changedBy: null,
        changedKeys: ["instructions", "instructionsFormat"],
        beforeConfig,
        afterConfig,
        createdAt: now,
      });

      eventBus.emitEvent({
        type: "agent.updated",
        companyId,
        payload: {
          agent: updated,
          changes: ["instructions", "instructionsFormat"],
        },
        timestamp: now.toISOString(),
      });

      res.json({
        data: {
          agentId: id,
          instructions: updated.instructions,
          format: updated.instructionsFormat,
        },
      });
    },
  );

  // =========================================================================
  // Heartbeat status & wake endpoints
  // =========================================================================

  // GET /api/companies/:companyId/agents/:id/heartbeat-status
  router.get("/:id/heartbeat-status", async (req, res) => {
    const { id, companyId } = routeParams(req);

    const [agent] = await db.drizzle
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.companyId, companyId)))
      .limit(1);

    if (!agent) {
      throw new AppError(404, "AGENT_NOT_FOUND", `Agent ${id} not found`);
    }

    const now = Date.now();
    const intervalMs = (agent.heartbeatIntervalSeconds ?? 300) * 1000;
    const lastBeat = agent.lastHeartbeatAt
      ? new Date(agent.lastHeartbeatAt).getTime()
      : null;
    const nextBeatAt = lastBeat
      ? new Date(lastBeat + intervalMs).toISOString()
      : null;
    const isOverdue = lastBeat ? now - lastBeat > intervalMs : false;

    res.json({
      data: {
        agentId: id,
        lastHeartbeatAt: agent.lastHeartbeatAt
          ? new Date(agent.lastHeartbeatAt).toISOString()
          : null,
        heartbeatIntervalSeconds: agent.heartbeatIntervalSeconds,
        autoAssignTasks: agent.autoAssignTasks === 1,
        nextHeartbeatAt: nextBeatAt,
        isOverdue,
        status: agent.status,
      },
    });
  });

  // POST /api/companies/:companyId/agents/:id/wake
  router.post("/:id/wake", async (req, res) => {
    const { id, companyId } = routeParams(req);

    const [agent] = await db.drizzle
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.companyId, companyId)))
      .limit(1);

    if (!agent) {
      throw new AppError(404, "AGENT_NOT_FOUND", `Agent ${id} not found`);
    }

    if (agent.status !== "idle") {
      return res.status(409).json({
        error: "AGENT_NOT_IDLE",
        message: `Agent is currently ${agent.status} and cannot be woken`,
      });
    }

    const scheduler = new HeartbeatScheduler(db);
    const result = await scheduler.wakeAgent(id);

    if (result.assigned) {
      res.json({
        data: {
          agentId: id,
          assigned: true,
          taskId: result.taskId,
          message: "Agent woken and task assigned",
        },
      });
    } else {
      // Update heartbeat even if no task was found
      const now = new Date();
      await db.drizzle
        .update(agents)
        .set({ lastHeartbeatAt: now, updatedAt: now })
        .where(eq(agents.id, id));

      res.json({
        data: {
          agentId: id,
          assigned: false,
          message: "Agent woken but no unassigned tasks available",
        },
      });
    }
  });

  // =========================================================================
  // Config Revisions endpoints
  // =========================================================================

  // GET /api/companies/:companyId/agents/:id/revisions
  router.get("/:id/revisions", async (req, res) => {
    const { id, companyId } = routeParams(req);

    // Verify agent exists
    const [agent] = await db.drizzle
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.companyId, companyId)))
      .limit(1);

    if (!agent) {
      throw new AppError(404, "AGENT_NOT_FOUND", `Agent ${id} not found`);
    }

    const rows = await db.drizzle
      .select()
      .from(agentConfigRevisions)
      .where(
        and(
          eq(agentConfigRevisions.agentId, id),
          eq(agentConfigRevisions.companyId, companyId),
        ),
      )
      .orderBy(desc(agentConfigRevisions.createdAt))
      .limit(100);

    res.json({ data: rows });
  });

  // POST /api/companies/:companyId/agents/:id/revisions/:revisionId/rollback
  router.post("/:id/revisions/:revisionId/rollback", async (req, res) => {
    const { id, companyId, revisionId } = routeParams(req);

    const [agent] = await db.drizzle
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.companyId, companyId)))
      .limit(1);

    if (!agent) {
      throw new AppError(404, "AGENT_NOT_FOUND", `Agent ${id} not found`);
    }

    const [revision] = await db.drizzle
      .select()
      .from(agentConfigRevisions)
      .where(
        and(
          eq(agentConfigRevisions.id, revisionId),
          eq(agentConfigRevisions.agentId, id),
        ),
      )
      .limit(1);

    if (!revision) {
      throw new AppError(
        404,
        "REVISION_NOT_FOUND",
        `Revision ${revisionId} not found`,
      );
    }

    // Use the beforeConfig from the target revision to restore the agent
    const beforeConfig = snapshotConfig(
      agent as unknown as Record<string, unknown>,
    );
    const restoreConfig = revision.beforeConfig as Record<string, unknown>;

    const now = new Date();
    const [updated] = await db.drizzle
      .update(agents)
      .set({ ...restoreConfig, updatedAt: now } as any)
      .where(eq(agents.id, id))
      .returning();

    const afterConfig = snapshotConfig(
      updated as unknown as Record<string, unknown>,
    );

    // Record rollback as a new revision
    await db.drizzle.insert(agentConfigRevisions).values({
      id: randomUUID(),
      companyId,
      agentId: id,
      changedBy: null,
      changedKeys: Object.keys(restoreConfig),
      beforeConfig,
      afterConfig,
      createdAt: now,
    });

    eventBus.emitEvent({
      type: "agent.updated",
      companyId,
      payload: {
        agent: updated,
        changes: Object.keys(restoreConfig),
        rollbackFromRevision: revisionId,
      },
      timestamp: now.toISOString(),
    });

    res.json({ data: updated });
  });

  // =========================================================================
  // Execute agent on a task (AI provider call)
  // =========================================================================

  // POST /api/companies/:companyId/agents/:id/execute
  router.post("/:id/execute", validate(ExecuteAgentBody), async (req, res) => {
    const body = req.body as z.infer<typeof ExecuteAgentBody>;
    const { id, companyId } = routeParams(req);

    const [agent] = await db.drizzle
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.companyId, companyId)))
      .limit(1);

    if (!agent) {
      throw new AppError(404, "AGENT_NOT_FOUND", `Agent ${id} not found`);
    }

    if (agent.status === "offline") {
      throw new AppError(
        400,
        "AGENT_OFFLINE",
        `Agent ${agent.name} is offline and cannot execute tasks`,
      );
    }

    if (agent.status === "working") {
      throw new AppError(
        409,
        "AGENT_BUSY",
        `Agent ${agent.name} is already working on a task`,
      );
    }

    // Support ?mode=loop for agentic loop execution
    const mode = (req.query.mode as string) ?? "single";

    try {
      if (mode === "loop") {
        const maxIterations = req.query.maxIterations
          ? parseInt(req.query.maxIterations as string, 10)
          : undefined;
        const loop = new AgenticLoop(db, { maxIterations });
        const result = await loop.run(id, body.taskId, companyId);
        res.json({ data: result });
      } else {
        const executor = new AgentExecutor(db);
        const result = await executor.executeTask(id, body.taskId, companyId);
        res.json({ data: result });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AppError(500, "EXECUTION_FAILED", message);
    }
  });

  // =========================================================================
  // Execution endpoints
  // =========================================================================

  // GET /api/companies/:companyId/agents/:id/executions
  router.get("/:id/executions", async (req, res) => {
    const { id, companyId } = routeParams(req);

    // Verify agent exists
    const [agent] = await db.drizzle
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.companyId, companyId)))
      .limit(1);

    if (!agent) {
      throw new AppError(404, "AGENT_NOT_FOUND", `Agent ${id} not found`);
    }

    const rows = await db.drizzle
      .select()
      .from(agentExecutions)
      .where(
        and(
          eq(agentExecutions.agentId, id),
          eq(agentExecutions.companyId, companyId),
        ),
      )
      .orderBy(desc(agentExecutions.createdAt))
      .limit(50);

    res.json({ data: rows.map(serializeExecution) });
  });

  // POST /api/companies/:companyId/agents/:id/executions - start execution
  router.post(
    "/:id/executions",
    validate(CreateExecutionBody),
    async (req, res) => {
      const body = req.body as z.infer<typeof CreateExecutionBody>;
      const { id, companyId } = routeParams(req);

      const [agent] = await db.drizzle
        .select()
        .from(agents)
        .where(and(eq(agents.id, id), eq(agents.companyId, companyId)))
        .limit(1);

      if (!agent) {
        throw new AppError(404, "AGENT_NOT_FOUND", `Agent ${id} not found`);
      }

      const now = new Date();
      const execId = randomUUID();

      const [row] = await db.drizzle
        .insert(agentExecutions)
        .values({
          id: execId,
          companyId,
          agentId: id,
          taskId: body.taskId ?? null,
          status: "running",
          startedAt: now,
          modelUsed: body.modelUsed ?? agent.model,
          provider: body.provider ?? agent.provider,
          executionMode: "manual",
          lastEventAt: now,
          livenessStatus: LIVENESS_STATUS_HEALTHY,
          lastUsefulAction: LAST_USEFUL_ACTION_MANUAL_EXECUTION,
          nextActionHint: NEXT_ACTION_HINT_AWAIT_LOG,
          createdAt: now,
        })
        .returning();

      eventBus.emitEvent({
        type: "execution.started" as any,
        companyId,
        payload: {
          executionId: execId,
          agentId: id,
          taskId: body.taskId ?? null,
        },
        timestamp: now.toISOString(),
      });

      res.status(201).json({ data: row });
    },
  );

  // PATCH /api/companies/:companyId/agents/:id/executions/:execId - update execution
  router.patch(
    "/:id/executions/:execId",
    validate(UpdateExecutionBody),
    async (req, res) => {
      const body = req.body as z.infer<typeof UpdateExecutionBody>;
      const { id, companyId, execId } = routeParams(req);

      const [existing] = await db.drizzle
        .select()
        .from(agentExecutions)
        .where(
          and(
            eq(agentExecutions.id, execId),
            eq(agentExecutions.agentId, id),
            eq(agentExecutions.companyId, companyId),
          ),
        )
        .limit(1);

      if (!existing) {
        throw new AppError(
          404,
          "EXECUTION_NOT_FOUND",
          `Execution ${execId} not found`,
        );
      }

      const updates: Record<string, unknown> = {};

      if (body.status !== undefined) updates.status = body.status;
      if (body.status === "running") {
        updates.retryStatus = "none";
        updates.retryDueAt = null;
        updates.failureCategory = null;
      }
      if (body.inputTokens !== undefined)
        updates.inputTokens = body.inputTokens;
      if (body.outputTokens !== undefined)
        updates.outputTokens = body.outputTokens;
      if (body.costCents !== undefined) updates.costCents = body.costCents;
      if (body.modelUsed !== undefined) updates.modelUsed = body.modelUsed;
      if (body.provider !== undefined) updates.provider = body.provider;
      if (body.summary !== undefined) updates.summary = body.summary;
      if (body.error !== undefined) updates.error = body.error;
      if (body.livenessStatus !== undefined)
        updates.livenessStatus = body.livenessStatus;
      if (body.lastUsefulAction !== undefined)
        updates.lastUsefulAction = body.lastUsefulAction;
      if (body.nextActionHint !== undefined)
        updates.nextActionHint = body.nextActionHint;
      if (body.continuationAttempted) {
        updates.continuationAttempts = (existing.continuationAttempts ?? 0) + 1;
        updates.lastContinuationAt = new Date();
      }

      // Handle log entry append
      if (body.logEntry) {
        const currentLog = (existing.log ?? []) as Array<
          Record<string, unknown>
        >;
        const newEntry = {
          timestamp: new Date().toISOString(),
          level: body.logEntry.level,
          message: body.logEntry.message,
          ...(body.logEntry.phase && { phase: body.logEntry.phase }),
          ...(body.logEntry.iteration != null && {
            iteration: body.logEntry.iteration,
          }),
          ...(body.logEntry.content && { content: body.logEntry.content }),
          ...(body.logEntry.toolCalls && {
            toolCalls: body.logEntry.toolCalls,
          }),
        };
        updates.log = [...currentLog, newEntry];
        updates.lastEventAt = new Date(newEntry.timestamp);

        // Emit log event
        eventBus.emitEvent({
          type: "execution.log" as any,
          companyId,
          payload: {
            executionId: execId,
            agentId: id,
            entry: newEntry,
          },
          timestamp: newEntry.timestamp,
        });
      }

      // Set completedAt if status is a terminal state
      if (
        body.status &&
        ["completed", "failed", "cancelled"].includes(body.status)
      ) {
        updates.completedAt = new Date();
        updates.lastEventAt = updates.completedAt;
        if (body.status === "completed" || body.status === "cancelled") {
          updates.retryStatus = "none";
          updates.retryDueAt = null;
          updates.failureCategory = null;
        }
      }

      const [updated] = await db.drizzle
        .update(agentExecutions)
        .set(updates)
        .where(eq(agentExecutions.id, execId))
        .returning();

      // Emit completion event if done
      if (
        body.status &&
        ["completed", "failed", "cancelled"].includes(body.status)
      ) {
        eventBus.emitEvent({
          type: "execution.completed" as any,
          companyId,
          payload: {
            executionId: execId,
            agentId: id,
            status: body.status,
            summary: updated.summary,
            error: updated.error,
          },
          timestamp: new Date().toISOString(),
        });
      }

      res.json({ data: updated });
    },
  );

  return router;
}

// ---------------------------------------------------------------------------
// Org chart router (unchanged)
// ---------------------------------------------------------------------------

export function orgChartRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { agents } = db.schema;

  // GET /api/companies/:companyId/org-chart
  router.get("/", async (req, res) => {
    const companyId = routeParams(req).companyId;
    const allAgents = await db.drizzle
      .select()
      .from(agents)
      .where(eq(agents.companyId, companyId));

    // Build tree structure
    type AgentNode = (typeof allAgents)[number] & { children: AgentNode[] };
    const nodeMap = new Map<string, AgentNode>();
    const roots: AgentNode[] = [];

    for (const a of allAgents) {
      nodeMap.set(a.id, { ...a, children: [] });
    }

    for (const a of allAgents) {
      const node = nodeMap.get(a.id)!;
      if (a.reportsTo && nodeMap.has(a.reportsTo)) {
        nodeMap.get(a.reportsTo)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    res.json({ data: roots });
  });

  return router;
}
