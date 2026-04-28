// Eidolon API Client
const API_BASE = "/api";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
    ...options,
  });

  // Redirect to login on 401
  if (res.status === 401 && !path.startsWith("/auth/")) {
    window.location.href = "/login";
    throw new ApiError(401, "Session expired");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(
      res.status,
      body?.message || body?.error || `Request failed: ${res.statusText}`,
      body,
    );
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

// ── Types (match server response shapes) ─────────────────────────────────

export interface Company {
  id: string;
  name: string;
  description: string | null;
  mission: string | null;
  status: "active" | "paused" | "archived";
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  settings: Record<string, unknown>;
  brandColor: string | null;
  logoUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Agent {
  id: string;
  companyId: string;
  name: string;
  role: string;
  title: string | null;
  provider: string;
  model: string;
  status: string;
  reportsTo: string | null;
  capabilities: string[];
  systemPrompt: string | null;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  lastHeartbeatAt: string | null;
  apiKeyEncrypted?: string | null;
  apiKeyProvider?: string | null;
  apiKeySet?: boolean;
  instructions?: string | null;
  instructionsFormat?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
  toolsEnabled?: string[];
  allowedDomains?: string[];
  maxConcurrentTasks?: number | null;
  heartbeatIntervalSeconds?: number | null;
  autoAssignTasks?: number | boolean | null;
  config: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface OrgChartNode extends Agent {
  children: OrgChartNode[];
}

export interface Task {
  id: string;
  companyId: string;
  projectId: string | null;
  goalId: string | null;
  parentId: string | null;
  title: string;
  description: string | null;
  type: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  taskNumber: number | null;
  identifier: string | null;
  dependencies: string[];
  estimatedTokens: number | null;
  actualTokens: number | null;
  tags: string[];
  dueAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Goal {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  level: string;
  status: string;
  parentId: string | null;
  ownerAgentId: string | null;
  progress: number;
  targetDate: string | null;
  metrics: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  companyId: string;
  fromAgentId: string;
  toAgentId: string;
  threadId: string;
  content: string;
  messageType: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface DashboardData {
  company: Company;
  agents: { total: number; byStatus: Record<string, number> };
  tasks: { total: number; byStatus: Record<string, number> };
  costs: {
    budgetCents: number;
    spentCents: number;
    agentBudgetCents: number;
    agentSpentCents: number;
  };
}

export interface Activity {
  id: string;
  companyId: string;
  actorType: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface TaskFilters {
  status?: string;
  priority?: string;
  assigneeId?: string;
}

// ── Companies ────────────────────────────────────────────────────────────

export const getCompanies = () => request<Company[]>("/companies");

export const getCompany = (id: string) => request<Company>(`/companies/${id}`);

export const getDashboard = (id: string) =>
  request<DashboardData>(`/companies/${id}/dashboard`);

export const createCompany = (data: {
  name: string;
  description?: string;
  mission?: string;
  budgetMonthlyCents?: number;
}) => request<Company>("/companies", { method: "POST", body: JSON.stringify(data) });

export const updateCompany = (
  id: string,
  data: Partial<Pick<Company, "name" | "description" | "mission" | "status" | "budgetMonthlyCents">>,
) => request<Company>(`/companies/${id}`, { method: "PATCH", body: JSON.stringify(data) });

export const deleteCompany = (id: string, hard = false) =>
  request<void>(`/companies/${id}${hard ? "?hard=true" : ""}`, { method: "DELETE" });

// ── Projects ────────────────────────────────────────────────────────────

export interface Project {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export const getProjects = (companyId: string) =>
  request<Project[]>(`/companies/${companyId}/projects`);

// ── Agents ───────────────────────────────────────────────────────────────

export const getAgents = (companyId: string) =>
  request<Agent[]>(`/companies/${companyId}/agents`);

export const getAgent = (companyId: string, agentId: string) =>
  request<Agent>(`/companies/${companyId}/agents/${agentId}`);

export const createAgent = (
  companyId: string,
  data: {
    name: string;
    role: string;
    title: string;
    provider?: string;
    model?: string;
    reportsTo?: string;
    capabilities?: string[];
    systemPrompt?: string;
    budgetMonthlyCents?: number;
    temperature?: number;
    maxTokens?: number;
  },
) =>
  request<Agent>(`/companies/${companyId}/agents`, {
    method: "POST",
    body: JSON.stringify(data),
  });

export const updateAgent = (
  companyId: string,
  agentId: string,
  data: Partial<Agent>,
) =>
  request<Agent>(`/companies/${companyId}/agents/${agentId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });

// ── Tasks ────────────────────────────────────────────────────────────────

export const getTasks = (companyId: string, filters?: TaskFilters) => {
  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.priority) params.set("priority", filters.priority);
  if (filters?.assigneeId) params.set("assigneeId", filters.assigneeId);
  const qs = params.toString();
  return request<Task[]>(`/companies/${companyId}/tasks${qs ? `?${qs}` : ""}`);
};

export const getTask = (companyId: string, taskId: string) =>
  request<Task>(`/companies/${companyId}/tasks/${taskId}`);

export const createTask = (
  companyId: string,
  data: {
    title: string;
    description?: string;
    priority?: string;
    type?: string;
    assigneeAgentId?: string;
    parentId?: string;
    dependencies?: string[];
  },
) =>
  request<Task>(`/companies/${companyId}/tasks`, {
    method: "POST",
    body: JSON.stringify(data),
  });

export const updateTask = (
  companyId: string,
  taskId: string,
  data: Partial<Task>,
) =>
  request<Task>(`/companies/${companyId}/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });

export type TaskThreadItemStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "answered"
  | "linked"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "approved";

export interface TaskThreadPayload extends Record<string, unknown> {
  livenessStatus?: string | null;
  nextActionHint?: string | null;
}

export interface TaskThreadItem {
  id: string;
  companyId: string;
  taskId: string;
  kind: "comment" | "interaction" | "decision" | "approval_link" | "execution_event";
  authorUserId?: string | null;
  authorAgentId?: string | null;
  content: string | null;
  payload: TaskThreadPayload;
  interactionType?: "suggested_tasks" | "confirmation" | "form" | null;
  status: TaskThreadItemStatus;
  idempotencyKey?: string | null;
  relatedApprovalId?: string | null;
  relatedExecutionId?: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string | null;
  source?: "thread" | "execution" | "approval";
}

export const getTaskThread = (companyId: string, taskId: string) =>
  request<TaskThreadItem[]>(`/companies/${companyId}/tasks/${taskId}/thread`);

export const addTaskComment = (
  companyId: string,
  taskId: string,
  content: string,
  idempotencyKey?: string,
) =>
  request<TaskThreadItem>(`/companies/${companyId}/tasks/${taskId}/thread/comments`, {
    method: "POST",
    body: JSON.stringify({ content, idempotencyKey }),
  });

export const respondTaskInteraction = (
  companyId: string,
  taskId: string,
  interactionId: string,
  action: "accept" | "reject" | "answer",
  data?: { note?: string; answers?: Record<string, unknown> },
) =>
  request<TaskThreadItem>(
    `/companies/${companyId}/tasks/${taskId}/thread/interactions/${interactionId}/${action}`,
    { method: "POST", body: JSON.stringify(data ?? {}) },
  );

export const pauseTaskSubtree = (companyId: string, taskId: string, reason?: string) =>
  request<{ rootTaskId: string; affectedTaskIds: string[] }>(
    `/companies/${companyId}/tasks/${taskId}/subtree/pause`,
    { method: "POST", body: JSON.stringify({ reason }) },
  );

export const cancelTaskSubtree = (companyId: string, taskId: string, reason?: string) =>
  request<{ rootTaskId: string; affectedTaskIds: string[] }>(
    `/companies/${companyId}/tasks/${taskId}/subtree/cancel`,
    { method: "POST", body: JSON.stringify({ reason }) },
  );

export const restoreTaskSubtree = (companyId: string, taskId: string) =>
  request<{ rootTaskId: string; affectedTaskIds: string[] }>(
    `/companies/${companyId}/tasks/${taskId}/subtree/restore`,
    { method: "POST", body: JSON.stringify({}) },
  );

// ── Goals ────────────────────────────────────────────────────────────────

export const getGoals = (companyId: string) =>
  request<Goal[]>(`/companies/${companyId}/goals`);

export const createGoal = (
  companyId: string,
  data: {
    title: string;
    description?: string;
    level?: string;
    status?: string;
    parentId?: string;
    ownerAgentId?: string;
    progress?: number;
  },
) =>
  request<Goal>(`/companies/${companyId}/goals`, {
    method: "POST",
    body: JSON.stringify(data),
  });

// ── Messages ─────────────────────────────────────────────────────────────

export const getMessages = (companyId: string) =>
  request<Message[]>(`/companies/${companyId}/messages`);

export const sendMessage = (
  companyId: string,
  data: { fromAgentId: string; toAgentId: string; content: string; threadId?: string },
) =>
  request<Message>(`/companies/${companyId}/messages`, {
    method: "POST",
    body: JSON.stringify(data),
  });

// ── Analytics ────────────────────────────────────────────────────────────

export const getAnalyticsOverview = (companyId: string) =>
  request<Record<string, unknown>>(`/companies/${companyId}/analytics/overview`);

export const getAnalyticsCosts = (companyId: string) =>
  request<Record<string, unknown>>(`/companies/${companyId}/analytics/costs`);

// ── Activity ─────────────────────────────────────────────────────────────

export const getActivity = (companyId: string) =>
  request<Activity[]>(`/companies/${companyId}/activity`);

// ── Org Chart ────────────────────────────────────────────────────────────

export const getOrgChart = (companyId: string) =>
  request<OrgChartNode[]>(`/companies/${companyId}/org-chart`);

// ── Secrets ─────────────────────────────────────────────────────────────

export interface Secret {
  id: string;
  companyId: string;
  name: string;
  provider: string;
  description: string | null;
  lastFourChars: string | null;
  createdAt: string;
  updatedAt: string;
}

export const getSecrets = (companyId: string) =>
  request<Secret[]>(`/companies/${companyId}/secrets`);

export const createSecret = (
  companyId: string,
  data: { name: string; value: string; provider: string; description?: string },
) =>
  request<Secret>(`/companies/${companyId}/secrets`, {
    method: "POST",
    body: JSON.stringify(data),
  });

export const deleteSecret = (companyId: string, secretId: string) =>
  request<void>(`/companies/${companyId}/secrets/${secretId}`, {
    method: "DELETE",
  });

// ── Agent Instructions ──────────────────────────────────────────────────

export const getAgentInstructions = (companyId: string, agentId: string) =>
  request<{ instructions: string }>(
    `/companies/${companyId}/agents/${agentId}/instructions`,
  );

export const updateAgentInstructions = (
  companyId: string,
  agentId: string,
  instructions: string,
) =>
  request<{ instructions: string }>(
    `/companies/${companyId}/agents/${agentId}/instructions`,
    { method: "PUT", body: JSON.stringify({ instructions }) },
  );

// ── Agent Config Revisions ──────────────────────────────────────────────

export interface ConfigRevision {
  id: string;
  agentId: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
  changedBy: string | null;
  changedAt: string;
}

export const getAgentRevisions = (companyId: string, agentId: string) =>
  request<ConfigRevision[]>(
    `/companies/${companyId}/agents/${agentId}/revisions`,
  );

// ── Agent Executions ────────────────────────────────────────────────────

export interface Execution {
  id: string;
  agentId: string;
  taskId: string | null;
  action: string;
  status: string;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  summary?: string | null;
  provider?: string | null;
  modelUsed?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costCents?: number | null;
  log?: Array<{
    timestamp: string;
    level: string;
    message: string;
    phase?: "observe" | "think" | "act" | "reflect";
    iteration?: number;
    content?: string;
    toolCalls?: Array<{
      tool: string;
      serverId?: string;
      args: Record<string, unknown>;
      result: string;
    }>;
  }>;
  tokensUsed: number | null;
  durationMs: number | null;
  error: string | null;
  livenessStatus: "healthy" | "silent" | "stalled" | "recovering" | "recovered";
  lastUsefulAction: string | null;
  nextActionHint: string | null;
  continuationAttempts: number;
  lastContinuationAt: string | null;
  watchdogLastCheckedAt: string | null;
  recoveryTaskId: string | null;
  startedAt: string;
  completedAt: string | null;
}

export const getAgentExecutions = (companyId: string, agentId: string) =>
  request<Execution[]>(
    `/companies/${companyId}/agents/${agentId}/executions`,
  );

// ── Board Chat ─────────────────────────────────────────────────────────

export interface ChatThread {
  id: string;
  lastMessage: string;
  lastMessageAt: string;
  participantAgentIds: string[];
  messageCount: number;
}

export interface ChatMessage {
  id: string;
  companyId: string;
  fromAgentId: string;
  toAgentId: string;
  threadId: string;
  content: string;
  messageType: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface SendChatResult {
  messageId: string;
  threadId: string;
  respondingAgentId: string | null;
  respondingAgentName: string | null;
}

export const getChatThreads = (companyId: string) =>
  request<ChatThread[]>(`/companies/${companyId}/chat/threads`);

export const getChatThread = (companyId: string, threadId: string) =>
  request<ChatMessage[]>(`/companies/${companyId}/chat/threads/${threadId}`);

export const sendChatMessage = (
  companyId: string,
  data: { content: string; targetAgentId?: string; threadId?: string },
) =>
  request<SendChatResult>(`/companies/${companyId}/chat/send`, {
    method: "POST",
    body: JSON.stringify(data),
  });

// ── Webhooks ──────────────────────────────────────────────────────────

export interface Webhook {
  id: string;
  companyId: string;
  name: string;
  secret: string; // masked (last 4 chars) on list; full on create
  targetAgentId: string | null;
  eventType: string;
  enabled: boolean;
  lastTriggeredAt: string | null;
  triggerCount: number;
  createdAt: string;
  updatedAt: string;
}

export const getWebhooks = (companyId: string) =>
  request<Webhook[]>(`/companies/${companyId}/webhooks`);

export const createWebhook = (
  companyId: string,
  data: { name: string; eventType: string; targetAgentId?: string },
) =>
  request<Webhook>(`/companies/${companyId}/webhooks`, {
    method: "POST",
    body: JSON.stringify(data),
  });

export const updateWebhook = (
  companyId: string,
  webhookId: string,
  data: { enabled: boolean },
) =>
  request<Webhook>(`/companies/${companyId}/webhooks/${webhookId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });

export const deleteWebhook = (companyId: string, webhookId: string) =>
  request<void>(`/companies/${companyId}/webhooks/${webhookId}`, {
    method: "DELETE",
  });

// ── Agent Files ──────────────────────────────────────────────────────────

export interface AgentFile {
  id: string;
  companyId: string;
  agentId: string | null;
  name: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  content?: string;
  storageType: string;
  parentId: string | null;
  isDirectory: boolean;
  taskId: string | null;
  executionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const getFiles = (companyId: string, agentId?: string) => {
  const params = new URLSearchParams();
  if (agentId) params.set("agentId", agentId);
  const qs = params.toString();
  return request<AgentFile[]>(`/companies/${companyId}/files${qs ? `?${qs}` : ""}`);
};

export const getFile = (companyId: string, fileId: string) =>
  request<AgentFile>(`/companies/${companyId}/files/${fileId}`);

export const createFile = (
  companyId: string,
  data: {
    name: string;
    content?: string;
    mimeType?: string;
    agentId?: string;
    parentId?: string;
    isDirectory?: boolean;
    taskId?: string;
    executionId?: string;
  },
) =>
  request<AgentFile>(`/companies/${companyId}/files`, {
    method: "POST",
    body: JSON.stringify(data),
  });

export const updateFile = (
  companyId: string,
  fileId: string,
  data: { name?: string; content?: string; mimeType?: string },
) =>
  request<AgentFile>(`/companies/${companyId}/files/${fileId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });

export const deleteFile = (companyId: string, fileId: string) =>
  request<void>(`/companies/${companyId}/files/${fileId}`, {
    method: "DELETE",
  });

export const getAgentFiles = (companyId: string, agentId: string) =>
  request<AgentFile[]>(`/companies/${companyId}/agents/${agentId}/files`);

// ── Integrations ─────────────────────────────────────────────────────────

export interface IntegrationCatalogItem {
  type: string;
  provider: string;
  name: string;
  description: string;
  configFields: string[];
}

export interface Integration {
  id: string;
  companyId: string;
  name: string;
  type: string;
  provider: string;
  config: Record<string, unknown>;
  credentialsEncrypted: string | null;
  status: string;
  lastUsedAt: string | null;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationsResponse {
  data: Integration[];
  catalog: IntegrationCatalogItem[];
}

export const getIntegrations = (companyId: string) =>
  request<IntegrationsResponse>(`/companies/${companyId}/integrations`);

export const createIntegration = (
  companyId: string,
  data: {
    name: string;
    type: string;
    provider: string;
    config: Record<string, unknown>;
    credentials?: string;
  },
) =>
  request<Integration>(`/companies/${companyId}/integrations`, {
    method: "POST",
    body: JSON.stringify(data),
  });

export const updateIntegration = (
  companyId: string,
  integrationId: string,
  data: {
    name?: string;
    config?: Record<string, unknown>;
    credentials?: string;
    status?: string;
  },
) =>
  request<Integration>(`/companies/${companyId}/integrations/${integrationId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });

export const deleteIntegration = (companyId: string, integrationId: string) =>
  request<void>(`/companies/${companyId}/integrations/${integrationId}`, {
    method: "DELETE",
  });

export const testIntegration = (companyId: string, integrationId: string) =>
  request<{ id: string; success: boolean; message: string; testedAt: string }>(
    `/companies/${companyId}/integrations/${integrationId}/test`,
    { method: "POST" },
  );

// ── Knowledge Base ─────────────────────────────────────────────────────

export interface KnowledgeDocument {
  id: string;
  companyId: string;
  title: string;
  content: string;
  contentType: string;
  source: string | null;
  sourceUrl: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  chunkCount: number;
  embeddingStatus: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeSearchResult {
  chunk: {
    id: string;
    documentId: string;
    companyId: string;
    chunkIndex: number;
    content: string;
    tokenCount: number;
  };
  score: number;
  documentTitle: string;
  documentId: string;
}

export const getKnowledgeDocs = (companyId: string) =>
  request<KnowledgeDocument[]>(`/companies/${companyId}/knowledge`);

export const addKnowledgeDoc = (
  companyId: string,
  data: { title: string; content: string; tags?: string[] },
) =>
  request<KnowledgeDocument>(`/companies/${companyId}/knowledge`, {
    method: "POST",
    body: JSON.stringify(data),
  });

export const getKnowledgeDoc = (companyId: string, docId: string) =>
  request<KnowledgeDocument & { chunks: unknown[] }>(
    `/companies/${companyId}/knowledge/${docId}`,
  );

export const updateKnowledgeDoc = (
  companyId: string,
  docId: string,
  data: { title?: string; content?: string; tags?: string[] },
) =>
  request<KnowledgeDocument>(`/companies/${companyId}/knowledge/${docId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });

export const deleteKnowledgeDoc = (companyId: string, docId: string) =>
  request<void>(`/companies/${companyId}/knowledge/${docId}`, {
    method: "DELETE",
  });

export const searchKnowledge = (companyId: string, query: string, topK?: number) =>
  request<KnowledgeSearchResult[]>(
    `/companies/${companyId}/knowledge/search`,
    {
      method: "POST",
      body: JSON.stringify({ query, topK }),
    },
  );

// ── Agent Memories ────────────────────────────────────────────────────

export interface AgentMemory {
  id: string;
  companyId: string;
  agentId: string;
  memoryType: "observation" | "decision" | "preference" | "fact" | "lesson";
  content: string;
  importance: number;
  sourceTaskId: string | null;
  sourceExecutionId: string | null;
  tags: string[];
  expiresAt: string | null;
  createdAt: string;
}

export const getAgentMemories = (companyId: string, agentId: string) =>
  request<AgentMemory[]>(
    `/companies/${companyId}/agents/${agentId}/memories`,
  );

export const createAgentMemory = (
  companyId: string,
  agentId: string,
  data: {
    content: string;
    memoryType?: string;
    importance?: number;
    tags?: string[];
  },
) =>
  request<AgentMemory>(
    `/companies/${companyId}/agents/${agentId}/memories`,
    { method: "POST", body: JSON.stringify(data) },
  );

export const deleteAgentMemory = (
  companyId: string,
  agentId: string,
  memoryId: string,
) =>
  request<void>(
    `/companies/${companyId}/agents/${agentId}/memories/${memoryId}`,
    { method: "DELETE" },
  );

export const clearAgentMemories = (companyId: string, agentId: string) =>
  request<void>(
    `/companies/${companyId}/agents/${agentId}/memories`,
    { method: "DELETE" },
  );

export const recallAgentMemories = (
  companyId: string,
  agentId: string,
  context: string,
  limit?: number,
) =>
  request<AgentMemory[]>(
    `/companies/${companyId}/agents/${agentId}/memories/recall`,
    {
      method: "POST",
      body: JSON.stringify({ context, limit }),
    },
  );

// ── Prompt Templates ──────────────────────────────────────────────────

export interface PromptTemplate {
  id: string;
  companyId: string | null;
  name: string;
  description: string | null;
  category: string;
  content: string;
  variables: string[];
  version: number;
  isGlobal: number;
  usageCount: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PromptVersion {
  id: string;
  templateId: string;
  version: number;
  content: string;
  changeNote: string | null;
  createdBy: string | null;
  createdAt: string;
}

export const getGlobalPromptTemplates = () =>
  request<PromptTemplate[]>("/prompts");

export const getPromptTemplates = (companyId: string, category?: string) => {
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  const qs = params.toString();
  return request<PromptTemplate[]>(
    `/companies/${companyId}/prompts${qs ? `?${qs}` : ""}`,
  );
};

export const createPromptTemplate = (
  companyId: string,
  data: {
    name: string;
    description?: string;
    category?: string;
    content: string;
    variables?: string[];
    isGlobal?: boolean;
  },
) =>
  request<PromptTemplate>(`/companies/${companyId}/prompts`, {
    method: "POST",
    body: JSON.stringify(data),
  });

export const updatePromptTemplate = (
  companyId: string,
  templateId: string,
  data: {
    name?: string;
    description?: string;
    category?: string;
    content?: string;
    variables?: string[];
    changeNote?: string;
  },
) =>
  request<PromptTemplate>(`/companies/${companyId}/prompts/${templateId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });

export const deletePromptTemplate = (companyId: string, templateId: string) =>
  request<void>(`/companies/${companyId}/prompts/${templateId}`, {
    method: "DELETE",
  });

export const getPromptVersions = (companyId: string, templateId: string) =>
  request<PromptVersion[]>(
    `/companies/${companyId}/prompts/${templateId}/versions`,
  );

export const applyPromptToAgent = (
  companyId: string,
  templateId: string,
  agentId: string,
  variables?: Record<string, string>,
) =>
  request<{ agentId: string; templateId: string; templateName: string; instructions: string }>(
    `/companies/${companyId}/prompts/${templateId}/apply`,
    {
      method: "POST",
      body: JSON.stringify({ agentId, variables: variables ?? {} }),
    },
  );

// ── Agent Evaluations & Performance ─────────────────────────────────────

export interface AgentEvaluation {
  id: string;
  companyId: string;
  agentId: string;
  executionId: string | null;
  taskId: string | null;
  qualityScore: number | null;
  speedScore: number | null;
  costEfficiencyScore: number | null;
  overallScore: number | null;
  evaluator: string;
  feedback: string | null;
  metrics: Record<string, unknown>;
  createdAt: string;
  agentName?: string;
  agentRole?: string;
}

export interface AgentPerformance {
  averageScores: {
    quality: number;
    speed: number;
    costEfficiency: number;
    overall: number;
  };
  totalEvaluations: number;
  trend: "improving" | "stable" | "declining";
  recentEvaluations: AgentEvaluation[];
}

export interface AgentRanking {
  agentId: string;
  agentName: string;
  role: string;
  averageScore: number;
  totalTasks: number;
  totalCostCents: number;
}

export const getCompanyEvaluations = (companyId: string) =>
  request<AgentEvaluation[]>(`/companies/${companyId}/evaluations`);

export const getCompanyRankings = (companyId: string) =>
  request<AgentRanking[]>(`/companies/${companyId}/evaluations/rankings`);

export const getAgentEvaluations = (companyId: string, agentId: string) =>
  request<AgentEvaluation[]>(
    `/companies/${companyId}/evaluations/agents/${agentId}/evaluations`,
  );

export const createManualEvaluation = (
  companyId: string,
  agentId: string,
  data: {
    qualityScore: number;
    feedback: string;
    executionId?: string;
    taskId?: string;
  },
) =>
  request<AgentEvaluation>(
    `/companies/${companyId}/evaluations/agents/${agentId}/evaluations`,
    { method: "POST", body: JSON.stringify(data) },
  );

export const getAgentPerformance = (companyId: string, agentId: string) =>
  request<AgentPerformance>(
    `/companies/${companyId}/evaluations/agents/${agentId}/performance`,
  );

// ── MCP (Model Context Protocol) ────────────────────────────────────────

export interface MCPServer {
  id: string;
  companyId: string;
  name: string;
  transport: "stdio" | "sse" | "streamable-http";
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  status: "connected" | "disconnected" | "error";
  availableTools: MCPToolDef[];
  availableResources: MCPResourceDef[];
  lastConnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MCPToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPResourceDef {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPToolWithServer extends MCPToolDef {
  serverId: string;
  serverName: string;
}

export const getMCPServers = (companyId: string) =>
  request<MCPServer[]>(`/companies/${companyId}/mcp/servers`);

export const addMCPServer = (
  companyId: string,
  data: {
    name: string;
    transport: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
  },
) =>
  request<MCPServer>(`/companies/${companyId}/mcp/servers`, {
    method: "POST",
    body: JSON.stringify(data),
  });

export const deleteMCPServer = (companyId: string, serverId: string) =>
  request<void>(`/companies/${companyId}/mcp/servers/${serverId}`, {
    method: "DELETE",
  });

export const getMCPTools = (companyId: string) =>
  request<MCPToolWithServer[]>(`/companies/${companyId}/mcp/tools`);

export const callMCPTool = (
  companyId: string,
  toolName: string,
  data: { serverId: string; args?: Record<string, unknown> },
) =>
  request<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>(
    `/companies/${companyId}/mcp/tools/${toolName}/call`,
    { method: "POST", body: JSON.stringify(data) },
  );

// ── Agent Collaborations ────────────────────────────────────────────────

export interface AgentCollaboration {
  id: string;
  companyId: string;
  type: "delegation" | "request_help" | "review" | "consensus" | "escalation";
  fromAgentId: string;
  toAgentId: string;
  taskId: string | null;
  parentCollaborationId: string | null;
  status: "pending" | "accepted" | "in_progress" | "completed" | "rejected" | "cancelled";
  requestContent: string;
  responseContent: string | null;
  priority: "low" | "medium" | "high" | "critical";
  createdAt: string;
  completedAt: string | null;
}

export const getCollaborations = (companyId: string, limit?: number) => {
  const params = new URLSearchParams();
  if (limit) params.set("limit", String(limit));
  const qs = params.toString();
  return request<AgentCollaboration[]>(
    `/companies/${companyId}/collaborations${qs ? `?${qs}` : ""}`,
  );
};

export const getCollaboration = (companyId: string, id: string) =>
  request<AgentCollaboration>(`/companies/${companyId}/collaborations/${id}`);

export const createCollaboration = (
  companyId: string,
  data: {
    type: "delegation" | "request_help" | "review" | "escalation";
    fromAgentId: string;
    toAgentId?: string;
    taskId?: string;
    requestContent?: string;
    priority?: string;
    parentCollaborationId?: string;
  },
) =>
  request<AgentCollaboration>(`/companies/${companyId}/collaborations`, {
    method: "POST",
    body: JSON.stringify(data),
  });

export const respondToCollaboration = (
  companyId: string,
  id: string,
  responseContent: string,
) =>
  request<AgentCollaboration>(
    `/companies/${companyId}/collaborations/${id}/respond`,
    { method: "POST", body: JSON.stringify({ responseContent }) },
  );

export const getAgentCollaborations = (companyId: string, agentId: string) =>
  request<AgentCollaboration[]>(
    `/companies/${companyId}/agents/${agentId}/collaborations`,
  );

export const getAgentPendingCollaborations = (companyId: string, agentId: string) =>
  request<AgentCollaboration[]>(
    `/companies/${companyId}/agents/${agentId}/collaborations/pending`,
  );

// ── Company Templates ───────────────────────────────────────────────────

export interface CompanyTemplate {
  id: string;
  name: string;
  description: string | null;
  category: string;
  author: string | null;
  version: string;
  config: Record<string, unknown>;
  agentCount: number;
  isPublic: number;
  downloadCount: number;
  tags: string[];
  previewImage: string | null;
  createdAt: string;
  updatedAt: string;
}

export const getTemplates = (category?: string) => {
  const params = new URLSearchParams();
  if (category && category !== "all") params.set("category", category);
  const qs = params.toString();
  return request<CompanyTemplate[]>(`/templates${qs ? `?${qs}` : ""}`);
};

export const getTemplate = (id: string) =>
  request<CompanyTemplate>(`/templates/${id}`);

export const saveTemplate = (data: {
  name: string;
  description?: string;
  category?: string;
  author?: string;
  version?: string;
  config: Record<string, unknown>;
  tags?: string[];
  isPublic?: boolean;
}) =>
  request<CompanyTemplate>("/templates", {
    method: "POST",
    body: JSON.stringify(data),
  });

export const importTemplate = (
  templateId: string,
  overrides?: { companyName?: string; budgetMultiplier?: number },
) =>
  request<{ companyId: string }>(`/templates/${templateId}/import`, {
    method: "POST",
    body: JSON.stringify(overrides ?? {}),
  });

export const exportCompany = (
  companyId: string,
  data?: { name?: string; description?: string; category?: string; tags?: string[] },
) =>
  request<{ template: CompanyTemplate; config: Record<string, unknown> }>(
    `/companies/${companyId}/export`,
    { method: "POST", body: JSON.stringify(data ?? {}) },
  );

// ── Inbox (unified feed) ────────────────────────────────────────────────

export type InboxItemKind = "approval" | "collaboration" | "activity" | "task_thread";

export interface InboxItem {
  id: string;
  kind: InboxItemKind;
  title: string;
  subtitle?: string;
  priority?: "critical" | "high" | "medium" | "low";
  status?: string;
  actorId?: string;
  entityType?: string;
  entityId?: string;
  taskId?: string;
  threadItemId?: string;
  link: string;
  createdAt: string;
  readAt: string | null;
}

export interface InboxResponse {
  data: InboxItem[];
  meta: {
    pendingApprovals: number;
    pendingCollaborations: number;
    pendingThreadItems?: number;
    total: number;
    unread: number;
  };
}

export const listInbox = (companyId: string, limit = 100) =>
  request<InboxResponse>(
    `/companies/${companyId}/inbox?limit=${limit}`,
  );

export const markInboxRead = (companyId: string, itemIds: string[]) =>
  request<{ marked: number; readAt: string }>(
    `/companies/${companyId}/inbox/read`,
    { method: "POST", body: JSON.stringify({ itemIds }) },
  );

export const markInboxUnread = (companyId: string, itemIds: string[]) =>
  request<{ cleared: number }>(
    `/companies/${companyId}/inbox/unread`,
    { method: "POST", body: JSON.stringify({ itemIds }) },
  );

// ── Approvals ───────────────────────────────────────────────────────────

export type ApprovalKind =
  | "budget_change"
  | "agent_termination"
  | "task_review"
  | "custom";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled";
export type ApprovalPriority = "critical" | "high" | "medium" | "low";

export interface Approval {
  id: string;
  companyId: string;
  kind: ApprovalKind;
  title: string;
  description: string | null;
  status: ApprovalStatus;
  priority: ApprovalPriority;
  requestedByUserId: string | null;
  requestedByAgentId: string | null;
  resolvedByUserId: string | null;
  resolutionNote: string | null;
  payload: Record<string, unknown>;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface ApprovalComment {
  id: string;
  approvalId: string;
  authorUserId: string | null;
  authorAgentId: string | null;
  content: string;
  createdAt: string;
}

export const listApprovals = (companyId: string, status?: ApprovalStatus) =>
  request<Approval[]>(
    `/companies/${companyId}/approvals${status ? `?status=${status}` : ""}`,
  );

export const getApproval = (companyId: string, id: string) =>
  request<{ approval: Approval; comments: ApprovalComment[] }>(
    `/companies/${companyId}/approvals/${id}`,
  );

export const createApproval = (
  companyId: string,
  data: {
    title: string;
    description?: string;
    kind?: ApprovalKind;
    priority?: ApprovalPriority;
    payload?: Record<string, unknown>;
    taskId?: string;
    requestedByAgentId?: string;
  },
) =>
  request<Approval>(`/companies/${companyId}/approvals`, {
    method: "POST",
    body: JSON.stringify(data),
  });

export const decideApproval = (
  companyId: string,
  id: string,
  data: { decision: "approved" | "rejected"; resolutionNote?: string },
) =>
  request<Approval>(`/companies/${companyId}/approvals/${id}/decide`, {
    method: "POST",
    body: JSON.stringify(data),
  });

export const cancelApproval = (
  companyId: string,
  id: string,
  resolutionNote?: string,
) =>
  request<Approval>(`/companies/${companyId}/approvals/${id}/cancel`, {
    method: "POST",
    body: JSON.stringify({ resolutionNote }),
  });

export const addApprovalComment = (
  companyId: string,
  id: string,
  content: string,
) =>
  request<ApprovalComment>(
    `/companies/${companyId}/approvals/${id}/comments`,
    { method: "POST", body: JSON.stringify({ content }) },
  );
