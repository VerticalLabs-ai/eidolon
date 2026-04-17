import type { EidolonMcpConfig } from "./config.js";

type FetchFn = (input: string, init?: Parameters<typeof fetch>[1]) => Promise<Response>;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Override the companyId-scoped headers on a per-call basis. */
  headers?: Record<string, string>;
}

export class EidolonApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "EidolonApiError";
  }
}

/**
 * Thin typed REST client shared by every MCP tool. Keeps auth headers, JSON
 * parsing, and error shaping in one place so the tool callbacks stay tiny.
 */
export class EidolonClient {
  constructor(
    private readonly config: EidolonMcpConfig,
    private readonly fetchImpl: FetchFn = fetch,
  ) {}

  async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    if (!path.startsWith("/")) {
      throw new Error(`EidolonClient path must start with "/" — got "${path}"`);
    }

    const url = new URL(`${this.config.apiUrl}${path}`);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      ...(this.config.agentId ? { "X-Eidolon-Agent-Id": this.config.agentId } : {}),
      ...(this.config.runId ? { "X-Eidolon-Run-Id": this.config.runId } : {}),
      ...opts.headers,
    };

    const res = await this.fetchImpl(url.toString(), {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    const text = await res.text();
    const parsed = text.length > 0 ? safeJsonParse(text) : undefined;

    if (!res.ok) {
      const code = typeof parsed === "object" && parsed !== null && "code" in parsed
        ? String((parsed as { code: unknown }).code)
        : `HTTP_${res.status}`;
      const message = typeof parsed === "object" && parsed !== null && "message" in parsed
        ? String((parsed as { message: unknown }).message)
        : `Request failed: ${res.status} ${res.statusText}`;
      throw new EidolonApiError(res.status, code, message, parsed);
    }

    // Server wraps JSON responses in { data: ... }; unwrap when present so the
    // MCP tool callers see the payload directly.
    if (
      parsed &&
      typeof parsed === "object" &&
      "data" in parsed &&
      Object.keys(parsed).length === 1
    ) {
      return (parsed as { data: T }).data;
    }

    return parsed as T;
  }

  // -------------------------------------------------------------------------
  // Companies
  // -------------------------------------------------------------------------

  listCompanies() {
    return this.request<Array<Record<string, unknown>>>("/api/companies");
  }

  getCompany(companyId: string) {
    return this.request<Record<string, unknown>>(`/api/companies/${companyId}`);
  }

  // -------------------------------------------------------------------------
  // Agents
  // -------------------------------------------------------------------------

  listAgents(companyId: string) {
    return this.request<Array<Record<string, unknown>>>(
      `/api/companies/${companyId}/agents`,
    );
  }

  getAgent(companyId: string, agentId: string) {
    return this.request<Record<string, unknown>>(
      `/api/companies/${companyId}/agents/${agentId}`,
    );
  }

  listExecutions(companyId: string, agentId: string) {
    return this.request<Array<Record<string, unknown>>>(
      `/api/companies/${companyId}/agents/${agentId}/executions`,
    );
  }

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------

  listTasks(
    companyId: string,
    query?: { status?: string; priority?: string; assigneeAgentId?: string },
  ) {
    return this.request<Array<Record<string, unknown>>>(
      `/api/companies/${companyId}/tasks`,
      { query },
    );
  }

  getTask(companyId: string, taskId: string) {
    return this.request<Record<string, unknown>>(
      `/api/companies/${companyId}/tasks/${taskId}`,
    );
  }

  createTask(
    companyId: string,
    body: {
      title: string;
      description?: string;
      type?: string;
      priority?: string;
      projectId?: string;
      parentId?: string;
      assigneeAgentId?: string;
      tags?: string[];
    },
  ) {
    return this.request<Record<string, unknown>>(
      `/api/companies/${companyId}/tasks`,
      { method: "POST", body },
    );
  }

  updateTask(
    companyId: string,
    taskId: string,
    body: Record<string, unknown>,
  ) {
    return this.request<Record<string, unknown>>(
      `/api/companies/${companyId}/tasks/${taskId}`,
      { method: "PATCH", body },
    );
  }

  assignTask(companyId: string, taskId: string, agentId: string) {
    return this.request<Record<string, unknown>>(
      `/api/companies/${companyId}/tasks/${taskId}/assign`,
      { method: "POST", body: { agentId } },
    );
  }

  // -------------------------------------------------------------------------
  // Goals
  // -------------------------------------------------------------------------

  listGoals(companyId: string) {
    return this.request<Array<Record<string, unknown>>>(
      `/api/companies/${companyId}/goals`,
    );
  }

  getGoal(companyId: string, goalId: string) {
    return this.request<Record<string, unknown>>(
      `/api/companies/${companyId}/goals/${goalId}`,
    );
  }

  // -------------------------------------------------------------------------
  // Approvals
  // -------------------------------------------------------------------------

  listApprovals(companyId: string, status?: string) {
    return this.request<Array<Record<string, unknown>>>(
      `/api/companies/${companyId}/approvals`,
      { query: { status } },
    );
  }

  getApproval(companyId: string, id: string) {
    return this.request<{
      approval: Record<string, unknown>;
      comments: Array<Record<string, unknown>>;
    }>(`/api/companies/${companyId}/approvals/${id}`);
  }

  createApproval(
    companyId: string,
    body: {
      title: string;
      description?: string;
      kind?: "budget_change" | "agent_termination" | "task_review" | "custom";
      priority?: "critical" | "high" | "medium" | "low";
      payload?: Record<string, unknown>;
      taskId?: string;
      requestedByAgentId?: string;
    },
  ) {
    return this.request<Record<string, unknown>>(
      `/api/companies/${companyId}/approvals`,
      { method: "POST", body },
    );
  }

  decideApproval(
    companyId: string,
    id: string,
    decision: "approved" | "rejected",
    resolutionNote?: string,
  ) {
    return this.request<Record<string, unknown>>(
      `/api/companies/${companyId}/approvals/${id}/decide`,
      { method: "POST", body: { decision, resolutionNote } },
    );
  }

  addApprovalComment(companyId: string, id: string, content: string) {
    return this.request<Record<string, unknown>>(
      `/api/companies/${companyId}/approvals/${id}/comments`,
      { method: "POST", body: { content } },
    );
  }

  // -------------------------------------------------------------------------
  // Adapters (used by the listAdapters tool)
  // -------------------------------------------------------------------------

  listAdapters() {
    return this.request<Array<Record<string, unknown>>>("/api/adapters");
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
