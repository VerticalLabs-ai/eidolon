import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EidolonClient } from "./client.js";
import type { EidolonMcpConfig } from "./config.js";
import { requireCompanyId } from "./config.js";

/**
 * Register all Eidolon MCP tools against an existing McpServer. Split from
 * src/index.ts so the tool list is easy to diff and extend without touching
 * transport or lifecycle code.
 */
export function registerEidolonTools(
  server: McpServer,
  client: EidolonClient,
  config: EidolonMcpConfig,
): void {
  const companyIdArg = z
    .string()
    .uuid()
    .optional()
    .describe(
      "Eidolon company id. Defaults to EIDOLON_COMPANY_ID from the server env.",
    );

  const asJsonContent = (value: unknown) => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  });

  // -----------------------------------------------------------------------
  // READ TOOLS
  // -----------------------------------------------------------------------

  server.registerTool(
    "eidolon_list_companies",
    {
      title: "List companies",
      description:
        "List every company the session can see. Useful as a first step when EIDOLON_COMPANY_ID is not preset.",
    },
    async () => asJsonContent(await client.listCompanies()),
  );

  server.registerTool(
    "eidolon_get_company",
    {
      title: "Get company",
      description: "Fetch a single company by id, including budget and settings.",
      inputSchema: { companyId: companyIdArg },
    },
    async ({ companyId }) =>
      asJsonContent(await client.getCompany(requireCompanyId(config, companyId))),
  );

  server.registerTool(
    "eidolon_list_agents",
    {
      title: "List agents",
      description: "List every agent in a company along with provider, model, status, and budget.",
      inputSchema: { companyId: companyIdArg },
    },
    async ({ companyId }) =>
      asJsonContent(await client.listAgents(requireCompanyId(config, companyId))),
  );

  server.registerTool(
    "eidolon_get_agent",
    {
      title: "Get agent",
      description: "Fetch an agent's full config (model, instructions, capabilities, budget, status).",
      inputSchema: {
        agentId: z.string().uuid(),
        companyId: companyIdArg,
      },
    },
    async ({ companyId, agentId }) =>
      asJsonContent(
        await client.getAgent(requireCompanyId(config, companyId), agentId),
      ),
  );

  server.registerTool(
    "eidolon_list_executions",
    {
      title: "List executions",
      description:
        "Return the agent's recent execution history (up to 50), including status, tokens, cost, summary, and structured transcript log entries.",
      inputSchema: {
        agentId: z.string().uuid(),
        companyId: companyIdArg,
      },
    },
    async ({ companyId, agentId }) =>
      asJsonContent(
        await client.listExecutions(requireCompanyId(config, companyId), agentId),
      ),
  );

  server.registerTool(
    "eidolon_list_tasks",
    {
      title: "List tasks",
      description:
        "List tasks in a company. Optionally filter by status, priority, or assignee.",
      inputSchema: {
        companyId: companyIdArg,
        status: z
          .enum([
            "backlog",
            "todo",
            "in_progress",
            "review",
            "done",
            "cancelled",
            "timed_out",
          ])
          .optional(),
        priority: z.enum(["critical", "high", "medium", "low"]).optional(),
        assigneeAgentId: z.string().uuid().optional(),
      },
    },
    async ({ companyId, status, priority, assigneeAgentId }) =>
      asJsonContent(
        await client.listTasks(requireCompanyId(config, companyId), {
          status,
          priority,
          assigneeAgentId,
        }),
      ),
  );

  server.registerTool(
    "eidolon_get_task",
    {
      title: "Get task",
      description: "Fetch a single task by id with its full metadata and assignee.",
      inputSchema: {
        taskId: z.string().uuid(),
        companyId: companyIdArg,
      },
    },
    async ({ companyId, taskId }) =>
      asJsonContent(
        await client.getTask(requireCompanyId(config, companyId), taskId),
      ),
  );

  server.registerTool(
    "eidolon_list_goals",
    {
      title: "List goals",
      description: "Return the company's goal tree (mission / objective / key result / initiative).",
      inputSchema: { companyId: companyIdArg },
    },
    async ({ companyId }) =>
      asJsonContent(await client.listGoals(requireCompanyId(config, companyId))),
  );

  server.registerTool(
    "eidolon_get_goal",
    {
      title: "Get goal",
      description: "Fetch a single goal by id, including progress and parent linkage.",
      inputSchema: {
        goalId: z.string().uuid(),
        companyId: companyIdArg,
      },
    },
    async ({ companyId, goalId }) =>
      asJsonContent(
        await client.getGoal(requireCompanyId(config, companyId), goalId),
      ),
  );

  server.registerTool(
    "eidolon_list_approvals",
    {
      title: "List approvals",
      description: "List approvals, optionally filtered by status.",
      inputSchema: {
        companyId: companyIdArg,
        status: z
          .enum(["pending", "approved", "rejected", "cancelled"])
          .optional(),
      },
    },
    async ({ companyId, status }) =>
      asJsonContent(
        await client.listApprovals(requireCompanyId(config, companyId), status),
      ),
  );

  server.registerTool(
    "eidolon_get_approval",
    {
      title: "Get approval",
      description: "Fetch an approval with its comment thread.",
      inputSchema: {
        approvalId: z.string().uuid(),
        companyId: companyIdArg,
      },
    },
    async ({ companyId, approvalId }) =>
      asJsonContent(
        await client.getApproval(requireCompanyId(config, companyId), approvalId),
      ),
  );

  server.registerTool(
    "eidolon_list_adapters",
    {
      title: "List adapters",
      description:
        "Return the set of registered agent runtimes with capability flags (streaming, tools, vision, reasoning, etc.) and supported models.",
    },
    async () => asJsonContent(await client.listAdapters()),
  );

  server.registerTool(
    "eidolon_list_runtime_adapters",
    {
      title: "List runtime adapters",
      description:
        "Return provider, process, HTTP, MCP, and OpenJarvis-local runtime descriptors with Jarvis capability flags.",
    },
    async () => asJsonContent(await client.listRuntimeAdapters()),
  );

  // -----------------------------------------------------------------------
  // WRITE TOOLS
  // -----------------------------------------------------------------------

  server.registerTool(
    "eidolon_create_task",
    {
      title: "Create task",
      description:
        "Create a new task in a company. Returns the created task with its generated id and task_number.",
      inputSchema: {
        companyId: companyIdArg,
        title: z.string().min(1).max(500),
        description: z.string().max(10_000).optional(),
        type: z.enum(["feature", "bug", "chore", "spike", "epic"]).optional(),
        priority: z.enum(["critical", "high", "medium", "low"]).optional(),
        projectId: z.string().uuid().optional(),
        parentId: z.string().uuid().optional(),
        assigneeAgentId: z.string().uuid().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ companyId, ...body }) =>
      asJsonContent(
        await client.createTask(requireCompanyId(config, companyId), body),
      ),
    );

  server.registerTool(
    "eidolon_update_task",
    {
      title: "Update task",
      description:
        "Patch a task. Pass only the fields you want to change (title, description, status, priority, assigneeAgentId, tags, etc.).",
      inputSchema: {
        taskId: z.string().uuid(),
        companyId: companyIdArg,
        updates: z
          .record(z.unknown())
          .describe("Object of fields to change on the task."),
      },
    },
    async ({ companyId, taskId, updates }) =>
      asJsonContent(
        await client.updateTask(
          requireCompanyId(config, companyId),
          taskId,
          updates,
        ),
      ),
  );

  server.registerTool(
    "eidolon_assign_task",
    {
      title: "Assign task",
      description: "Assign a task to a specific agent. Moves task.status to in_progress.",
      inputSchema: {
        taskId: z.string().uuid(),
        agentId: z.string().uuid(),
        companyId: companyIdArg,
      },
    },
    async ({ companyId, taskId, agentId }) =>
      asJsonContent(
        await client.assignTask(
          requireCompanyId(config, companyId),
          taskId,
          agentId,
        ),
      ),
  );

  server.registerTool(
    "eidolon_wake_agent",
    {
      title: "Wake agent",
      description:
        "Trigger an agent heartbeat immediately so it can claim eligible work.",
      inputSchema: {
        agentId: z.string().uuid(),
        companyId: companyIdArg,
      },
    },
    async ({ companyId, agentId }) =>
      asJsonContent(
        await client.wakeAgent(requireCompanyId(config, companyId), agentId),
      ),
  );

  server.registerTool(
    "eidolon_create_runtime_session",
    {
      title: "Create runtime session",
      description:
        "Create a durable Jarvis runtime session for an agent, optionally binding a task, execution, environment, adapter, and resume state.",
      inputSchema: {
        companyId: companyIdArg,
        agentId: z.string().uuid(),
        taskId: z.string().uuid().optional(),
        executionId: z.string().uuid().optional(),
        environmentId: z.string().uuid().optional(),
        adapterId: z.string().max(255).optional(),
        adapterConfig: z.record(z.unknown()).optional(),
        mode: z.enum(["on_demand", "scheduled", "continuous", "manual", "recovery"]).optional(),
        resumeState: z.record(z.unknown()).optional(),
        finalizeRequired: z.boolean().optional(),
      },
    },
    async ({ companyId, ...body }) =>
      asJsonContent(
        await client.createSession(requireCompanyId(config, companyId), body),
      ),
  );

  server.registerTool(
    "eidolon_cancel_runtime_session",
    {
      title: "Cancel runtime session",
      description: "Cancel a durable runtime session and record the operator reason.",
      inputSchema: {
        companyId: companyIdArg,
        sessionId: z.string().uuid(),
        reason: z.string().max(2000).optional(),
      },
    },
    async ({ companyId, sessionId, reason }) =>
      asJsonContent(
        await client.cancelSession(
          requireCompanyId(config, companyId),
          sessionId,
          reason,
        ),
      ),
  );

  server.registerTool(
    "eidolon_finalize_runtime_session",
    {
      title: "Finalize runtime session",
      description:
        "Finalize a durable runtime session and release its leased workspace when owned by that session.",
      inputSchema: {
        companyId: companyIdArg,
        sessionId: z.string().uuid(),
      },
    },
    async ({ companyId, sessionId }) =>
      asJsonContent(
        await client.finalizeSession(
          requireCompanyId(config, companyId),
          sessionId,
        ),
      ),
  );

  server.registerTool(
    "eidolon_install_skill",
    {
      title: "Install skill",
      description:
        "Install or update a company skill using the agentskills-style shape, optionally assigning it to agents.",
      inputSchema: {
        companyId: companyIdArg,
        name: z.string().min(1).max(255),
        version: z.string().min(1).max(100).optional(),
        source: z.string().min(1).max(2000).optional(),
        provenance: z.enum(["bundled", "catalog", "runtime", "adapter", "github", "manual"]).optional(),
        trustLevel: z.enum(["markdown_only", "assets", "scripts_executables"]).optional(),
        entrypoint: z.string().max(1000).optional(),
        content: z.string().min(1).max(200_000),
        metadata: z.record(z.unknown()).optional(),
        tags: z.array(z.string()).optional(),
        agentIds: z.array(z.string().uuid()).optional(),
      },
    },
    async ({ companyId, ...body }) =>
      asJsonContent(
        await client.installSkill(requireCompanyId(config, companyId), body),
      ),
  );

  server.registerTool(
    "eidolon_audit_skills",
    {
      title: "Audit skills",
      description:
        "Audit the company skills catalog for assignments, sync status, executable trust, missing entrypoints, and agent catalog mismatches.",
      inputSchema: {
        companyId: companyIdArg,
      },
    },
    async ({ companyId }) =>
      asJsonContent(
        await client.auditSkills(requireCompanyId(config, companyId)),
      ),
  );

  server.registerTool(
    "eidolon_export_skill",
    {
      title: "Export skill",
      description:
        "Export one company skill in an agentskills.io-compatible shape with content, metadata, and current assignments.",
      inputSchema: {
        companyId: companyIdArg,
        skillId: z.string().uuid(),
      },
    },
    async ({ companyId, skillId }) =>
      asJsonContent(
        await client.exportSkill(requireCompanyId(config, companyId), skillId),
      ),
  );

  server.registerTool(
    "eidolon_reset_skill_sync",
    {
      title: "Reset skill sync",
      description:
        "Reset one skill's materialized assignments back to pending so local adapter homes can resync or recover.",
      inputSchema: {
        companyId: companyIdArg,
        skillId: z.string().uuid(),
        agentIds: z.array(z.string().uuid()).min(1).optional(),
        reason: z.string().max(1000).optional(),
      },
    },
    async ({ companyId, skillId, agentIds, reason }) =>
      asJsonContent(
        await client.resetSkill(requireCompanyId(config, companyId), skillId, {
          agentIds,
          reason,
        }),
      ),
  );

  server.registerTool(
    "eidolon_create_routine",
    {
      title: "Create routine",
      description:
        "Create a scheduled, continuous, or on-demand Jarvis routine such as daily briefing, monitoring, research, or follow-up.",
      inputSchema: {
        companyId: companyIdArg,
        agentId: z.string().uuid().optional(),
        name: z.string().min(1).max(255),
        mode: z.enum(["scheduled", "continuous", "on_demand"]).optional(),
        jarvisMode: z.enum(["daily_briefing", "monitoring", "research", "follow_up", "custom"]).optional(),
        schedule: z.string().max(255).optional(),
        prompt: z.string().min(1).max(100_000),
        enabled: z.boolean().optional(),
        variables: z.record(z.unknown()).optional(),
        workspacePolicy: z.record(z.unknown()).optional(),
      },
    },
    async ({ companyId, ...body }) =>
      asJsonContent(
        await client.createRoutine(requireCompanyId(config, companyId), body),
      ),
  );

  server.registerTool(
    "eidolon_create_approval",
    {
      title: "Create approval",
      description:
        "Open a governance approval request (budget change, agent termination, task review, or custom).",
      inputSchema: {
        companyId: companyIdArg,
        title: z.string().min(1).max(500),
        description: z.string().max(10_000).optional(),
        kind: z
          .enum(["budget_change", "agent_termination", "task_review", "custom"])
          .optional(),
        priority: z.enum(["critical", "high", "medium", "low"]).optional(),
        payload: z.record(z.unknown()).optional(),
        taskId: z.string().uuid().optional(),
        requestedByAgentId: z.string().uuid().optional(),
      },
    },
    async ({ companyId, ...body }) =>
      asJsonContent(
        await client.createApproval(requireCompanyId(config, companyId), body),
      ),
  );

  server.registerTool(
    "eidolon_decide_approval",
    {
      title: "Decide approval",
      description:
        "Resolve a pending approval with an approve or reject decision and optional resolution note.",
      inputSchema: {
        approvalId: z.string().uuid(),
        decision: z.enum(["approved", "rejected"]),
        resolutionNote: z.string().max(10_000).optional(),
        companyId: companyIdArg,
      },
    },
    async ({ companyId, approvalId, decision, resolutionNote }) =>
      asJsonContent(
        await client.decideApproval(
          requireCompanyId(config, companyId),
          approvalId,
          decision,
          resolutionNote,
        ),
      ),
  );

  server.registerTool(
    "eidolon_add_approval_comment",
    {
      title: "Add approval comment",
      description: "Append a comment to an approval's thread.",
      inputSchema: {
        approvalId: z.string().uuid(),
        content: z.string().min(1).max(10_000),
        companyId: companyIdArg,
      },
    },
    async ({ companyId, approvalId, content }) =>
      asJsonContent(
        await client.addApprovalComment(
          requireCompanyId(config, companyId),
          approvalId,
          content,
        ),
      ),
  );

  // -----------------------------------------------------------------------
  // ESCAPE HATCH — arbitrary API call
  // -----------------------------------------------------------------------

  server.registerTool(
    "eidolon_api_request",
    {
      title: "Eidolon API request (escape hatch)",
      description:
        "Call any /api path directly when no dedicated tool exists. Use sparingly — prefer the typed tools above.",
      inputSchema: {
        path: z
          .string()
          .regex(/^\/api\//, 'path must start with "/api/"')
          .describe('Full API path, e.g. "/api/companies/:id/analytics"'),
        method: z
          .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
          .default("GET"),
        body: z.record(z.unknown()).optional(),
        query: z.record(z.string()).optional(),
      },
    },
    async ({ path, method, body, query }) =>
      asJsonContent(
        await client.request(path, {
          method,
          body,
          query: query as Record<string, string> | undefined,
        }),
      ),
  );
}
