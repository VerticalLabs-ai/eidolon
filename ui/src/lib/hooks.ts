// Eidolon hooks — v2 with projects, delete, toasts
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import * as api from "./api";
import type { TaskFilters } from "./api";

// Helper: server wraps responses in { data: ... }, unwrap it
function unwrap<T>(res: unknown): T {
  if (res && typeof res === "object" && "data" in res) {
    return (res as { data: T }).data;
  }
  return res as T;
}

// ── Companies ────────────────────────────────────────────────────────────

export function useCompanies() {
  return useQuery({
    queryKey: ["companies"],
    queryFn: async () => unwrap<api.Company[]>(await api.getCompanies()),
  });
}

export function useCompany(id: string | undefined) {
  return useQuery({
    queryKey: ["companies", id],
    queryFn: async () => unwrap<api.Company>(await api.getCompany(id!)),
    enabled: !!id,
  });
}

export function useDashboard(id: string | undefined) {
  return useQuery({
    queryKey: ["dashboard", id],
    queryFn: async () => unwrap<api.DashboardData>(await api.getDashboard(id!)),
    enabled: !!id,
    refetchInterval: 10_000,
  });
}

export function useCreateCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof api.createCompany>[0]) =>
      api.createCompany(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["companies"] });
    },
  });
}

export function useUpdateCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: Parameters<typeof api.updateCompany>[1];
    }) => api.updateCompany(id, data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["companies"] });
      qc.invalidateQueries({ queryKey: ["companies", vars.id] });
      qc.invalidateQueries({ queryKey: ["dashboard", vars.id] });
    },
  });
}

export function useDeleteCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, hard = false }: { id: string; hard?: boolean }) =>
      api.deleteCompany(id, hard),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["companies"] });
    },
  });
}

// ── Projects ────────────────────────────────────────────────────────────

export function useProjects(companyId: string | undefined) {
  return useQuery({
    queryKey: ["projects", companyId],
    queryFn: async () => unwrap<api.Project[]>(await api.getProjects(companyId!)),
    enabled: !!companyId,
  });
}

// ── Agents ───────────────────────────────────────────────────────────────

export function useAgents(companyId: string | undefined) {
  return useQuery({
    queryKey: ["agents", companyId],
    queryFn: async () => unwrap<api.Agent[]>(await api.getAgents(companyId!)),
    enabled: !!companyId,
  });
}

export function useAgent(companyId: string | undefined, agentId: string | undefined) {
  return useQuery({
    queryKey: ["agents", companyId, agentId],
    queryFn: async () => unwrap<api.Agent>(await api.getAgent(companyId!, agentId!)),
    enabled: !!companyId && !!agentId,
  });
}

export function useCreateAgent(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof api.createAgent>[1]) =>
      api.createAgent(companyId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agents", companyId] });
      qc.invalidateQueries({ queryKey: ["dashboard", companyId] });
    },
  });
}

export function useUpdateAgent(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      agentId,
      data,
    }: {
      agentId: string;
      data: Parameters<typeof api.updateAgent>[2];
    }) => api.updateAgent(companyId, agentId, data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["agents", companyId] });
      qc.invalidateQueries({ queryKey: ["agents", companyId, vars.agentId] });
    },
  });
}

// ── Tasks ────────────────────────────────────────────────────────────────

export function useTasks(companyId: string | undefined, filters?: TaskFilters) {
  return useQuery({
    queryKey: ["tasks", companyId, filters],
    queryFn: async () => unwrap<api.Task[]>(await api.getTasks(companyId!, filters)),
    enabled: !!companyId,
  });
}

export function useTask(companyId: string | undefined, taskId: string | undefined) {
  return useQuery({
    queryKey: ["tasks", companyId, taskId],
    queryFn: async () => unwrap<api.Task>(await api.getTask(companyId!, taskId!)),
    enabled: !!companyId && !!taskId,
  });
}

export function useTaskThread(companyId: string | undefined, taskId: string | undefined) {
  return useQuery({
    queryKey: ["tasks", companyId, taskId, "thread"],
    queryFn: async () =>
      unwrap<api.TaskThreadItem[]>(await api.getTaskThread(companyId!, taskId!)),
    enabled: !!companyId && !!taskId,
    refetchInterval: 10_000,
  });
}

