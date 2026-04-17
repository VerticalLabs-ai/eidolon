import { useState, useEffect, useCallback, useMemo } from "react";
import { useParams, Link, useLocation } from "react-router-dom";
import {
  ArrowLeft,
  Bot,
  Briefcase,
  Settings,
  Cpu,
  DollarSign,
  Zap,
  CheckCircle2,
  FileText,
  History,
  Play,
  Save,
  Eye,
  EyeOff,
  Clock,
  ToggleLeft,
  ToggleRight,
  AlertCircle,
  Terminal,
  ChevronRight,
} from "lucide-react";
import {
  useAgent,
  useAgents,
  useTasks,
  useUpdateAgent,
  useAgentInstructions,
  useUpdateAgentInstructions,
  useAgentRevisions,
  useAgentExecutions,
} from "@/lib/hooks";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { StatusIndicator } from "@/components/ui/StatusIndicator";
import { BudgetGauge } from "@/components/dashboard/BudgetGauge";
import { TaskCard } from "@/components/tasks/TaskCard";
import {
  PROVIDER_OPTIONS,
  getModelOptions,
  normalizeProvider,
} from "@/lib/ai-catalog";
import { TranscriptView } from "@/components/agents/TranscriptView";
import { clsx } from "clsx";

const INSTRUCTION_TEMPLATES: Record<string, string> = {
  engineering: `# Engineering Agent Instructions

You are a senior software engineer. Your responsibilities include:

- Writing clean, well-tested code
- Reviewing pull requests thoroughly
- Breaking down technical tasks into subtasks
- Following established coding patterns and conventions
- Documenting technical decisions

## Guidelines
- Prefer readability over cleverness
- Write tests for all new functionality
- Keep PRs small and focused
`,
  marketing: `# Marketing Agent Instructions

You are a marketing strategist. Your responsibilities include:

- Creating compelling content and copy
- Analyzing marketing metrics and KPIs
- Managing social media presence
- Developing campaign strategies
- A/B testing messaging and creative

## Guidelines
- Always tie activities back to business goals
- Use data to inform decisions
- Maintain brand voice consistency
`,
  sales: `# Sales Agent Instructions

You are a sales representative. Your responsibilities include:

- Qualifying and nurturing leads
- Managing the sales pipeline
- Creating proposals and presentations
- Following up with prospects
- Reporting on sales metrics

## Guidelines
- Focus on understanding customer needs
- Be responsive and follow up promptly
- Track all interactions in the CRM
`,
  operations: `# Operations Agent Instructions

You are an operations manager. Your responsibilities include:

- Optimizing workflows and processes
- Managing resources and capacity
- Monitoring system health and performance
- Coordinating cross-team initiatives
- Maintaining documentation

## Guidelines
- Prioritize reliability and efficiency
- Automate repetitive tasks
- Document all processes
`,
  design: `# Design Agent Instructions

You are a product designer. Your responsibilities include:

- Creating user interfaces and experiences
- Conducting design research
- Building and maintaining design systems
- Prototyping and testing designs
- Collaborating with engineering

## Guidelines
- Start with user needs
- Follow accessibility best practices
- Iterate based on feedback
`,
  research: `# Research Agent Instructions

You are a research analyst. Your responsibilities include:

- Conducting market and competitive research
- Analyzing data and identifying trends
- Creating reports and presentations
- Testing hypotheses with data
- Providing actionable recommendations

## Guidelines
- Be thorough and objective
- Cite sources and methodology
- Present findings clearly
`,
  finance: `# Finance Agent Instructions

You are a finance analyst. Your responsibilities include:

- Tracking budgets and expenditures
- Creating financial forecasts
- Analyzing cost-benefit of initiatives
- Generating financial reports
- Identifying cost optimization opportunities

## Guidelines
- Be precise with numbers
- Flag risks proactively
- Maintain audit trails
`,
};

// ── Tab definitions ─────────────────────────────────────────────────────

