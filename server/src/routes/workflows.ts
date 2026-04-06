import { and, eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { AppError } from "../middleware/error-handler.js";
import { validate } from "../middleware/validate.js";
import eventBus from "../realtime/events.js";
import type { DbInstance } from "../types.js";
import { routeParams } from "../utils/route-params.js";

// ---------------------------------------------------------------------------
// Workflow node types (stored as JSON in the nodes column)
// ---------------------------------------------------------------------------

export interface WorkflowNode {
  id: string;
  type: "task" | "decision" | "trigger" | "action";
  label: string;
  agentId?: string;
  taskId?: string;
  config: Record<string, unknown>;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  dependsOn: string[];
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const WorkflowNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["task", "decision", "trigger", "action"]),
  label: z.string().min(1).max(255),
  agentId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
  config: z.record(z.unknown()).default({}),
  status: z
    .enum(["pending", "running", "completed", "failed", "skipped"])
    .default("pending"),
  dependsOn: z.array(z.string()).default([]),
});

const CreateWorkflowBody = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(5000).optional(),
  status: z.enum(["draft", "active", "paused", "archived"]).default("draft"),
  nodes: z.array(WorkflowNodeSchema).default([]),
});

const UpdateWorkflowBody = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(5000).nullable().optional(),
  status: z.enum(["draft", "active", "paused", "archived"]).optional(),
  nodes: z.array(WorkflowNodeSchema).optional(),
});

const UpdateNodeBody = z.object({
  status: z.enum(["pending", "running", "completed", "failed", "skipped"]),
  config: z.record(z.unknown()).optional(),
});