export function useCreateTask(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof api.createTask>[1]) =>
      api.createTask(companyId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks", companyId] });
      qc.invalidateQueries({ queryKey: ["dashboard", companyId] });
    },
  });
}

export function useAddTaskComment(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { taskId: string; content: string }) =>
      api.addTaskComment(companyId, args.taskId, args.content),
    onSuccess: (_data, args) => {
      qc.invalidateQueries({ queryKey: ["tasks", companyId, args.taskId, "thread"] });
    },
  });
}

export function useRespondTaskInteraction(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      taskId: string;
      interactionId: string;
      action: "accept" | "reject" | "answer";
      note?: string;
      answers?: Record<string, unknown>;
    }) =>
      api.respondTaskInteraction(
        companyId,
        args.taskId,
        args.interactionId,
        args.action,
        { note: args.note, answers: args.answers },
      ),
    onSuccess: (_data, args) => {
      qc.invalidateQueries({ queryKey: ["tasks", companyId] });
      qc.invalidateQueries({ queryKey: ["tasks", companyId, args.taskId] });
      qc.invalidateQueries({ queryKey: ["tasks", companyId, args.taskId, "thread"] });
    },
  });
}

export function useTaskSubtreeControls(companyId: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (args: {
      taskId: string;
      action: "pause" | "cancel" | "restore";
      reason?: string;
    }) => {
      if (args.action === "restore") {
        return api.restoreTaskSubtree(companyId, args.taskId);
      }
      if (args.action === "pause") {
        return api.pauseTaskSubtree(companyId, args.taskId, args.reason);
      }
      return api.cancelTaskSubtree(companyId, args.taskId, args.reason);
    },
    onSuccess: (_data, args) => {
      qc.invalidateQueries({ queryKey: ["tasks", companyId] });
      qc.invalidateQueries({ queryKey: ["tasks", companyId, args.taskId] });
      qc.invalidateQueries({ queryKey: ["tasks", companyId, args.taskId, "thread"] });
    },
  });
}

export function useUpdateTask(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      taskId,
      data,
    }: {
      taskId: string;
      data: Parameters<typeof api.updateTask>[2];
    }) => api.updateTask(companyId, taskId, data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["tasks", companyId] });
      qc.invalidateQueries({ queryKey: ["tasks", companyId, vars.taskId] });
      qc.invalidateQueries({ queryKey: ["dashboard", companyId] });
    },
  });
}

// ── Goals ────────────────────────────────────────────────────────────────

export function useGoals(companyId: string | undefined) {
  return useQuery({
    queryKey: ["goals", companyId],
    queryFn: async () => unwrap<api.Goal[]>(await api.getGoals(companyId!)),
    enabled: !!companyId,
  });
}

export function useGoalTree(companyId: string | undefined) {
  return useGoals(companyId);
}

// ── Messages ─────────────────────────────────────────────────────────────

export function useMessages(companyId: string | undefined) {
  return useQuery({
    queryKey: ["messages", companyId],
    queryFn: async () => unwrap<api.Message[]>(await api.getMessages(companyId!)),
    enabled: !!companyId,
  });
}

export function useThreads(companyId: string | undefined) {
  return useMessages(companyId);
}

export function useSendMessage(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof api.sendMessage>[1]) =>
      api.sendMessage(companyId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["messages", companyId] });
    },
  });
}

// ── Analytics ────────────────────────────────────────────────────────────

export function useAnalytics(companyId: string | undefined) {
  return useAnalyticsOverview(companyId);
}

export function useCostSummary(companyId: string | undefined) {
  return useAnalyticsCosts(companyId);
}

export function useAnalyticsOverview(companyId: string | undefined) {
  return useQuery({
    queryKey: ["analytics", companyId, "overview"],
    queryFn: async () => unwrap<Record<string, unknown>>(await api.getAnalyticsOverview(companyId!)),
    enabled: !!companyId,
    staleTime: 60_000,
  });
}

