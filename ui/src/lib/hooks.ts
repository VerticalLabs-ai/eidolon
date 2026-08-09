// Eidolon hooks — v2 with projects, delete, toasts
import { useRef, useCallback, useState } from "react";
import {
  useQuery,
  useQueries,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import * as api from "./api";
import { useServerEvents } from "./ws";
import type { GoalFilters, TaskFilters, FileFilters } from "./api";

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

export function useProject(
  companyId: string | undefined,
  projectId: string | undefined,
) {
  return useQuery({
    queryKey: ["projects", companyId, projectId],
    queryFn: async () => unwrap<api.Project>(await api.getProject(companyId!, projectId!)),
    enabled: !!companyId && !!projectId,
  });
}

export function useCreateProject(companyId: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (data: api.CreateProjectInput) =>
      unwrap<api.Project>(await api.createProject(companyId, data)),
    onSuccess: (project) => {
      qc.setQueryData<api.Project[]>(["projects", companyId], (current) => [
        project,
        ...(current?.filter((item) => item.id !== project.id) ?? []),
      ]);
      qc.invalidateQueries({ queryKey: ["projects", companyId] });
    },
  });
}

export function useUpdateProject(companyId: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({
      projectId,
      data,
    }: {
      projectId: string;
      data: api.UpdateProjectInput;
    }) => unwrap<api.Project>(await api.updateProject(companyId, projectId, data)),
    onSuccess: (project) => {
      qc.setQueryData(["projects", companyId, project.id], project);
      qc.setQueryData<api.Project[]>(["projects", companyId], (current) =>
        current?.map((item) => item.id === project.id ? project : item),
      );
      qc.invalidateQueries({ queryKey: ["projects", companyId] });
      qc.invalidateQueries({ queryKey: ["projects", companyId, project.id] });
    },
  });
}

export function useArchiveProject(companyId: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ projectId }: { projectId: string }) =>
      unwrap<api.Project>(await api.archiveProject(companyId, projectId)),
    onSuccess: (project) => {
      qc.setQueryData(["projects", companyId, project.id], project);
      qc.setQueryData<api.Project[]>(["projects", companyId], (current) =>
        current?.map((item) => item.id === project.id ? project : item),
      );
      qc.invalidateQueries({ queryKey: ["projects", companyId] });
      qc.invalidateQueries({ queryKey: ["projects", companyId, project.id] });
    },
  });
}

// ── Project Home Summary ────────────────────────────────────────────────

export function useProjectHome(
  companyId: string | undefined,
  projectId: string | undefined,
) {
  return useQuery({
    queryKey: ["project-home", companyId, projectId],
    queryFn: async () =>
      unwrap<api.ProjectHomeSummary>(await api.getProjectHome(companyId!, projectId!)),
    enabled: !!companyId && !!projectId,
  });
}

// ── Project Threads ─────────────────────────────────────────────────────

export function useProjectThreads(
  companyId: string | undefined,
  projectId: string | undefined,
  filters?: api.ProjectThreadFilters,
) {
  return useQuery({
    queryKey: ["project-threads", companyId, projectId, filters],
    queryFn: async () =>
      unwrap<api.ProjectThread[]>(await api.getProjectThreads(companyId!, projectId!, filters)),
    enabled: !!companyId && !!projectId,
  });
}

export function useProjectThread(
  companyId: string | undefined,
  projectId: string | undefined,
  threadId: string | undefined,
) {
  return useQuery({
    queryKey: ["project-thread", companyId, projectId, threadId],
    queryFn: async () =>
      unwrap<api.ProjectThreadDetail>(
        await api.getProjectThread(companyId!, projectId!, threadId!),
      ),
    enabled: !!companyId && !!projectId && !!threadId,
  });
}

/**
 * Aggregate recent items across ALL active project threads (not just the
 * first one). Fetches the active thread list, then each thread's detail in
 * parallel via useQueries, and merges items sorted newest-first.
 */
export function useProjectThreadItems(
  companyId: string | undefined,
  projectId: string | undefined,
  filters?: api.ProjectThreadFilters,
) {
  const threads = useProjectThreads(companyId, projectId, filters ?? { status: "active" });
  const threadIds = threads.data?.map((t) => t.id) ?? [];
  const queries = useQueries({
    queries: threadIds.map((id) => ({
      queryKey: ["project-thread", companyId, projectId, id],
      queryFn: async () =>
        unwrap<api.ProjectThreadDetail>(
          await api.getProjectThread(companyId!, projectId!, id),
        ),
      enabled: !!companyId && !!projectId,
    })),
  });
  const isLoading = threads.isLoading || queries.some((q) => q.isLoading);
  const isError = threads.isError || queries.some((q) => q.isError);
  const items = queries
    .flatMap((q) => q.data?.items ?? [])
    .sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  return { data: items, threads: threads.data ?? [], isLoading, isError };
}