const tabs = [
  { id: "overview", label: "Overview", icon: Bot },
  { id: "config", label: "Configuration", icon: Settings },
  { id: "instructions", label: "Instructions", icon: FileText },
  { id: "history", label: "History", icon: History },
  { id: "tasks", label: "Tasks", icon: Briefcase },
  { id: "executions", label: "Executions", icon: Terminal },
] as const;

type Tab = (typeof tabs)[number]["id"];

// ── Main Component ──────────────────────────────────────────────────────

export function AgentDetail() {
  const { companyId, agentId } = useParams();
  const location = useLocation();
  const { data: agent, isLoading } = useAgent(companyId, agentId);
  const { data: agents } = useAgents(companyId);
  const { data: tasks } = useTasks(companyId);
  const updateAgent = useUpdateAgent(companyId!);

  // Derive active tab from URL hash
  const hashTab = location.hash.replace("#", "") as Tab;
  const validTabs = tabs.map((t) => t.id);
  const [activeTab, setActiveTab] = useState<Tab>(
    validTabs.includes(hashTab) ? hashTab : "overview",
  );

  useEffect(() => {
    const h = location.hash.replace("#", "") as Tab;
    if (validTabs.includes(h)) setActiveTab(h);
  }, [location.hash]);

  const handleTabChange = useCallback(
    (tab: Tab) => {
      setActiveTab(tab);
      window.history.replaceState(null, "", `#${tab}`);
    },
    [],
  );

  const agentTasks = useMemo(
    () => (tasks ?? []).filter((t) => t.assigneeAgentId === agentId),
    [tasks, agentId],
  );

  if (isLoading) {
    return (
      <div className="mx-auto max-w-5xl p-6 lg:p-8">
        <div className="h-64 animate-pulse rounded-xl glass" />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-text-secondary">
        Agent not found
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl p-6 lg:p-8 space-y-8">
      {/* Back link */}
      <Link
        to={`/company/${companyId}/agents`}
        className="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-neon-cyan transition-colors duration-200"
      >
        <ArrowLeft className="h-4 w-4" />
        All Agents
      </Link>

      {/* Agent header */}
      <div className="glass rounded-xl p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-center gap-5">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-neon-cyan/10 glow-cyan">
              <Bot className="h-8 w-8 text-neon-cyan" />
            </div>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="font-display text-2xl font-bold text-text-primary">
                  {agent.name}
                </h1>
                <StatusIndicator
                  status={agent.status === "working" ? "connected" : "disconnected"}
                  label={agent.status}
                />
              </div>
              <p className="text-sm text-text-secondary mt-1">{agent.title}</p>
              <div className="flex items-center gap-2 mt-2">
                <Badge variant="info">{agent.role}</Badge>
                <span className="text-xs text-text-secondary font-mono glass-raised px-2 py-0.5 rounded">
                  {agent.provider}/{agent.model}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-white/[0.06] overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => handleTabChange(tab.id)}
            className={clsx(
              "flex items-center gap-2 whitespace-nowrap px-5 py-3 text-sm font-medium transition-all duration-200 border-b-2 -mb-px cursor-pointer",
              activeTab === tab.id
                ? "border-neon-cyan text-neon-cyan text-glow-cyan"
                : "border-transparent text-text-secondary hover:text-text-primary",
            )}
          >
            <tab.icon className="h-4 w-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "overview" && (
        <OverviewTab agent={agent} agentTasks={agentTasks} companyId={companyId!} agents={agents} />
      )}
      {activeTab === "config" && (
        <ConfigTab agent={agent} companyId={companyId!} updateAgent={updateAgent} agents={agents} />
      )}
      {activeTab === "instructions" && (
        <InstructionsTab agent={agent} companyId={companyId!} />
      )}
      {activeTab === "history" && (
        <HistoryTab companyId={companyId!} agentId={agentId!} />
      )}
      {activeTab === "tasks" && (
        <TasksTab agentTasks={agentTasks} companyId={companyId!} />
      )}
      {activeTab === "executions" && (
        <ExecutionsTab companyId={companyId!} agentId={agentId!} />
      )}
    </div>
  );
}