export function useAnalyticsCosts(companyId: string | undefined) {
  return useQuery({
    queryKey: ["analytics", companyId, "costs"],
    queryFn: async () => unwrap<Record<string, unknown>>(await api.getAnalyticsCosts(companyId!)),
    enabled: !!companyId,
    staleTime: 60_000,
  });
}

// ── Activity ─────────────────────────────────────────────────────────────

export function useActivity(companyId: string | undefined) {
  return useQuery({
    queryKey: ["activity", companyId],
    queryFn: async () => unwrap<api.Activity[]>(await api.getActivity(companyId!)),
    enabled: !!companyId,
    refetchInterval: 15_000,
  });
}

// ── Org Chart ────────────────────────────────────────────────────────────

export function useOrgChart(companyId: string | undefined) {
  return useQuery({
    queryKey: ["org-chart", companyId],
    queryFn: async () =>
      unwrap<api.OrgChartNode[]>(await api.getOrgChart(companyId!)),
    enabled: !!companyId,
  });
}

// ── Secrets ─────────────────────────────────────────────────────────────

export function useSecrets(companyId: string | undefined) {
  return useQuery({
    queryKey: ["secrets", companyId],
    queryFn: async () => unwrap<api.Secret[]>(await api.getSecrets(companyId!)),
    enabled: !!companyId,
  });
}

export function useCreateSecret(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof api.createSecret>[1]) =>
      api.createSecret(companyId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["secrets", companyId] });
    },
  });
}

export function useDeleteSecret(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (secretId: string) => api.deleteSecret(companyId, secretId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["secrets", companyId] });
    },
  });
}

// ── Agent Instructions ──────────────────────────────────────────────────

export function useAgentInstructions(
  companyId: string | undefined,
  agentId: string | undefined,
) {
  return useQuery({
    queryKey: ["agent-instructions", companyId, agentId],
    queryFn: async () =>
      unwrap<{ instructions: string }>(
        await api.getAgentInstructions(companyId!, agentId!),
      ),
    enabled: !!companyId && !!agentId,
  });
}

export function useUpdateAgentInstructions(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      agentId,
      instructions,
    }: {
      agentId: string;
      instructions: string;
    }) => api.updateAgentInstructions(companyId, agentId, instructions),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({
        queryKey: ["agent-instructions", companyId, vars.agentId],
      });
    },
  });
}

// ── Agent Config Revisions ──────────────────────────────────────────────

export function useAgentRevisions(
  companyId: string | undefined,
  agentId: string | undefined,
) {
  return useQuery({
    queryKey: ["agent-revisions", companyId, agentId],
    queryFn: async () =>
      unwrap<api.ConfigRevision[]>(
        await api.getAgentRevisions(companyId!, agentId!),
      ),
    enabled: !!companyId && !!agentId,
  });
}

// ── Board Chat ─────────────────────────────────────────────────────────

export function useChatThreads(companyId: string | undefined) {
  return useQuery({
    queryKey: ["chat-threads", companyId],
    queryFn: async () =>
      unwrap<api.ChatThread[]>(await api.getChatThreads(companyId!)),
    enabled: !!companyId,
    refetchInterval: 10_000,
  });
}

export function useChatThread(
  companyId: string | undefined,
  threadId: string | undefined,
) {
  return useQuery({
    queryKey: ["chat-thread", companyId, threadId],
    queryFn: async () =>
      unwrap<api.ChatMessage[]>(await api.getChatThread(companyId!, threadId!)),
    enabled: !!companyId && !!threadId,
    refetchInterval: 5_000,
  });
}

export function useSendChatMessage(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { content: string; targetAgentId?: string; threadId?: string }) =>
      api.sendChatMessage(companyId, data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["chat-threads", companyId] });
      if (vars.threadId) {
        qc.invalidateQueries({ queryKey: ["chat-thread", companyId, vars.threadId] });
      }
    },
  });
}

// ── Agent Executions ────────────────────────────────────────────────────