/**
 * Resolve a thread interaction item in any project thread. Unlike
 * useUpdateThreadItem, the target threadId is supplied per-call so items
 * aggregated from multiple threads can each be resolved against their own
 * thread.
 */
export function useResolveThreadItem(companyId: string, projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      threadId,
      itemId,
      data,
    }: {
      threadId: string;
      itemId: string;
      data: api.UpdateThreadItemInput;
    }) => api.updateThreadItem(companyId, projectId, threadId, itemId, data),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({
        queryKey: ["project-thread", companyId, projectId, vars.threadId],
      });
      qc.invalidateQueries({ queryKey: ["project-threads", companyId, projectId] });
    },
  });
}

export function useCreateProjectThread(companyId: string, projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: api.CreateProjectThreadInput) =>
      api.createProjectThread(companyId, projectId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-threads", companyId, projectId] });
    },
  });
}

export function useCreateThreadItem(companyId: string, projectId: string, threadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: api.CreateThreadItemInput) =>
      api.createThreadItem(companyId, projectId, threadId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-thread", companyId, projectId, threadId] });
      qc.invalidateQueries({ queryKey: ["project-threads", companyId, projectId] });
    },
  });
}

export function useUpdateThreadItem(companyId: string, projectId: string, threadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      itemId,
      data,
    }: {
      itemId: string;
      data: api.UpdateThreadItemInput;
    }) => api.updateThreadItem(companyId, projectId, threadId, itemId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-thread", companyId, projectId, threadId] });
    },
  });
}

// ── Mentions ───────────────────────────────────────────────────────────────

export function useMentionSearch(companyId: string | undefined, query: string) {
  return useQuery({
    queryKey: ["mention-search", companyId, query],
    queryFn: async () =>
      unwrap<api.MentionableEntity[]>(await api.searchMentions(companyId!, query)),
    enabled: !!companyId,
    staleTime: 10_000,
  });
}

// ── Project Plans ─────────────────────────────────────────────────────────

export function useProjectPlans(
  companyId: string | undefined,
  projectId: string | undefined,
  filters?: api.ProjectPlanFilters,
) {
  return useQuery({
    queryKey: ["project-plans", companyId, projectId, filters],
    queryFn: async () =>
      unwrap<api.ProjectPlan[]>(await api.getProjectPlans(companyId!, projectId!, filters)),
    enabled: !!companyId && !!projectId,
  });
}

export function useProjectPlan(
  companyId: string | undefined,
  projectId: string | undefined,
  planId: string | undefined,
) {
  return useQuery({
    queryKey: ["project-plan", companyId, projectId, planId],
    queryFn: async () =>
      unwrap<api.ProjectPlanDetail>(
        await api.getProjectPlan(companyId!, projectId!, planId!),
      ),
    enabled: !!companyId && !!projectId && !!planId,
  });
}

/**
 * Fetch plans (optionally filtered) and their full step lists in parallel.
 * Returns `ProjectPlanDetail[]` so consumers can render progress bars and
 * per-step status indicators without a second round-trip per plan.
 */
export function usePlansWithSteps(
  companyId: string | undefined,
  projectId: string | undefined,
  filters?: api.ProjectPlanFilters,
) {
  const plans = useProjectPlans(companyId, projectId, filters);
  const planIds = plans.data?.map((p) => p.id) ?? [];
  const queries = useQueries({
    queries: planIds.map((id) => ({
      queryKey: ["project-plan", companyId, projectId, id],
      queryFn: async () =>
        unwrap<api.ProjectPlanDetail>(
          await api.getProjectPlan(companyId!, projectId!, id),
        ),
      enabled: !!companyId && !!projectId,
    })),
  });
  const isLoading = plans.isLoading || queries.some((q) => q.isLoading);
  const isError = plans.isError || queries.some((q) => q.isError);
  const data = queries
    .map((q) => q.data)
    .filter((d): d is api.ProjectPlanDetail => !!d)
    .sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  return { data, isLoading, isError };
}

export function useCreateProjectPlan(companyId: string, projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: api.CreateProjectPlanInput) =>
      api.createProjectPlan(companyId, projectId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-plans", companyId, projectId] });
    },
  });
}

export function useUpdateProjectPlan(companyId: string, projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      planId,
      data,
    }: {
      planId: string;
      data: api.UpdateProjectPlanInput;
    }) => api.updateProjectPlan(companyId, projectId, planId, data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["project-plans", companyId, projectId] });
      qc.invalidateQueries({ queryKey: ["project-plan", companyId, projectId, vars.planId] });
    },
  });
}

