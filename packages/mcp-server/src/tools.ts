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