export function useAgentExecutions(
  companyId: string | undefined,
  agentId: string | undefined,
) {
  return useQuery({
    queryKey: ["agent-executions", companyId, agentId],
    queryFn: async () =>
      unwrap<api.Execution[]>(
        await api.getAgentExecutions(companyId!, agentId!),
      ),
    enabled: !!companyId && !!agentId,
    refetchInterval: 10_000,
  });
}

// ── Webhooks ──────────────────────────────────────────────────────────

export function useWebhooks(companyId: string | undefined) {
  return useQuery({
    queryKey: ["webhooks", companyId],
    queryFn: async () => unwrap<api.Webhook[]>(await api.getWebhooks(companyId!)),
    enabled: !!companyId,
  });
}

export function useCreateWebhook(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof api.createWebhook>[1]) =>
      api.createWebhook(companyId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["webhooks", companyId] });
    },
  });
}

export function useUpdateWebhook(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      webhookId,
      data,
    }: {
      webhookId: string;
      data: Parameters<typeof api.updateWebhook>[2];
    }) => api.updateWebhook(companyId, webhookId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["webhooks", companyId] });
    },
  });
}

export function useDeleteWebhook(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (webhookId: string) => api.deleteWebhook(companyId, webhookId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["webhooks", companyId] });
    },
  });
}

// ── Agent Files ──────────────────────────────────────────────────────────

export function useFiles(companyId: string | undefined, agentId?: string) {
  return useQuery({
    queryKey: ["files", companyId, agentId],
    queryFn: async () => unwrap<api.AgentFile[]>(await api.getFiles(companyId!, agentId)),
    enabled: !!companyId,
  });
}

export function useFile(companyId: string | undefined, fileId: string | undefined) {
  return useQuery({
    queryKey: ["files", companyId, "detail", fileId],
    queryFn: async () => unwrap<api.AgentFile>(await api.getFile(companyId!, fileId!)),
    enabled: !!companyId && !!fileId,
  });
}

export function useCreateFile(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof api.createFile>[1]) =>
      api.createFile(companyId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["files", companyId] });
    },
  });
}

export function useUpdateFile(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      fileId,
      data,
    }: {
      fileId: string;
      data: Parameters<typeof api.updateFile>[2];
    }) => api.updateFile(companyId, fileId, data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["files", companyId] });
      qc.invalidateQueries({ queryKey: ["files", companyId, "detail", vars.fileId] });
    },
  });
}

export function useDeleteFile(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) => api.deleteFile(companyId, fileId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["files", companyId] });
    },
  });
}

// ── Integrations ─────────────────────────────────────────────────────────

export function useIntegrations(companyId: string | undefined) {
  return useQuery({
    queryKey: ["integrations", companyId],
    queryFn: async () => {
      const res = await api.getIntegrations(companyId!);
      // Server wraps in { data, catalog } at top level
      if (res && typeof res === "object" && "data" in res) {
        return res as api.IntegrationsResponse;
      }
      return { data: [], catalog: [] } as api.IntegrationsResponse;
    },
    enabled: !!companyId,
  });
}

export function useCreateIntegration(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof api.createIntegration>[1]) =>
      api.createIntegration(companyId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["integrations", companyId] });
    },
  });
}

export function useUpdateIntegration(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      integrationId,
      data,
    }: {
      integrationId: string;
      data: Parameters<typeof api.updateIntegration>[2];
    }) => api.updateIntegration(companyId, integrationId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["integrations", companyId] });
    },
  });
}

export function useDeleteIntegration(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (integrationId: string) => api.deleteIntegration(companyId, integrationId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["integrations", companyId] });
    },
  });
}

export function useTestIntegration(companyId: string) {
  return useMutation({
    mutationFn: (integrationId: string) => api.testIntegration(companyId, integrationId),
  });
}

// ── Knowledge Base ─────────────────────────────────────────────────────

export function useKnowledgeDocs(companyId: string | undefined) {
  return useQuery({
    queryKey: ["knowledge", companyId],
    queryFn: async () => unwrap<api.KnowledgeDocument[]>(await api.getKnowledgeDocs(companyId!)),
    enabled: !!companyId,
  });
}