export function useCreatePlanStep(companyId: string, projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      planId,
      data,
    }: {
      planId: string;
      data: api.CreatePlanStepInput;
    }) => api.createPlanStep(companyId, projectId, planId, data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["project-plans", companyId, projectId] });
      qc.invalidateQueries({ queryKey: ["project-plan", companyId, projectId, vars.planId] });
    },
  });
}

export function useUpdatePlanStep(companyId: string, projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      planId,
      stepId,
      data,
    }: {
      planId: string;
      stepId: string;
      data: api.UpdatePlanStepInput;
    }) => api.updatePlanStep(companyId, projectId, planId, stepId, data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["project-plans", companyId, projectId] });
      qc.invalidateQueries({ queryKey: ["project-plan", companyId, projectId, vars.planId] });
    },
  });
}

export function useAdvancePlanGate(companyId: string, projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ planId, stepId }: { planId: string; stepId: string }) =>
      api.advancePlanGate(companyId, projectId, planId, stepId),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["project-plans", companyId, projectId] });
      qc.invalidateQueries({ queryKey: ["project-plan", companyId, projectId, vars.planId] });
    },
  });
}

// ── Project Decisions ─────────────────────────────────────────────────────

export function useProjectDecisions(
  companyId: string | undefined,
  projectId: string | undefined,
  filters?: api.ProjectDecisionFilters,
) {
  return useQuery({
    queryKey: ["project-decisions", companyId, projectId, filters],
    queryFn: async () =>
      unwrap<api.ProjectDecision[]>(
        await api.getProjectDecisions(companyId!, projectId!, filters),
      ),
    enabled: !!companyId && !!projectId,
  });
}

export function useCreateProjectDecision(companyId: string, projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: api.CreateProjectDecisionInput) =>
      api.createProjectDecision(companyId, projectId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-decisions", companyId, projectId] });
    },
  });
}

export function useUpdateProjectDecision(companyId: string, projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      decisionId,
      data,
    }: {
      decisionId: string;
      data: api.UpdateProjectDecisionInput;
    }) => api.updateProjectDecision(companyId, projectId, decisionId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-decisions", companyId, projectId] });
    },
  });
}

// ── Project Outcomes ──────────────────────────────────────────────────────

export function useProjectOutcomes(
  companyId: string | undefined,
  projectId: string | undefined,
  filters?: api.ProjectOutcomeFilters,
) {
  return useQuery({
    queryKey: ["project-outcomes", companyId, projectId, filters],
    queryFn: async () =>
      unwrap<api.ProjectOutcome[]>(
        await api.getProjectOutcomes(companyId!, projectId!, filters),
      ),
    enabled: !!companyId && !!projectId,
  });
}

export function useCreateProjectOutcome(companyId: string, projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: api.CreateProjectOutcomeInput) =>
      api.createProjectOutcome(companyId, projectId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-outcomes", companyId, projectId] });
    },
  });
}

export function useUpdateProjectOutcome(companyId: string, projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      outcomeId,
      data,
    }: {
      outcomeId: string;
      data: api.UpdateProjectOutcomeInput;
    }) => api.updateProjectOutcome(companyId, projectId, outcomeId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-outcomes", companyId, projectId] });
    },
  });
}

// ── Project Work (composed endpoint) ──────────────────────────────────────

