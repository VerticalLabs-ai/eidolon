import { and, eq, sql } from "drizzle-orm";
import { Router } from "express";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AppError } from "../middleware/error-handler.js";
import { validate } from "../middleware/validate.js";
import eventBus from "../realtime/events.js";
import type { DbInstance } from "../types.js";
import logger from "../utils/logger.js";
import { routeParams } from "../utils/route-params.js";

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const CreateWebhookBody = z.object({
  name: z.string().min(1).max(255),
  eventType: z
    .enum(["task.create", "agent.wake", "message.send"])
    .default("task.create"),
  targetAgentId: z.string().uuid().optional(),
});

const PatchWebhookBody = z.object({
  enabled: z.boolean(),
});

const TriggerPayload = z.object({
  // task.create fields
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  type: z.string().max(100).optional(),
  assigneeAgentId: z.string().uuid().optional(),

  // message.send fields
  content: z.string().max(10000).optional(),
  fromAgentId: z.string().uuid().optional(),
  toAgentId: z.string().uuid().optional(),

  // Generic metadata passthrough
  metadata: z.record(z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

function maskSecret(secret: string): string {
  return "****" + secret.slice(-4);
}

/**
 * Constant-time comparison of two secret strings.
 * Returns true when both are identical; false otherwise.
 */
function secretsMatch(provided: string, stored: string): boolean {
  const a = Buffer.from(provided, "utf-8");
  const b = Buffer.from(stored, "utf-8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Management router (authenticated, scoped to company)
// ---------------------------------------------------------------------------

export function webhookManagementRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { webhooks } = db.schema;

  // GET / - list webhooks (hide secret, show last 4 chars)
  router.get("/", async (req, res) => {
    const rows = await db.drizzle
      .select()
      .from(webhooks)
      .where(eq(webhooks.companyId, routeParams(req).companyId));

    const sanitized = rows.map((row) => ({
      ...row,
      secret: maskSecret(row.secret),
    }));

    res.json({ data: sanitized });
  });

  // POST / - create webhook (auto-generate secret)
  router.post("/", validate(CreateWebhookBody), async (req, res) => {
    const body = req.body as z.infer<typeof CreateWebhookBody>;
    const companyId = routeParams(req).companyId;
    const now = new Date();
    const id = randomUUID();
    const secret = generateSecret();

    // If a target agent is specified, verify it belongs to the same company
    if (body.targetAgentId) {
      const { agents } = db.schema;
      const [agent] = await db.drizzle
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.id, body.targetAgentId),
            eq(agents.companyId, companyId),
          ),
        )
        .limit(1);

      if (!agent) {
        throw new AppError(
          404,
          "AGENT_NOT_FOUND",
          `Agent ${body.targetAgentId} not found in this company`,
        );
      }
    }

    const [row] = await db.drizzle
      .insert(webhooks)
      .values({
        id,
        companyId,
        name: body.name,
        secret,
        targetAgentId: body.targetAgentId ?? null,
        eventType: body.eventType,
        enabled: true,
        triggerCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    eventBus.emitEvent({
      type: "activity.logged",
      companyId,
      payload: {
        action: "webhook.created",
        entityType: "webhook",
        entityId: id,
        name: body.name,
      },
      timestamp: now.toISOString(),
    });

    // Return the full secret only on creation -- this is the only time it is visible
    res.status(201).json({
      data: {
        ...row,
        secret, // plaintext, shown once
      },
    });
  });

  // PATCH /:id - enable/disable
  router.patch("/:id", validate(PatchWebhookBody), async (req, res) => {
    const body = req.body as z.infer<typeof PatchWebhookBody>;
    const { id, companyId } = routeParams(req);

    const [existing] = await db.drizzle
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.id, id), eq(webhooks.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, "WEBHOOK_NOT_FOUND", `Webhook ${id} not found`);
    }

    const now = new Date();
    const [updated] = await db.drizzle
      .update(webhooks)
      .set({ enabled: body.enabled, updatedAt: now })
      .where(eq(webhooks.id, id))
      .returning();

    eventBus.emitEvent({
      type: "activity.logged",
      companyId,
      payload: {
        action: body.enabled ? "webhook.enabled" : "webhook.disabled",
        entityType: "webhook",
        entityId: id,
        name: existing.name,
      },
      timestamp: now.toISOString(),
    });

    res.json({
      data: {
        ...updated,
        secret: maskSecret(updated.secret),
      },
    });
  });

  // DELETE /:id - delete webhook
  router.delete("/:id", async (req, res) => {
    const { id, companyId } = routeParams(req);

    const [existing] = await db.drizzle
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.id, id), eq(webhooks.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, "WEBHOOK_NOT_FOUND", `Webhook ${id} not found`);
    }

    await db.drizzle.delete(webhooks).where(eq(webhooks.id, id));

    eventBus.emitEvent({
      type: "activity.logged",
      companyId,
      payload: {
        action: "webhook.deleted",
        entityType: "webhook",
        entityId: id,
        name: existing.name,
      },
      timestamp: new Date().toISOString(),
    });

    res.json({ data: { id, deleted: true } });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Inbound trigger router (public, validated via webhook secret)
// ---------------------------------------------------------------------------

export function webhookTriggerRouter(db: DbInstance): Router {
  const router = Router();
  const { webhooks, tasks, messages, agents } = db.schema;

  // POST /:webhookId/trigger - receive external event
  router.post("/:webhookId/trigger", async (req, res) => {
    const { webhookId } = routeParams(req);

    // Look up the webhook
    const [webhook] = await db.drizzle
      .select()
      .from(webhooks)
      .where(eq(webhooks.id, webhookId))
      .limit(1);

    if (!webhook) {
      throw new AppError(404, "WEBHOOK_NOT_FOUND", "Webhook not found");
    }

    if (!webhook.enabled) {
      throw new AppError(
        403,
        "WEBHOOK_DISABLED",
        "This webhook is currently disabled",
      );
    }

    // Validate the secret via header or query param
    const providedSecret =
      (req.headers["x-webhook-secret"] as string | undefined) ??
      (req.query.secret as string | undefined);

    if (!providedSecret) {
      throw new AppError(
        401,
        "MISSING_SECRET",
        "Webhook secret must be provided via X-Webhook-Secret header or ?secret= query parameter",
      );
    }

    if (!secretsMatch(providedSecret, webhook.secret)) {
      throw new AppError(401, "INVALID_SECRET", "Invalid webhook secret");
    }

    // Parse the payload
    const parseResult = TriggerPayload.safeParse(req.body);
    if (!parseResult.success) {
      throw new AppError(
        400,
        "INVALID_PAYLOAD",
        "Invalid webhook payload",
        parseResult.error.errors,
      );
    }
    const payload = parseResult.data;

    const now = new Date();
    const companyId = webhook.companyId;
    let result: Record<string, unknown> = {};

    // Dispatch based on event type
    switch (webhook.eventType) {
      case "task.create": {
        if (!payload.title) {
          throw new AppError(
            400,
            "MISSING_FIELD",
            'Field "title" is required for task.create',
          );
        }

        const assignee =
          payload.assigneeAgentId ?? webhook.targetAgentId ?? null;

        const taskPriority =
          payload.priority === "urgent"
            ? "high"
            : ((payload.priority ?? "medium") as
                | "critical"
                | "high"
                | "medium"
                | "low");

        const [task] = await db.drizzle
          .insert(tasks)
          .values({
            companyId,
            title: payload.title,
            description: payload.description ?? null,
            type: (payload.type ?? "feature") as
              | "feature"
              | "bug"
              | "chore"
              | "spike"
              | "epic",
            status: "backlog",
            priority: taskPriority,
            assigneeAgentId: assignee,
            createdByUserId: `webhook:${webhook.id}`,
            dependencies: [],
            tags: [],
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        eventBus.emitEvent({
          type: "task.created",
          companyId,
          payload: {
            taskId: task.id,
            title: payload.title,
            source: "webhook",
            webhookId: webhook.id,
          },
          timestamp: now.toISOString(),
        });

        result = { action: "task.created", taskId: task.id };
        break;
      }

      case "agent.wake": {
        const agentId = webhook.targetAgentId;
        if (!agentId) {
          throw new AppError(
            400,
            "NO_TARGET_AGENT",
            "This webhook has no target agent configured for agent.wake",
          );
        }

        // Verify agent exists
        const [agent] = await db.drizzle
          .select({ id: agents.id, companyId: agents.companyId })
          .from(agents)
          .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
          .limit(1);

        if (!agent) {
          throw new AppError(
            404,
            "AGENT_NOT_FOUND",
            `Target agent ${agentId} not found`,
          );
        }

        // Update agent status to indicate a wake / heartbeat
        await db.drizzle
          .update(agents)
          .set({ lastHeartbeatAt: now, status: "working", updatedAt: now })
          .where(eq(agents.id, agentId));

        eventBus.emitEvent({
          type: "agent.heartbeat",
          companyId,
          payload: { agentId, source: "webhook", webhookId: webhook.id },
          timestamp: now.toISOString(),
        });

        result = { action: "agent.wake", agentId };
        break;
      }

      case "message.send": {
        if (!payload.content) {
          throw new AppError(
            400,
            "MISSING_FIELD",
            'Field "content" is required for message.send',
          );
        }

        const toAgentId = payload.toAgentId ?? webhook.targetAgentId;
        if (!toAgentId) {
          throw new AppError(
            400,
            "MISSING_FIELD",
            'Field "toAgentId" or a configured target agent is required for message.send',
          );
        }

        const fromAgentId = payload.fromAgentId ?? `webhook:${webhook.id}`;
        const threadId = randomUUID();

        const [message] = await db.drizzle
          .insert(messages)
          .values({
            companyId,
            fromAgentId,
            toAgentId,
            threadId,
            content: payload.content,
            type: "response",
            metadata: (payload.metadata ?? {}) as Record<string, unknown>,
            createdAt: now,
          })
          .returning();

        eventBus.emitEvent({
          type: "message.sent",
          companyId,
          payload: {
            messageId: message.id,
            fromAgentId,
            toAgentId,
            source: "webhook",
            webhookId: webhook.id,
          },
          timestamp: now.toISOString(),
        });

        result = { action: "message.sent", messageId: message.id };
        break;
      }

      default: {
        throw new AppError(
          400,
          "UNKNOWN_EVENT_TYPE",
          `Unsupported event type: ${webhook.eventType}`,
        );
      }
    }

    // Record the trigger: increment count and update last_triggered_at
    await db.drizzle
      .update(webhooks)
      .set({
        triggerCount: sql`${webhooks.triggerCount} + 1`,
        lastTriggeredAt: now,
        updatedAt: now,
      })
      .where(eq(webhooks.id, webhookId));

    logger.info(
      { webhookId, eventType: webhook.eventType, companyId },
      "Webhook triggered successfully",
    );

    res.json({ data: { triggered: true, ...result } });
  });

  return router;
}