export function useAddKnowledgeDoc(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { title: string; content: string; tags?: string[] }) =>
      api.addKnowledgeDoc(companyId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["knowledge", companyId] });
    },
  });
}

export function useDeleteKnowledgeDoc(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (docId: string) => api.deleteKnowledgeDoc(companyId, docId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["knowledge", companyId] });
    },
  });
}

export function useSearchKnowledge(companyId: string) {
  return useMutation({
    mutationFn: (query: string) => api.searchKnowledge(companyId, query),
  });
}

// ── Agent Memories ────────────────────────────────────────────────────

export function useAgentMemories(
  companyId: string | undefined,
  agentId: string | undefined,
) {
  return useQuery({
    queryKey: ["agent-memories", companyId, agentId],
    queryFn: async () =>
      unwrap<api.AgentMemory[]>(
        await api.getAgentMemories(companyId!, agentId!),
      ),
    enabled: !!companyId && !!agentId,
  });
}

export function useCreateAgentMemory(companyId: string, agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      content: string;
      memoryType?: string;
      importance?: number;
      tags?: string[];
    }) => api.createAgentMemory(companyId, agentId, data),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["agent-memories", companyId, agentId],
      });
    },
  });
}

export function useDeleteAgentMemory(companyId: string, agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (memoryId: string) =>
      api.deleteAgentMemory(companyId, agentId, memoryId),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["agent-memories", companyId, agentId],
      });
    },
  });
}

export function useClearAgentMemories(companyId: string, agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.clearAgentMemories(companyId, agentId),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["agent-memories", companyId, agentId],
      });
    },
  });
}

// ── Prompt Templates ──────────────────────────────────────────────────

export function usePromptTemplates(
  companyId: string | undefined,
  category?: string,
) {
  return useQuery({
    queryKey: ["prompt-templates", companyId, category],
    queryFn: async () =>
      unwrap<api.PromptTemplate[]>(
        await api.getPromptTemplates(companyId!, category),
      ),
    enabled: !!companyId,
  });
}

export function useCreatePromptTemplate(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof api.createPromptTemplate>[1]) =>
      api.createPromptTemplate(companyId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["prompt-templates", companyId] });
    },
  });
}

export function useUpdatePromptTemplate(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      templateId,
      data,
    }: {
      templateId: string;
      data: Parameters<typeof api.updatePromptTemplate>[2];
    }) => api.updatePromptTemplate(companyId, templateId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["prompt-templates", companyId] });
    },
  });
}

export function useDeletePromptTemplate(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (templateId: string) =>
      api.deletePromptTemplate(companyId, templateId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["prompt-templates", companyId] });
    },
  });
}

export function usePromptVersions(
  companyId: string | undefined,
  templateId: string | undefined,
) {
  return useQuery({
    queryKey: ["prompt-versions", companyId, templateId],
    queryFn: async () =>
      unwrap<api.PromptVersion[]>(
        await api.getPromptVersions(companyId!, templateId!),
      ),
    enabled: !!companyId && !!templateId,
  });
}

export function useApplyPromptToAgent(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      templateId,
      agentId,
      variables,
    }: {
      templateId: string;
      agentId: string;
      variables?: Record<string, string>;
    }) => api.applyPromptToAgent(companyId, templateId, agentId, variables),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agents", companyId] });
    },
  });
}

// ── Agent Evaluations & Performance ────────────────────────────────────

export function useCompanyEvaluations(companyId: string | undefined) {
  return useQuery({
    queryKey: ["evaluations", companyId],
    queryFn: async () =>
      unwrap<api.AgentEvaluation[]>(
        await api.getCompanyEvaluations(companyId!),
      ),
    enabled: !!companyId,
  });
}

export function useCompanyRankings(companyId: string | undefined) {
  return useQuery({
    queryKey: ["evaluations", companyId, "rankings"],
    queryFn: async () =>
      unwrap<api.AgentRanking[]>(
        await api.getCompanyRankings(companyId!),
      ),
    enabled: !!companyId,
  });
}