export function useProjectWork(
  companyId: string | undefined,
  projectId: string | undefined,
) {
  return useQuery({
    queryKey: ["project-work", companyId, projectId],
    queryFn: async () =>
      unwrap<api.ProjectWorkSummary>(await api.getProjectWork(companyId!, projectId!)),
    enabled: !!companyId && !!projectId,
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

/**
 * Reverse task→meeting backlink (VAL-MEETING-006/007): meetings that
 * originated a task via the meeting_tasks join table.
 */
export function useTaskMeetings(companyId: string | undefined, taskId: string | undefined) {
  return useQuery({
    queryKey: ["tasks", companyId, taskId, "meetings"],
    queryFn: async () => unwrap<api.Meeting[]>(await api.getTaskMeetings(companyId!, taskId!)),
    enabled: !!companyId && !!taskId,
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
    mutationFn: async (args: { taskId: string; content: string; idempotencyKey: string }) => {
      const created = unwrap<api.TaskThreadItem>(
        await api.addTaskComment(companyId, args.taskId, args.content, args.idempotencyKey),
      );
      const thread = unwrap<api.TaskThreadItem[]>(
        await api.getTaskThread(companyId, args.taskId),
      );
      if (thread.filter((item) => item.id === created.id).length !== 1) {
        throw new Error(
          "Comment reached the server but could not be confirmed. Your draft is still here; retry after reloading the thread.",
        );
      }
      return thread;
    },
    onSuccess: (thread, args) => {
      qc.setQueryData(["tasks", companyId, args.taskId, "thread"], thread);
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

export function useGoals(companyId: string | undefined, filters?: GoalFilters) {
  return useQuery({
    queryKey: ["goals", companyId, filters],
    queryFn: async () => unwrap<api.Goal[]>(await api.getGoals(companyId!, filters)),
    enabled: !!companyId,
  });
}

export function useGoalTree(companyId: string | undefined, filters?: GoalFilters) {
  return useGoals(companyId, filters);
}

export function useCreateGoal(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: api.CreateGoalInput) =>
      unwrap<api.Goal>(await api.createGoal(companyId, data)),
    onSuccess: (goal) => {
      qc.invalidateQueries({ queryKey: ["goals", companyId] });
    },
  });
}

export function useUpdateGoal(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ goalId, data }: { goalId: string; data: api.UpdateGoalInput }) =>
      unwrap<api.Goal>(await api.updateGoal(companyId, goalId, data)),
    onSuccess: (goal) => {
      qc.invalidateQueries({ queryKey: ["goals", companyId] });
    },
  });
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

export function useProjectActivity(
  companyId: string | undefined,
  projectId: string | undefined,
  limit: number,
  offset: number,
) {
  return useQuery({
    queryKey: ["activity", companyId, "project", projectId, limit, offset],
    queryFn: () => api.getProjectActivity(companyId!, projectId!, limit, offset),
    enabled: !!companyId && !!projectId,
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
    mutationFn: (data: {
      content: string;
      targetAgentId?: string;
      threadId?: string;
      mentions?: Array<{ entityType: "agent" | "user"; entityId: string; label: string }>;
    }) => api.sendChatMessage(companyId, data),
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

export function useFiles(
  companyId: string | undefined,
  agentId?: string,
  filters?: FileFilters,
) {
  return useQuery({
    queryKey: ["files", companyId, agentId ?? null, filters ?? null],
    queryFn: async () =>
      unwrap<api.AgentFile[]>(await api.getFiles(companyId!, agentId, filters)),
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
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (integrationId: string) =>
      unwrap<api.TestIntegrationResult>(
        await api.testIntegration(companyId, integrationId),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["integrations", companyId] });
      qc.invalidateQueries({ queryKey: ["unified-health", companyId] });
      qc.invalidateQueries({ queryKey: ["project-home", companyId] });
    },
  });
}

// ── Automation Runs ────────────────────────────────────────────────────

export function useAutomationRuns(
  companyId: string | undefined,
  filters?: api.AutomationRunFilters,
) {
  return useQuery({
    queryKey: ["automation-runs", companyId, filters],
    queryFn: async () =>
      unwrap<api.AutomationRun[]>(await api.getAutomationRuns(companyId!, filters)),
    enabled: !!companyId,
  });
}

// ── Unified Health Surface ─────────────────────────────────────────────

export function useUnifiedHealth(
  companyId: string | undefined,
  projectId?: string,
) {
  return useQuery({
    queryKey: ["unified-health", companyId, projectId ?? null],
    queryFn: async () =>
      unwrap<api.UnifiedHealthEntry[]>(
        await api.getUnifiedHealth(companyId!, projectId),
      ),
    enabled: !!companyId,
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

// ── Hybrid Jarvis Runtime ──────────────────────────────────────────────

export function useRuntimeAdapters() {
  return useQuery({
    queryKey: ["runtime-adapters"],
    queryFn: async () =>
      unwrap<api.RuntimeAdapterDescriptor[]>(await api.getRuntimeAdapters()),
    staleTime: 5 * 60_000,
  });
}

export function useRefreshAgentModels(companyId: string, agentId: string) {
  return useMutation({
    mutationFn: async () => ({
      ...unwrap<api.AdapterModelDiscoveryResult>(
        await api.refreshAgentModels(companyId, agentId),
      ),
      agentId,
    }),
  });
}

export function useRuntimeSessions(companyId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["runtime-sessions", companyId],
    queryFn: async () =>
      unwrap<api.RuntimeSession[]>(await api.getRuntimeSessions(companyId!)),
    enabled: enabled && !!companyId,
    refetchInterval: 10_000,
  });
}

export function useCreateRuntimeSession(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof api.createRuntimeSession>[1]) =>
      api.createRuntimeSession(companyId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["runtime-sessions", companyId] });
      qc.invalidateQueries({ queryKey: ["agents", companyId] });
    },
  });
}

export function useTestRuntimeSession(companyId: string) {
  return useMutation({
    mutationFn: async (sessionId: string) =>
      unwrap<api.RuntimeAdapterDiagnostic>(
        await api.testRuntimeSession(companyId, sessionId),
      ),
  });
}