export function workflowsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { workflows } = db.schema;

  // GET /api/companies/:companyId/workflows
  router.get("/", async (req, res) => {
    const { companyId } = routeParams(req);
    const rows = await db.drizzle
      .select()
      .from(workflows)
      .where(eq(workflows.companyId, companyId));
    res.json({ data: rows });
  });

  // POST /api/companies/:companyId/workflows
  router.post("/", validate(CreateWorkflowBody), async (req, res) => {
    const body = req.body as z.infer<typeof CreateWorkflowBody>;
    const { companyId } = routeParams(req);
    const now = new Date();

    const [row] = await db.drizzle
      .insert(workflows)
      .values({
        companyId,
        name: body.name,
        description: body.description ?? null,
        status: body.status,
        nodes: body.nodes as Record<string, unknown>[],
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    eventBus.emitEvent({
      type: "workflow.created",
      companyId,
      payload: { workflow: row },
      timestamp: now.toISOString(),
    });

    res.status(201).json({ data: row });
  });

  // GET /api/companies/:companyId/workflows/:id
  router.get("/:id", async (req, res) => {
    const { id, companyId } = routeParams(req);
    const [row] = await db.drizzle
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, id), eq(workflows.companyId, companyId)))
      .limit(1);

    if (!row) {
      throw new AppError(404, "WORKFLOW_NOT_FOUND", `Workflow ${id} not found`);
    }
    res.json({ data: row });
  });

  // PATCH /api/companies/:companyId/workflows/:id
  router.patch("/:id", validate(UpdateWorkflowBody), async (req, res) => {
    const body = req.body as z.infer<typeof UpdateWorkflowBody>;
    const { id, companyId } = routeParams(req);

    const [existing] = await db.drizzle
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, id), eq(workflows.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, "WORKFLOW_NOT_FOUND", `Workflow ${id} not found`);
    }

    const updateValues: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) updateValues.name = body.name;
    if (body.description !== undefined)
      updateValues.description = body.description;
    if (body.status !== undefined) updateValues.status = body.status;
    if (body.nodes !== undefined) updateValues.nodes = body.nodes;

    const [updated] = await db.drizzle
      .update(workflows)
      .set(updateValues)
      .where(eq(workflows.id, id))
      .returning();

    eventBus.emitEvent({
      type: "workflow.updated",
      companyId,
      payload: { workflow: updated, changes: Object.keys(body) },
      timestamp: new Date().toISOString(),
    });

    res.json({ data: updated });
  });

  // DELETE /api/companies/:companyId/workflows/:id
  router.delete("/:id", async (req, res) => {
    const { id, companyId } = routeParams(req);

    const [existing] = await db.drizzle
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, id), eq(workflows.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, "WORKFLOW_NOT_FOUND", `Workflow ${id} not found`);
    }

    const [archived] = await db.drizzle
      .update(workflows)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(workflows.id, id))
      .returning();

    eventBus.emitEvent({
      type: "workflow.deleted",
      companyId,
      payload: { workflowId: id },
      timestamp: new Date().toISOString(),
    });

    res.json({ data: archived });
  });

  // POST /api/companies/:companyId/workflows/:id/execute
  router.post("/:id/execute", async (req, res) => {
    const { id, companyId } = routeParams(req);

    const [wf] = await db.drizzle
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, id), eq(workflows.companyId, companyId)))
      .limit(1);

    if (!wf) {
      throw new AppError(404, "WORKFLOW_NOT_FOUND", `Workflow ${id} not found`);
    }

    if (wf.status === "active") {
      throw new AppError(
        409,
        "WORKFLOW_ALREADY_ACTIVE",
        "Workflow is already active",
      );
    }

    const now = new Date();
    const nodes = (wf.nodes as unknown as WorkflowNode[]).map((node) => {
      if (node.dependsOn.length === 0) {
        return { ...node, status: "running" as const };
      }
      return { ...node, status: "pending" as const };
    });

    const [updated] = await db.drizzle
      .update(workflows)
      .set({
        status: "active",
        nodes: nodes as unknown as Record<string, unknown>[],
        updatedAt: now,
      })
      .where(eq(workflows.id, id))
      .returning();

    eventBus.emitEvent({
      type: "workflow.started",
      companyId,
      payload: { workflow: updated },
      timestamp: now.toISOString(),
    });

    res.json({ data: updated });
  });

  // PATCH /api/companies/:companyId/workflows/:id/nodes/:nodeId
  router.patch(
    "/:id/nodes/:nodeId",
    validate(UpdateNodeBody),
    async (req, res) => {
      const body = req.body as z.infer<typeof UpdateNodeBody>;
      const { id, nodeId, companyId } = routeParams(req);

      const [wf] = await db.drizzle
        .select()
        .from(workflows)
        .where(and(eq(workflows.id, id), eq(workflows.companyId, companyId)))
        .limit(1);

      if (!wf) {
        throw new AppError(
          404,
          "WORKFLOW_NOT_FOUND",
          `Workflow ${id} not found`,
        );
      }

      const nodes = wf.nodes as unknown as WorkflowNode[];
      const nodeIndex = nodes.findIndex((n) => n.id === nodeId);
      if (nodeIndex === -1) {
        throw new AppError(
          404,
          "NODE_NOT_FOUND",
          `Node ${nodeId} not found in workflow`,
        );
      }

      nodes[nodeIndex] = {
        ...nodes[nodeIndex],
        status: body.status,
        ...(body.config && {
          config: { ...nodes[nodeIndex].config, ...body.config },
        }),
      };

      // If a node completed, advance downstream nodes whose dependencies are satisfied
      if (body.status === "completed") {
        for (const node of nodes) {
          if (
            node.status === "pending" &&
            node.dependsOn.length > 0 &&
            node.dependsOn.every((depId) => {
              const dep = nodes.find((n) => n.id === depId);
              return dep?.status === "completed";
            })
          ) {
            node.status = "running";
          }
        }
      }

      // Check if entire workflow is done
      const allDone = nodes.every(
        (n) => n.status === "completed" || n.status === "skipped",
      );

      const updateValues: Record<string, unknown> = {
        nodes: nodes as unknown as Record<string, unknown>[],
        updatedAt: new Date(),
      };
      if (allDone) {
        updateValues.status = "archived"; // completed workflows go to archived
      }

      const [updated] = await db.drizzle
        .update(workflows)
        .set(updateValues)
        .where(eq(workflows.id, id))
        .returning();

      eventBus.emitEvent({
        type: "workflow.node_updated",
        companyId,
        payload: { workflowId: id, nodeId, status: body.status },
        timestamp: new Date().toISOString(),
      });

      res.json({ data: updated });
    },
  );

  return router;
}