export function useAgentEvaluations(
  companyId: string | undefined,
  agentId: string | undefined,
) {
  return useQuery({
    queryKey: ["evaluations", companyId, "agent", agentId],
    queryFn: async () =>
      unwrap<api.AgentEvaluation[]>(
        await api.getAgentEvaluations(companyId!, agentId!),
      ),
    enabled: !!companyId && !!agentId,
  });
}

export function useAgentPerformance(
  companyId: string | undefined,
  agentId: string | undefined,
) {
  return useQuery({
    queryKey: ["evaluations", companyId, "agent", agentId, "performance"],
    queryFn: async () =>
      unwrap<api.AgentPerformance>(
        await api.getAgentPerformance(companyId!, agentId!),
      ),
    enabled: !!companyId && !!agentId,
  });
}

export function useCreateManualEvaluation(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      agentId,
      data,
    }: {
      agentId: string;
      data: {
        qualityScore: number;
        feedback: string;
        executionId?: string;
        taskId?: string;
      };
    }) => api.createManualEvaluation(companyId, agentId, data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["evaluations", companyId] });
      qc.invalidateQueries({
        queryKey: ["evaluations", companyId, "agent", vars.agentId],
      });
      qc.invalidateQueries({
        queryKey: ["evaluations", companyId, "agent", vars.agentId, "performance"],
      });
    },
  });
}

// ── MCP (Model Context Protocol) ────────────────────────────────────────

export function useMCPServers(companyId: string | undefined) {
  return useQuery({
    queryKey: ["mcp-servers", companyId],
    queryFn: async () =>
      unwrap<api.MCPServer[]>(await api.getMCPServers(companyId!)),
    enabled: !!companyId,
  });
}

export function useAddMCPServer(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof api.addMCPServer>[1]) =>
      api.addMCPServer(companyId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mcp-servers", companyId] });
      qc.invalidateQueries({ queryKey: ["mcp-tools", companyId] });
    },
  });
}

export function useDeleteMCPServer(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (serverId: string) => api.deleteMCPServer(companyId, serverId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mcp-servers", companyId] });
      qc.invalidateQueries({ queryKey: ["mcp-tools", companyId] });
    },
  });
}

export function useMCPTools(companyId: string | undefined) {
  return useQuery({
    queryKey: ["mcp-tools", companyId],
    queryFn: async () =>
      unwrap<api.MCPToolWithServer[]>(await api.getMCPTools(companyId!)),
    enabled: !!companyId,
  });
}

// ── Agent Collaborations ────────────────────────────────────────────────

export function useCollaborations(companyId: string | undefined) {
  return useQuery({
    queryKey: ["collaborations", companyId],
    queryFn: async () =>
      unwrap<api.AgentCollaboration[]>(
        await api.getCollaborations(companyId!),
      ),
    enabled: !!companyId,
    refetchInterval: 10_000,
  });
}

export function useAgentCollaborations(
  companyId: string | undefined,
  agentId: string | undefined,
) {
  return useQuery({
    queryKey: ["collaborations", companyId, "agent", agentId],
    queryFn: async () =>
      unwrap<api.AgentCollaboration[]>(
        await api.getAgentCollaborations(companyId!, agentId!),
      ),
    enabled: !!companyId && !!agentId,
  });
}

export function useCreateCollaboration(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof api.createCollaboration>[1]) =>
      api.createCollaboration(companyId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["collaborations", companyId] });
    },
  });
}

export function useRespondToCollaboration(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, responseContent }: { id: string; responseContent: string }) =>
      api.respondToCollaboration(companyId, id, responseContent),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["collaborations", companyId] });
    },
  });
}

// ── Company Templates ──────────────────────���────────────────────────────

export function useTemplates(category?: string) {
  return useQuery({
    queryKey: ["templates", category],
    queryFn: async () =>
      unwrap<api.CompanyTemplate[]>(await api.getTemplates(category)),
  });
}

export function useTemplate(id: string | undefined) {
  return useQuery({
    queryKey: ["templates", "detail", id],
    queryFn: async () =>
      unwrap<api.CompanyTemplate>(await api.getTemplate(id!)),
    enabled: !!id,
  });
}