export function useRunRuntimeSession(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { sessionId: string; prompt: string }) =>
      unwrap<api.RuntimeSession>(
        await api.runRuntimeSession(companyId, args.sessionId, args.prompt),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["runtime-sessions", companyId] });
      qc.invalidateQueries({ queryKey: ["agents", companyId] });
      qc.invalidateQueries({ queryKey: ["tasks", companyId] });
    },
  });
}

export function useCancelRuntimeSession(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { sessionId: string; reason?: string }) =>
      api.cancelRuntimeSession(companyId, args.sessionId, args.reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["runtime-sessions", companyId] });
    },
  });
}

export function useFinalizeRuntimeSession(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      api.finalizeRuntimeSession(companyId, sessionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["runtime-sessions", companyId] });
    },
  });
}

export function useWakeAgent(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) => api.wakeAgent(companyId, agentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agents", companyId] });
      qc.invalidateQueries({ queryKey: ["tasks", companyId] });
      qc.invalidateQueries({ queryKey: ["dashboard", companyId] });
    },
  });
}

export function useCompanySkills(companyId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["company-skills", companyId],
    queryFn: async () =>
      unwrap<api.CompanySkill[]>(await api.getCompanySkills(companyId!)),
    enabled: enabled && !!companyId,
  });
}

export function useInstallCompanySkill(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof api.installCompanySkill>[1]) =>
      api.installCompanySkill(companyId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["company-skills", companyId] });
      qc.invalidateQueries({ queryKey: ["agents", companyId] });
    },
  });
}

export function useJarvisRoutines(companyId: string | undefined) {
  return useQuery({
    queryKey: ["jarvis-routines", companyId],
    queryFn: async () =>
      unwrap<api.JarvisRoutine[]>(await api.getJarvisRoutines(companyId!)),
    enabled: !!companyId,
  });
}

export function useCreateJarvisRoutine(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof api.createJarvisRoutine>[1]) =>
      api.createJarvisRoutine(companyId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jarvis-routines", companyId] });
    },
  });
}

export function useTriggerJarvisRoutine(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (routineId: string) =>
      unwrap<api.JarvisRoutineTriggerResult>(
        await api.triggerJarvisRoutine(companyId, routineId),
      ),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["jarvis-routines", companyId] });
      qc.invalidateQueries({ queryKey: ["runtime-sessions", companyId] });
      qc.invalidateQueries({ queryKey: ["tasks", companyId] });
      qc.invalidateQueries({ queryKey: ["tasks", companyId, result.task.id, "thread"] });
    },
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

export function useUpdateTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: Parameters<typeof api.updateTemplate>[1];
    }) => api.updateTemplate(id, data),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["templates"] });
      qc.invalidateQueries({ queryKey: ["templates", "detail", vars.id] });
    },
  });
}

export function useDeleteTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteTemplate(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["templates"] });
    },
  });
}

export function useExportCompany(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data?: { name?: string; description?: string; category?: string; tags?: string[]; version?: string }) =>
      api.exportCompany(companyId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["templates"] });
    },
  });
}

export function useUpdateTemplateFromCompany(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      templateId,
      data,
    }: {
      templateId: string;
      data?: Parameters<typeof api.updateTemplateFromCompany>[2];
    }) => api.updateTemplateFromCompany(companyId, templateId, data),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["templates"] });
      qc.invalidateQueries({ queryKey: ["templates", "detail", vars.templateId] });
    },
  });
}

// ── Project Templates (M4) ──────────────────────────────────────────────

export function useProjectTemplates(companyId: string | undefined) {
  return useQuery({
    queryKey: ["project-templates", companyId],
    queryFn: async () =>
      unwrap<api.ProjectTemplate[]>(
        await api.listProjectTemplates(companyId!),
      ),
    enabled: !!companyId,
  });
}

export function useSaveProjectTemplate(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { projectId: string; name: string; description?: string | null }) =>
      api.saveProjectTemplate(companyId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-templates", companyId] });
    },
  });
}

export function useDeleteProjectTemplate(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteProjectTemplate(companyId, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-templates", companyId] });
    },
  });
}

export function useCreateProjectFromTemplate(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      templateId,
      data,
    }: {
      templateId: string;
      data: { name?: string; description?: string | null; idempotencyKey?: string };
    }) => api.createProjectFromTemplate(companyId, templateId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects", companyId] });
      qc.invalidateQueries({ queryKey: ["project-templates", companyId] });
    },
  });
}

// ── Artifact Templates (M4) ─────────────────────────────────────────────

export function useArtifactTemplates(
  companyId: string | undefined,
  type?: api.ArtifactType,
) {
  return useQuery({
    queryKey: ["artifact-templates", companyId, type],
    queryFn: async () =>
      unwrap<api.ArtifactTemplate[]>(
        await api.listArtifactTemplates(companyId!, type),
      ),
    enabled: !!companyId,
  });
}