// ── Overview Tab ────────────────────────────────────────────────────────

function OverviewTab({
  agent,
  agentTasks,
  companyId,
  agents,
}: {
  agent: NonNullable<ReturnType<typeof useAgent>["data"]>;
  agentTasks: NonNullable<ReturnType<typeof useTasks>["data"]>;
  companyId: string;
  agents: ReturnType<typeof useAgents>["data"];
}) {
  const activeTasks = agentTasks.filter((t) => t.status === "in_progress");
  const doneTasks = agentTasks.filter((t) => t.status === "done");
  const pendingTasks = agentTasks.filter(
    (t) => t.status === "pending" || t.status === "todo",
  );
  const reportsToAgent = agents?.find((a) => a.id === agent.reportsTo);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2 space-y-6">
        {/* Quick stats */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="glass rounded-xl p-4 relative overflow-hidden">
            <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-success rounded-l-xl" />
            <CheckCircle2 className="h-5 w-5 text-success mb-2" />
            <p className="font-display text-2xl font-bold text-text-primary tabular-nums">
              {doneTasks.length}
            </p>
            <p className="text-[10px] text-text-secondary mt-0.5">Completed</p>
          </div>
          <div className="glass rounded-xl p-4 relative overflow-hidden">
            <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-neon-cyan rounded-l-xl" />
            <Play className="h-5 w-5 text-neon-cyan mb-2" />
            <p className="font-display text-2xl font-bold text-text-primary tabular-nums">
              {activeTasks.length}
            </p>
            <p className="text-[10px] text-text-secondary mt-0.5">In Progress</p>
          </div>
          <div className="glass rounded-xl p-4 relative overflow-hidden">
            <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-warning rounded-l-xl" />
            <Clock className="h-5 w-5 text-warning mb-2" />
            <p className="font-display text-2xl font-bold text-text-primary tabular-nums">
              {pendingTasks.length}
            </p>
            <p className="text-[10px] text-text-secondary mt-0.5">Pending</p>
          </div>
          <div className="glass rounded-xl p-4 relative overflow-hidden">
            <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-neon-purple rounded-l-xl" />
            <Cpu className="h-5 w-5 text-neon-purple mb-2" />
            <p className="font-display text-2xl font-bold text-text-primary tabular-nums">
              {(
                agentTasks.reduce(
                  (sum, t) => sum + (t.actualTokens ?? 0),
                  0,
                ) / 1000
              ).toFixed(0)}
              k
            </p>
            <p className="text-[10px] text-text-secondary mt-0.5">Tokens Used</p>
          </div>
        </div>

        {/* Current task */}
        {activeTasks.length > 0 && (
          <div className="glass rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-white/[0.06]">
              <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
                Current Tasks
              </h3>
            </div>
            <div className="p-6 space-y-3">
              {activeTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  companyId={companyId}
                  compact
                />
              ))}
            </div>
          </div>
        )}

        {/* Capabilities */}
        <div className="glass rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/[0.06]">
            <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
              Capabilities
            </h3>
          </div>
          <div className="p-6 flex flex-wrap gap-2">
            {agent.capabilities.map((cap) => (
              <Badge key={cap} variant="default">
                {cap}
              </Badge>
            ))}
            {!agent.capabilities?.length && (
              <p className="text-sm text-text-secondary">
                No capabilities listed
              </p>
            )}
          </div>
        </div>

        {/* Reports to */}
        {reportsToAgent && (
          <div className="glass rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-white/[0.06]">
              <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
                Reports To
              </h3>
            </div>
            <div className="p-6">
              <Link
                to={`/company/${companyId}/agents/${reportsToAgent.id}`}
                className="flex items-center gap-3 group"
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-neon-cyan/10">
                  <Bot className="h-4 w-4 text-neon-cyan" />
                </div>
                <div>
                  <p className="text-sm font-medium text-text-primary group-hover:text-neon-cyan transition-colors duration-200">
                    {reportsToAgent.name}
                  </p>
                  <p className="text-xs text-text-secondary">
                    {reportsToAgent.title}
                  </p>
                </div>
                <ChevronRight className="h-4 w-4 text-text-secondary ml-auto" />
              </Link>
            </div>
          </div>
        )}
      </div>

      {/* Right sidebar */}
      <div className="space-y-6">
        <div className="glass rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/[0.06]">
            <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
              Budget
            </h3>
          </div>
          <div className="p-6">
            <BudgetGauge
              used={(agent.spentMonthlyCents ?? 0) / 100}
              total={(agent.budgetMonthlyCents ?? 0) / 100}
              label="Agent Budget"
              size={100}
            />
          </div>
        </div>
        <div className="glass rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/[0.06]">
            <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
              Details
            </h3>
          </div>
          <div className="p-6 space-y-4">
            <DetailRow label="Provider" value={agent.provider ?? "N/A"} />
            <DetailRow label="Model" value={agent.model ?? "N/A"} />
            <DetailRow
              label="Last Heartbeat"
              value={
                agent.lastHeartbeatAt
                  ? new Date(agent.lastHeartbeatAt).toLocaleString()
                  : "Never"
              }
            />
            <DetailRow
              label="Created"
              value={new Date(agent.createdAt).toLocaleDateString()}
            />
            <DetailRow
              label="Updated"
              value={new Date(agent.updatedAt).toLocaleDateString()}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-text-secondary">{label}</span>
      <span className="text-xs font-medium text-text-primary font-display">{value}</span>
    </div>
  );
}