export function useImportTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      templateId,
      overrides,
    }: {
      templateId: string;
      overrides?: { companyName?: string; budgetMultiplier?: number };
    }) => api.importTemplate(templateId, overrides),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["companies"] });
      qc.invalidateQueries({ queryKey: ["templates"] });
    },
  });
}

export function useExportCompany(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data?: { name?: string; description?: string; category?: string; tags?: string[] }) =>
      api.exportCompany(companyId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["templates"] });
    },
  });
}

// ── Inbox ───────────────────────────────────────────────────────────────

export function useInbox(companyId: string | undefined) {
  return useQuery({
    queryKey: ["inbox", companyId],
    queryFn: async () => {
      const res = await api.listInbox(companyId!);
      // listInbox returns the full envelope {data, meta}; don't unwrap
      return res as unknown as api.InboxResponse;
    },
    enabled: !!companyId,
    refetchInterval: 15_000,
  });
}

export function useMarkInboxRead(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemIds: string[]) => api.markInboxRead(companyId, itemIds),
    // Optimistically flip readAt so the UI stays responsive while the server
    // round-trips. On error we roll back from the cache snapshot.
    onMutate: async (itemIds: string[]) => {
      await qc.cancelQueries({ queryKey: ["inbox", companyId] });
      const prev = qc.getQueryData<api.InboxResponse>(["inbox", companyId]);
      if (prev) {
        const now = new Date().toISOString();
        const ids = new Set(itemIds);
        const next: api.InboxResponse = {
          ...prev,
          data: prev.data.map((i) =>
            ids.has(i.id) ? { ...i, readAt: i.readAt ?? now } : i,
          ),
          meta: {
            ...prev.meta,
            unread: prev.data.filter(
              (i) => !(ids.has(i.id) || i.readAt),
            ).length,
          },
        };
        qc.setQueryData(["inbox", companyId], next);
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["inbox", companyId], ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["inbox", companyId] });
    },
  });
}

export function useMarkInboxUnread(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemIds: string[]) => api.markInboxUnread(companyId, itemIds),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["inbox", companyId] });
    },
  });
}

// ── Approvals ───────────────────────────────────────────────────────────

export function useApprovals(
  companyId: string | undefined,
  status?: api.ApprovalStatus,
) {
  return useQuery({
    queryKey: ["approvals", companyId, status ?? "all"],
    queryFn: async () =>
      unwrap<api.Approval[]>(await api.listApprovals(companyId!, status)),
    enabled: !!companyId,
  });
}

export function useApproval(
  companyId: string | undefined,
  id: string | undefined,
) {
  return useQuery({
    queryKey: ["approvals", companyId, "detail", id],
    queryFn: async () =>
      unwrap<{ approval: api.Approval; comments: api.ApprovalComment[] }>(
        await api.getApproval(companyId!, id!),
      ),
    enabled: !!companyId && !!id,
  });
}

export function useCreateApproval(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof api.createApproval>[1]) =>
      api.createApproval(companyId, data),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["approvals", companyId] });
      const approval = unwrap<api.Approval>(data);
      if (approval.taskId) {
        qc.invalidateQueries({ queryKey: ["tasks", companyId, approval.taskId, "thread"] });
      }
    },
  });
}

export function useDecideApproval(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      id: string;
      decision: "approved" | "rejected";
      resolutionNote?: string;
    }) =>
      api.decideApproval(companyId, args.id, {
        decision: args.decision,
        resolutionNote: args.resolutionNote,
      }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["approvals", companyId] });
      const approval = unwrap<api.Approval>(data);
      if (approval.taskId) {
        qc.invalidateQueries({ queryKey: ["tasks", companyId, approval.taskId, "thread"] });
      }
    },
  });
}

export function useCancelApproval(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; resolutionNote?: string }) =>
      api.cancelApproval(companyId, args.id, args.resolutionNote),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["approvals", companyId] });
    },
  });
}

export function useAddApprovalComment(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; content: string }) =>
      api.addApprovalComment(companyId, args.id, args.content),
    onSuccess: (_data, args) => {
      qc.invalidateQueries({
        queryKey: ["approvals", companyId, "detail", args.id],
      });
    },
  });
}