export function useSaveArtifactTemplate(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { artifactId: string; name: string; description?: string | null }) =>
      api.saveArtifactTemplate(companyId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["artifact-templates", companyId] });
    },
  });
}

export function useDeleteArtifactTemplate(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteArtifactTemplate(companyId, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["artifact-templates", companyId] });
    },
  });
}

export function useCreateArtifactFromTemplate(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      templateId,
      data,
    }: {
      templateId: string;
      data: { projectId?: string | null; folderId?: string | null; title?: string };
    }) => api.createArtifactFromTemplate(companyId, templateId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["artifacts", companyId] });
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

// ── Artifacts ────────────────────────────────────────────────────────────

export function useArtifacts(
  companyId: string | undefined,
  params?: api.ArtifactListParams,
) {
  return useQuery({
    queryKey: ["artifacts", companyId, params ?? {}],
    queryFn: async () => {
      const res = await api.listArtifacts(companyId!, params);
      const body = res as unknown as { data: api.Artifact[]; meta: api.ArtifactListMeta };
      return {
        rows: body.data,
        meta: body.meta,
      };
    },
    enabled: !!companyId,
  });
}

export function useProjectArtifacts(
  companyId: string | undefined,
  projectId: string | undefined,
) {
  return useQuery({
    queryKey: ["artifacts", companyId, "project", projectId],
    queryFn: async () => {
      const res = await api.listProjectArtifacts(companyId!, projectId!);
      const body = res as unknown as { data: api.Artifact[] };
      return body.data;
    },
    enabled: !!companyId && !!projectId,
  });
}

export function useArtifact(
  companyId: string | undefined,
  id: string | undefined,
) {
  return useQuery({
    queryKey: ["artifacts", companyId, id],
    queryFn: async () => {
      const res = await api.getArtifact(companyId!, id!);
      return unwrap<api.Artifact>(res);
    },
    enabled: !!companyId && !!id,
  });
}

export function useCreateArtifact(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof api.createArtifact>[1]) =>
      api.createArtifact(companyId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["artifacts", companyId] });
    },
  });
}

export function useUpdateArtifact(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      id: string;
      version: number;
      title?: string;
      content?: Record<string, unknown>;
      message?: string;
    }) =>
      api.updateArtifact(companyId, args.id, {
        version: args.version,
        title: args.title,
        content: args.content,
        message: args.message,
      }),
    onSuccess: (_data, args) => {
      qc.invalidateQueries({ queryKey: ["artifacts", companyId] });
      qc.invalidateQueries({ queryKey: ["artifacts", companyId, args.id] });
      qc.invalidateQueries({
        queryKey: ["artifacts", companyId, args.id, "revisions"],
      });
    },
  });
}

export function useDeleteArtifact(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteArtifact(companyId, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["artifacts", companyId] });
    },
  });
}

export function useArchiveArtifact(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.archiveArtifact(companyId, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["artifacts", companyId] });
    },
  });
}

export function useRestoreArtifact(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.restoreArtifact(companyId, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["artifacts", companyId] });
    },
  });
}

export function useArtifactRevisions(
  companyId: string | undefined,
  id: string | undefined,
) {
  return useQuery({
    queryKey: ["artifacts", companyId, id, "revisions"],
    queryFn: async () => {
      const res = await api.listRevisions(companyId!, id!);
      return unwrap<api.ArtifactRevision[]>(res);
    },
    enabled: !!companyId && !!id,
  });
}

export function useRestoreRevision(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; version: number }) =>
      api.restoreRevision(companyId, args.id, args.version),
    onSuccess: (_data, args) => {
      qc.invalidateQueries({ queryKey: ["artifacts", companyId] });
      qc.invalidateQueries({ queryKey: ["artifacts", companyId, args.id] });
      qc.invalidateQueries({
        queryKey: ["artifacts", companyId, args.id, "revisions"],
      });
    },
  });
}

// Code artifact run (M6) — bounded sandboxed execution. The mutation returns
// the run result (stdout/stderr/exit code); callers render it in the output
// panel. No query cache invalidation: running does not mutate the artifact.
export function useRunCode(companyId: string) {
  return useMutation({
    mutationFn: (artifactId: string) => api.runCodeArtifact(companyId, artifactId),
  });
}

// ── Artifact Folders (M4) ───────────────────────────────────────────────

export function useFolders(
  companyId: string | undefined,
  projectId?: string | null,
) {
  return useQuery({
    queryKey: ["folders", companyId, projectId ?? undefined],
    queryFn: async () => {
      const res = await api.listFolders(companyId!, projectId);
      const body = res as unknown as { data: api.ArtifactFolder[] };
      return body.data;
    },
    enabled: !!companyId,
  });
}