// ── Config Tab ──────────────────────────────────────────────────────────

function ConfigTab({
  agent,
  companyId,
  updateAgent,
  agents,
}: {
  agent: NonNullable<ReturnType<typeof useAgent>["data"]>;
  companyId: string;
  updateAgent: ReturnType<typeof useUpdateAgent>;
  agents: ReturnType<typeof useAgents>["data"];
}) {
  const [provider, setProvider] = useState(
    normalizeProvider(agent.provider),
  );
  const [model, setModel] = useState(agent.model ?? "");
  const [temperature, setTemperature] = useState<number>(
    agent.temperature ?? 0.7,
  );
  const [maxTokens, setMaxTokens] = useState<string>(
    String(agent.maxTokens ?? 4096),
  );
  const [maxConcurrentTasks, setMaxConcurrentTasks] = useState<string>(
    String(agent.maxConcurrentTasks ?? 1),
  );
  const [heartbeatInterval, setHeartbeatInterval] = useState<string>(
    String(agent.heartbeatIntervalSeconds ?? 300),
  );
  const [autoAssign, setAutoAssign] = useState<boolean>(
    agent.autoAssignTasks === true || agent.autoAssignTasks === 1,
  );
  const [apiKeySet, setApiKeySet] = useState<boolean>(
    agent.apiKeySet === true || Boolean(agent.apiKeyEncrypted),
  );
  const [showApiKeyInput, setShowApiKeyInput] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [budgetDollars, setBudgetDollars] = useState(
    String((agent.budgetMonthlyCents ?? 0) / 100),
  );
  const [saved, setSaved] = useState(false);

  const modelOptions = getModelOptions(provider);

  useEffect(() => {
    // When provider changes, reset model to first option for that provider
    const opts = getModelOptions(provider);
    if (opts && opts.length > 0 && !opts.find((m) => m.value === model)) {
      setModel(opts[0].value);
    }
  }, [provider]);

  const handleSave = () => {
    const data: Record<string, unknown> = {
      provider: normalizeProvider(provider),
      model,
      temperature,
      maxTokens: parseInt(maxTokens, 10),
      maxConcurrentTasks: parseInt(maxConcurrentTasks, 10),
      heartbeatIntervalSeconds: parseInt(heartbeatInterval, 10),
      autoAssignTasks: autoAssign ? 1 : 0,
      budgetMonthlyCents: Math.round(parseFloat(budgetDollars || "0") * 100),
    };

    if (showApiKeyInput && apiKey) {
      data.apiKeyEncrypted = apiKey;
      data.apiKeyProvider = normalizeProvider(provider);
      setApiKeySet(true);
      setShowApiKeyInput(false);
      setApiKey("");
    }

    updateAgent.mutate(
      {
        agentId: agent.id,
        data,
      },
      {
        onSuccess: () => {
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        },
      },
    );
  };

  const otherAgents = (agents ?? []).filter((a) => a.id !== agent.id);

  return (
    <div className="space-y-6">
      <div className="glass rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-white/[0.06]">
          <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
            Provider & Model
          </h3>
        </div>
        <div className="p-6 space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Select
              label="Provider"
              options={[...PROVIDER_OPTIONS]}
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            />
            <Select
              label="Model"
              options={modelOptions}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-2">
              API Key
            </label>
            {!showApiKeyInput ? (
              <div className="flex items-center gap-3">
                <div className="flex-1 rounded-xl glass-raised px-4 py-2.5 text-sm text-text-secondary">
                  {apiKeySet ? "................" : "Not set"}
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowApiKeyInput(true)}
                >
                  {apiKeySet ? "Change" : "Set Key"}
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <Input
                  type="password"
                  placeholder="sk-..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="flex-1"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowApiKeyInput(false);
                    setApiKey("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="glass rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-white/[0.06]">
          <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
            Generation Settings
          </h3>
        </div>
        <div className="p-6 space-y-6">
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-text-secondary">
                Temperature
              </label>
              <span className="text-xs font-mono text-neon-cyan tabular-nums font-display">
                {temperature.toFixed(2)}
              </span>
            </div>
            <input
              type="range"
              min="0"
              max="2"
              step="0.05"
              value={temperature}
              onChange={(e) => setTemperature(parseFloat(e.target.value))}
              className="w-full h-2 rounded-full appearance-none bg-surface-overlay accent-neon-cyan cursor-pointer"
            />
            <div className="flex justify-between mt-1.5">
              <span className="text-[10px] text-text-secondary">
                Precise (0.0)
              </span>
              <span className="text-[10px] text-text-secondary">
                Creative (2.0)
              </span>
            </div>
          </div>
          <Input
            label="Max Tokens"
            type="number"
            value={maxTokens}
            onChange={(e) => setMaxTokens(e.target.value)}
            placeholder="4096"
          />
        </div>
      </div>

      <div className="glass rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-white/[0.06]">
          <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
            Behavior
          </h3>
        </div>
        <div className="p-6 space-y-5">
          <Input
            label="Max Concurrent Tasks"
            type="number"
            value={maxConcurrentTasks}
            onChange={(e) => setMaxConcurrentTasks(e.target.value)}
            placeholder="1"
          />
          <Input
            label="Heartbeat Interval (seconds)"
            type="number"
            value={heartbeatInterval}
            onChange={(e) => setHeartbeatInterval(e.target.value)}
            placeholder="30"
          />
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-text-secondary">
                Auto-assign Tasks
              </p>
              <p className="text-xs text-text-secondary/60 mt-0.5">
                Automatically pick up tasks from the queue
              </p>
            </div>
            <button
              type="button"
              onClick={() => setAutoAssign(!autoAssign)}
              className="text-neon-cyan cursor-pointer transition-colors duration-200"
              aria-label={`Auto-assign tasks: ${autoAssign ? "enabled" : "disabled"}`}
            >
              {autoAssign ? (
                <ToggleRight className="h-8 w-8" />
              ) : (
                <ToggleLeft className="h-8 w-8 text-text-secondary" />
              )}
            </button>
          </div>
        </div>
      </div>

      <div className="glass rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-white/[0.06]">
          <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
            Budget
          </h3>
        </div>
        <div className="p-6">
          <Input
            label="Monthly Budget ($)"
            type="number"
            value={budgetDollars}
            onChange={(e) => setBudgetDollars(e.target.value)}
            placeholder="100"
          />
        </div>
      </div>

      <div className="flex items-center justify-end gap-3">
        {saved && (
          <span className="text-sm text-success flex items-center gap-1.5">
            <CheckCircle2 className="h-4 w-4" />
            Saved
          </span>
        )}
        <Button
          icon={<Save className="h-4 w-4" />}
          onClick={handleSave}
          loading={updateAgent.isPending}
        >
          Save Configuration
        </Button>
      </div>
    </div>
  );
}

// ── Instructions Tab ────────────────────────────────────────────────────

function InstructionsTab({
  agent,
  companyId,
}: {
  agent: NonNullable<ReturnType<typeof useAgent>["data"]>;
  companyId: string;
}) {
  const { data: instructionsData } = useAgentInstructions(companyId, agent.id);
  const updateInstructions = useUpdateAgentInstructions(companyId);
  const [instructions, setInstructions] = useState("");
  const [previewMode, setPreviewMode] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);

  useEffect(() => {
    if (instructionsData?.instructions) {
      setInstructions(instructionsData.instructions);
    } else if (agent.systemPrompt) {
      setInstructions(agent.systemPrompt);
    }
  }, [instructionsData, agent.systemPrompt]);

  const handleSave = () => {
    updateInstructions.mutate(
      { agentId: agent.id, instructions },
      {
        onSuccess: () => {
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        },
      },
    );
  };

  const handleApplyTemplate = (role: string) => {
    const template = INSTRUCTION_TEMPLATES[role];
    if (template) {
      setInstructions(template);
      setShowTemplates(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-display text-sm font-semibold text-text-primary">
            System Prompt / Instructions
          </h3>
          <p className="text-xs text-text-secondary mt-1">
            Define the agent's behavior, personality, and guidelines.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowTemplates(!showTemplates)}
          >
            Templates
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={
              previewMode ? (
                <EyeOff className="h-3.5 w-3.5" />
              ) : (
                <Eye className="h-3.5 w-3.5" />
              )
            }
            onClick={() => setPreviewMode(!previewMode)}
          >
            {previewMode ? "Edit" : "Preview"}
          </Button>
        </div>
      </div>

      {/* Template suggestions */}
      {showTemplates && (
        <div className="glass rounded-xl p-6">
          <div className="space-y-3">
            <p className="text-xs font-semibold text-text-secondary uppercase tracking-wider font-display">
              Apply Template
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {Object.keys(INSTRUCTION_TEMPLATES).map((role) => (
                <button
                  key={role}
                  onClick={() => handleApplyTemplate(role)}
                  className={clsx(
                    "rounded-xl glass-raised px-3 py-2.5 text-xs font-medium text-text-secondary hover:text-neon-cyan hover:shadow-sm hover:shadow-neon-cyan/10 transition-all duration-200 cursor-pointer capitalize",
                    agent.role === role && "border border-neon-cyan/30 text-neon-cyan",
                  )}
                >
                  {role}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Editor or Preview */}
      {previewMode ? (
        <div className="glass rounded-xl p-6 prose prose-invert prose-sm max-w-none">
          <pre className="whitespace-pre-wrap text-sm text-text-primary font-sans leading-relaxed">
            {instructions || "No instructions set."}
          </pre>
        </div>
      ) : (
        <div className="space-y-2">
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            className="w-full min-h-[400px] rounded-xl glass px-5 py-4 text-sm text-text-primary font-mono leading-relaxed placeholder:text-text-secondary/40 outline-none transition-all duration-200 focus:shadow-md focus:shadow-neon-cyan/10 focus:border-neon-cyan/30 border border-transparent resize-y"
            placeholder="Enter system prompt / instructions for this agent..."
            spellCheck={false}
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-secondary tabular-nums font-display">
              {(instructions?.length ?? 0).toLocaleString()} characters
            </span>
          </div>
        </div>
      )}

      <div className="flex items-center justify-end gap-3">
        {saved && (
          <span className="text-sm text-success flex items-center gap-1.5">
            <CheckCircle2 className="h-4 w-4" />
            Saved
          </span>
        )}
        <Button
          icon={<Save className="h-4 w-4" />}
          onClick={handleSave}
          loading={updateInstructions.isPending}
        >
          Save Instructions
        </Button>
      </div>
    </div>
  );
}

// ── History Tab ─────────────────────────────────────────────────────────

function HistoryTab({
  companyId,
  agentId,
}: {
  companyId: string;
  agentId: string;
}) {
  const { data: revisions, isLoading } = useAgentRevisions(companyId, agentId);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-16 animate-pulse rounded-xl glass"
          />
        ))}
      </div>
    );
  }

  if (!revisions?.length) {
    return (
      <div className="glass rounded-xl">
        <div className="py-10 text-center">
          <History className="h-8 w-8 text-text-secondary/30 mx-auto mb-3" />
          <p className="text-sm text-text-secondary">
            No configuration changes recorded yet.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {/* Timeline */}
      <div className="relative">
        <div
          className="absolute left-4 top-0 bottom-0 w-px"
          style={{
            background: "rgba(240,180,41,0.2)",
          }}
        />
        {revisions.map((rev, i) => (
          <div key={rev.id ?? i} className="relative pl-10 pb-6">
            <div
              className="absolute left-2.5 top-1.5 h-3 w-3 rounded-full border-2 border-neon-cyan bg-surface"
              style={{ boxShadow: "0 0 8px rgba(0,243,255,0.4)" }}
            />
            <div className="glass-raised rounded-xl p-5">
              <div className="flex items-center justify-between mb-3">
                <span className="font-display text-xs font-semibold text-text-primary capitalize">
                  {rev.field}
                </span>
                <span className="text-[10px] text-text-secondary font-display tabular-nums">
                  {new Date(rev.changedAt).toLocaleString()}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-4 text-xs">
                <div>
                  <p className="text-text-secondary mb-1">Previous</p>
                  <p className="text-text-primary font-mono glass rounded-lg px-3 py-1.5 truncate">
                    {String(rev.oldValue ?? "null")}
                  </p>
                </div>
                <div>
                  <p className="text-text-secondary mb-1">New</p>
                  <p className="text-text-primary font-mono glass rounded-lg px-3 py-1.5 truncate">
                    {String(rev.newValue ?? "null")}
                  </p>
                </div>
              </div>
              {rev.changedBy && (
                <p className="text-[10px] text-text-secondary mt-3">
                  Changed by {rev.changedBy}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Tasks Tab ───────────────────────────────────────────────────────────

function TasksTab({
  agentTasks,
  companyId,
}: {
  agentTasks: NonNullable<ReturnType<typeof useTasks>["data"]>;
  companyId: string;
}) {
  const [filter, setFilter] = useState<string>("all");

  const filtered =
    filter === "all"
      ? agentTasks
      : agentTasks.filter((t) => t.status === filter);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: agentTasks.length };
    for (const t of agentTasks) {
      counts[t.status] = (counts[t.status] ?? 0) + 1;
    }
    return counts;
  }, [agentTasks]);

  return (
    <div className="space-y-6">
      {/* Filter bar */}
      <div className="flex items-center gap-2 overflow-x-auto">
        {["all", "in_progress", "todo", "pending", "done"].map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={clsx(
              "inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-medium transition-all duration-200 cursor-pointer whitespace-nowrap",
              filter === s
                ? "bg-neon-cyan/10 text-neon-cyan border border-neon-cyan/20"
                : "glass-raised text-text-secondary hover:text-text-primary",
            )}
          >
            {s === "all" ? "All" : s.replace("_", " ")}
            {statusCounts[s] !== undefined && (
              <span className="text-[10px] tabular-nums font-display">
                ({statusCounts[s]})
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tasks list */}
      {filtered.length === 0 ? (
        <div className="glass rounded-xl">
          <p className="py-10 text-center text-sm text-text-secondary">
            No tasks{filter !== "all" ? ` with status "${filter}"` : " assigned"}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((task) => (
            <TaskCard key={task.id} task={task} companyId={companyId} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Executions Tab ──────────────────────────────────────────────────────

function ExecutionsTab({
  companyId,
  agentId,
}: {
  companyId: string;
  agentId: string;
}) {
  const { data: executions, isLoading } = useAgentExecutions(
    companyId,
    agentId,
  );

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="h-14 animate-pulse rounded-xl glass"
          />
        ))}
      </div>
    );
  }

  if (!executions?.length) {
    return (
      <div className="glass rounded-xl">
        <div className="py-10 text-center">
          <Terminal className="h-8 w-8 text-text-secondary/30 mx-auto mb-3" />
          <p className="text-sm text-text-secondary">
            No execution logs yet.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {executions.map((exec) => (
        <ExecutionRow
          key={exec.id}
          exec={exec}
          companyId={companyId}
          defaultOpen={exec.status === "running"}
        />
      ))}
    </div>
  );
}

// ── Execution Row (expandable transcript) ───────────────────────────────

function ExecutionRow({
  exec,
  companyId,
  defaultOpen,
}: {
  exec: ReturnType<typeof useAgentExecutions>["data"] extends
    | Array<infer T>
    | undefined
    ? T
    : never;
  companyId: string;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const hasTranscript =
    exec.status === "running" || (exec.log?.length ?? 0) > 0;

  return (
    <div className="glass-raised rounded-xl transition-all duration-200 hover:glass-hover overflow-hidden">
      <button
        type="button"
        onClick={() => hasTranscript && setOpen((prev) => !prev)}
        className={clsx(
          "w-full p-5 text-left",
          hasTranscript ? "cursor-pointer" : "cursor-default",
        )}
        disabled={!hasTranscript}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <span
              className={clsx(
                "inline-flex h-7 w-7 items-center justify-center rounded-lg text-xs",
                exec.status === "completed"
                  ? "bg-success/10 text-success"
                  : exec.status === "running"
                    ? "bg-neon-cyan/10 text-neon-cyan"
                    : exec.status === "failed"
                      ? "bg-error/10 text-error"
                      : "bg-surface-overlay text-text-secondary",
              )}
            >
              {exec.status === "completed" ? (
                <CheckCircle2 className="h-3.5 w-3.5" />
              ) : exec.status === "running" ? (
                <Play className="h-3.5 w-3.5" />
              ) : exec.status === "failed" ? (
                <AlertCircle className="h-3.5 w-3.5" />
              ) : (
                <Clock className="h-3.5 w-3.5" />
              )}
            </span>
            {hasTranscript && (
              <ChevronRight
                className={clsx(
                  "h-3.5 w-3.5 shrink-0 text-text-secondary transition-transform duration-200",
                  open && "rotate-90",
                )}
              />
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium text-text-primary truncate">
                {exec.action}
              </p>
              {exec.error && (
                <p className="text-xs text-error mt-0.5 truncate">
                  {exec.error}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-4 shrink-0 text-xs text-text-secondary font-display tabular-nums">
            {exec.durationMs != null && <span>{exec.durationMs}ms</span>}
            {exec.tokensUsed != null && (
              <span>{exec.tokensUsed.toLocaleString()} tok</span>
            )}
            <span>{new Date(exec.startedAt).toLocaleTimeString()}</span>
          </div>
        </div>
      </button>

      {open && hasTranscript && (
        <div className="border-t border-white/[0.06] bg-black/15 p-4">
          <TranscriptView companyId={companyId} execution={exec} />
        </div>
      )}
    </div>
  );
}