export function useCreateFolder(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof api.createFolder>[1]) =>
      api.createFolder(companyId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["folders", companyId] });
    },
  });
}

export function useUpdateFolder(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      id: string;
      name?: string;
      parentId?: string | null;
    }) => api.updateFolder(companyId, args.id, args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["folders", companyId] });
    },
  });
}

export function useDeleteFolder(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteFolder(companyId, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["folders", companyId] });
      qc.invalidateQueries({ queryKey: ["artifacts", companyId] });
    },
  });
}

export function useMoveArtifactToFolder(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { artifactId: string; folderId: string | null }) =>
      api.moveArtifactToFolder(companyId, args.artifactId, args.folderId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["artifacts", companyId] });
    },
  });
}

// ── Presence (M3) ───────────────────────────────────────────────────────
//
// Presence is ephemeral realtime state. The hooks below provide:
//  - useArtifactPresence: a query seeded by GET + live-patched by WS events
//    (presence.join/leave/typing) so indicators appear/clear without reload.
//  - usePresenceActions: fire-and-forget join/leave/typing mutations + a
//    heartbeat refresher. The caller joins on mount and leaves on unmount.
//  - useProjectPresence: aggregated presence across artifact types in a
//    project (VAL-CROSS-014), also live-patched by WS events.

export function useArtifactPresence(
  companyId: string | undefined,
  artifactId: string | undefined,
) {
  const qc = useQueryClient();
  const queryKey = ["presence", companyId, artifactId];

  // Live-patch the cached presence list from WS events.
  useServerEvents(companyId, "presence.join", (event) => {
    const payload = event.payload as { artifactId?: string; userId?: string; name?: string };
    if (!artifactId || payload?.artifactId !== artifactId) return;
    qc.setQueryData<api.PresenceEntry[]>(queryKey, (old) => {
      const next = old ?? [];
      if (next.some((p) => p.userId === payload.userId)) return next;
      return [...next, { userId: payload.userId!, name: payload.name!, typing: false }];
    });
  });

  useServerEvents(companyId, "presence.leave", (event) => {
    const payload = event.payload as { artifactId?: string; userId?: string };
    if (!artifactId || payload?.artifactId !== artifactId) return;
    qc.setQueryData<api.PresenceEntry[]>(queryKey, (old) => {
      if (!old) return old;
      return old.filter((p) => p.userId !== payload.userId);
    });
  });

  useServerEvents(companyId, "presence.typing", (event) => {
    const payload = event.payload as { artifactId?: string; userId?: string; typing?: boolean };
    if (!artifactId || payload?.artifactId !== artifactId) return;
    qc.setQueryData<api.PresenceEntry[]>(queryKey, (old) => {
      if (!old) return old;
      return old.map((p) =>
        p.userId === payload.userId ? { ...p, typing: payload.typing ?? false } : p,
      );
    });
  });

  return useQuery({
    queryKey,
    queryFn: async () => {
      const res = await api.getArtifactPresence(companyId!, artifactId!);
      const body = res as unknown as { data: { presence: api.PresenceEntry[] } };
      return body.data.presence;
    },
    enabled: !!companyId && !!artifactId,
    // Presence is realtime; don't refetch aggressively — WS events keep it fresh.
    staleTime: 30_000,
  });
}

export function useProjectPresence(
  companyId: string | undefined,
  projectId: string | undefined,
) {
  const qc = useQueryClient();
  const queryKey = ["presence", "project", companyId, projectId];

  // Live-patch: any presence.join/leave re-invalidates the aggregated list so
  // the project-level indicator updates without reload.
  const invalidate = () => {
    if (!projectId) return;
    qc.invalidateQueries({ queryKey });
  };
  useServerEvents(companyId, "presence.join", invalidate);
  useServerEvents(companyId, "presence.leave", invalidate);

  return useQuery({
    queryKey,
    queryFn: async () => {
      const res = await api.getProjectPresence(companyId!, projectId!);
      const body = res as unknown as { data: { presence: api.ProjectPresenceEntry[] } };
      return body.data.presence;
    },
    enabled: !!companyId && !!projectId,
    staleTime: 10_000,
  });
}

/**
 * Presence actions for an artifact editor. Callers should join on mount and
 * leave on unmount. `notifyTyping` debounces typing notifications and sends
 * a clear after a short idle window. Returns a cleanup function for unmount.
 */
export function usePresenceActions(
  companyId: string | undefined,
  artifactId: string | undefined,
) {
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);
  const [selfUserId, setSelfUserId] = useState<string | undefined>(undefined);

  const join = useCallback(async () => {
    if (!companyId || !artifactId) return;
    try {
      const res = await api.joinPresence(companyId, artifactId);
      const body = res as unknown as { data: { userId: string } };
      setSelfUserId(body.data.userId);
    } catch {
      /* presence is best-effort */
    }
    // Heartbeat to keep the session alive (refreshes lastActiveAt).
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    heartbeatRef.current = setInterval(async () => {
      try {
        await api.joinPresence(companyId, artifactId);
      } catch {
        /* ignore */
      }
    }, 30_000);
  }, [companyId, artifactId]);

  const leave = useCallback(async () => {
    if (!companyId || !artifactId) return;
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    if (typingTimerRef.current) {
      clearTimeout(typingTimerRef.current);
      typingTimerRef.current = null;
    }
    isTypingRef.current = false;
    try {
      await api.leavePresence(companyId, artifactId);
    } catch {
      /* presence is best-effort */
    }
  }, [companyId, artifactId]);

  /** Notify that the user is typing. Debounced; auto-clears after idle. */
  const notifyTyping = useCallback(async () => {
    if (!companyId || !artifactId) return;
    // Reset the idle-clear timer on each keystroke.
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    if (!isTypingRef.current) {
      isTypingRef.current = true;
      try {
        await api.setTypingPresence(companyId, artifactId, true);
      } catch {
        /* ignore */
      }
    }
    typingTimerRef.current = setTimeout(async () => {
      isTypingRef.current = false;
      try {
        await api.setTypingPresence(companyId, artifactId, false);
      } catch {
        /* ignore */
      }
    }, 2_500);
  }, [companyId, artifactId]);

  return { join, leave, notifyTyping, selfUserId };
}

// ── Teams + Permissions (M4 RBAC) ───────────────────────────────────────

export function useTeams(companyId: string | undefined) {
  return useQuery({
    queryKey: ["teams", companyId],
    queryFn: async () => unwrap<api.Team[]>(await api.getTeams(companyId!)),
    enabled: !!companyId,
  });
}

export function useCreateTeam(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => unwrap<api.Team>(await api.createTeam(companyId, name)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["teams", companyId] }),
  });
}

export function useDeleteTeam(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (teamId: string) => api.deleteTeam(companyId, teamId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["teams", companyId] }),
  });
}

export function useTeamMembers(companyId: string | undefined, teamId: string | undefined) {
  return useQuery({
    queryKey: ["teams", companyId, teamId, "members"],
    queryFn: async () => unwrap<api.TeamMember[]>(await api.getTeamMembers(companyId!, teamId!)),
    enabled: !!companyId && !!teamId,
  });
}

export function useAddTeamMember(companyId: string, teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => unwrap<api.TeamMember>(await api.addTeamMember(companyId, teamId, userId)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["teams", companyId, teamId, "members"] });
      qc.invalidateQueries({ queryKey: ["teams", companyId] });
    },
  });
}

export function useRemoveTeamMember(companyId: string, teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => api.removeTeamMember(companyId, teamId, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["teams", companyId, teamId, "members"] });
      qc.invalidateQueries({ queryKey: ["teams", companyId] });
    },
  });
}

export function usePermissions(
  companyId: string | undefined,
  resourceType: api.PermissionResourceType | undefined,
  resourceId: string | undefined,
) {
  return useQuery({
    queryKey: ["permissions", companyId, resourceType, resourceId],
    queryFn: async () => unwrap<api.PermissionRecord[]>(await api.getPermissions(companyId!, resourceType!, resourceId!)),
    enabled: !!companyId && !!resourceType && !!resourceId,
  });
}

export function useGrantPermission(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      resourceType: api.PermissionResourceType;
      resourceId: string;
      granteeType: api.GranteeType;
      granteeId: string;
      accessLevel: api.AccessLevel;
    }) => unwrap<api.PermissionRecord>(await api.grantPermission(companyId, data)),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["permissions", companyId, variables.resourceType, variables.resourceId] });
      qc.invalidateQueries({ queryKey: ["artifacts", companyId] });
    },
  });
}

export function useRevokePermission(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      resourceType: api.PermissionResourceType;
      resourceId: string;
      granteeType: api.GranteeType;
      granteeId: string;
      accessLevel: api.AccessLevel;
    }) => api.revokePermission(companyId, data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["permissions", companyId, variables.resourceType, variables.resourceId] });
      qc.invalidateQueries({ queryKey: ["artifacts", companyId] });
    },
  });
}

export function useResolvePermission(
  companyId: string | undefined,
  resourceType: api.PermissionResourceType | undefined,
  resourceId: string | undefined,
) {
  return useQuery({
    queryKey: ["permissions", companyId, "resolve", resourceType, resourceId],
    queryFn: async () => unwrap<{ accessLevel: api.AccessLevel | null }>(await api.resolvePermission(companyId!, resourceType!, resourceId!)),
    enabled: !!companyId && !!resourceType && !!resourceId,
  });
}
