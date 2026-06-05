import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { clsx } from "clsx";
import { toast } from "sonner";
import {
  Activity,
  Bot,
  BrainCircuit,
  CheckCircle2,
  Cpu,
  FileCode2,
  Gauge,
  PauseCircle,
  Play,
  RadioTower,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { PageTransition } from "@/components/ui/PageTransition";
import { Skeleton } from "@/components/ui/Skeleton";
import { useSession } from "@/lib/auth";
import {
  useAgents,
  useCompanySkills,
  useCreateJarvisRoutine,
  useCreateRuntimeSession,
  useFinalizeRuntimeSession,
  useInstallCompanySkill,
  useJarvisRoutines,
  useRuntimeAdapters,
  useRuntimeSessions,
  useTriggerJarvisRoutine,
  useWakeAgent,
  useCancelRuntimeSession,
} from "@/lib/hooks";
import type {
  Agent,
  CompanySkill,
  JarvisRoutine,
  RuntimeAdapterDescriptor,
  RuntimeSession,
  RuntimeSessionMode,
  RuntimeSessionStatus,
} from "@/lib/api";

const sessionModeOptions: Array<{ value: RuntimeSessionMode; label: string }> = [
  { value: "on_demand", label: "On demand" },
  { value: "manual", label: "Manual" },
  { value: "scheduled", label: "Scheduled" },
  { value: "continuous", label: "Continuous" },
  { value: "recovery", label: "Recovery" },
];

const routineModeOptions: Array<{ value: JarvisRoutine["mode"]; label: string }> = [
  { value: "scheduled", label: "Scheduled" },
  { value: "continuous", label: "Continuous" },
  { value: "on_demand", label: "On demand" },
];

const jarvisModeOptions: Array<{ value: JarvisRoutine["jarvisMode"]; label: string }> = [
  { value: "daily_briefing", label: "Daily briefing" },
  { value: "monitoring", label: "Monitoring" },
  { value: "research", label: "Research" },
  { value: "follow_up", label: "Follow up" },
  { value: "custom", label: "Custom" },
];

type BadgeTone = "default" | "success" | "warning" | "error" | "info";

const activeSessionStatuses = new Set<RuntimeSessionStatus>([
  "queued",
  "running",
  "cancelling",
  "finalizing",
]);

const finalizableSessionStatuses = new Set<RuntimeSessionStatus>([
  "cancelled",
  "completed",
  "failed",
]);

function compactId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}...${id.slice(-4)}` : id;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function toLabel(value: string): string {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (s) => s.toUpperCase());
}

function statusVariant(status: RuntimeSessionStatus): BadgeTone {
  if (status === "running" || status === "queued") return "info";
  if (status === "completed" || status === "finalized") return "success";
  if (status === "failed" || status === "cancelled") return "error";
  return "warning";
}

function defaultAdapterIdForAgent(agent: Agent): string {
  if (agent.adapterId) return agent.adapterId;
  if (agent.provider === "local" || agent.provider === "ollama") return "provider:ollama";
  return `provider:${agent.provider}`;
}

function hasRuntimeAdminAccess(
  role: string | null | undefined,
  organizationRole: string | null | undefined,
): boolean {
  return role === "admin" || organizationRole === "owner" || organizationRole === "admin";
}

function StatTile({
  icon: Icon,
  label,
  value,
  tone = "cyan",
}: {
  icon: typeof Activity;
  label: string;
  value: string | number;
  tone?: "cyan" | "accent" | "success" | "warning";
}) {
  const toneClass = {
    cyan: "text-neon-cyan bg-neon-cyan/10",
    accent: "text-accent bg-accent/10",
    success: "text-success bg-success/10",
    warning: "text-warning bg-warning/10",
  }[tone];

  return (
    <div className="glass rounded-xl p-4">
      <div className="flex items-center gap-3">
        <span className={clsx("flex h-9 w-9 items-center justify-center rounded-lg", toneClass)}>
          <Icon className="h-4 w-4" />
        </span>
        <div>
          <p className="text-[11px] text-text-secondary">{label}</p>
          <p className="font-display text-2xl font-semibold text-text-primary tabular-nums">
            {value}
          </p>
        </div>
      </div>
    </div>
  );
}

function CapabilityPill({ label, enabled }: { label: string; enabled: boolean }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
        enabled
          ? "border-neon-cyan/20 bg-neon-cyan/10 text-neon-cyan"
          : "border-white/[0.06] bg-white/[0.03] text-text-secondary",
      )}
    >
      {enabled ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
      {label}
    </span>
  );
}

function ErrorPanel({
  title,
  error,
  compact = false,
}: {
  title: string;
  error: unknown;
  compact?: boolean;
}) {
  return (
    <div className={clsx("border border-error/20 bg-error/10 text-error", compact ? "rounded-lg p-3" : "p-5")}>
      <div className="flex items-start gap-2">
        <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="text-sm font-semibold font-display">{title}</p>
          <p className="mt-1 text-xs text-error/85">{errorMessage(error)}</p>
        </div>
      </div>
    </div>
  );
}

function AdminRequiredPanel({ title }: { title: string }) {
  return (
    <div className="border border-warning/20 bg-warning/10 p-5 text-warning">
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="text-sm font-semibold font-display">{title}</p>
          <p className="mt-1 text-xs text-warning/85">
            Admin access is required for session leases, workspace finalization, and skill materialization.
          </p>
        </div>
      </div>
    </div>
  );
}

function AdapterRow({ adapter }: { adapter: RuntimeAdapterDescriptor }) {
  const capabilityList = [
    ["Tools", adapter.capabilities.tools],
    ["MCP", adapter.capabilities.mcp],
    ["Skills", adapter.capabilities.skills],
    ["Browser", adapter.capabilities.browser],
    ["Shell", adapter.capabilities.shell],
    ["Voice", adapter.capabilities.voice],
    ["Resume", adapter.capabilities.sessionResume],
  ] as const;

  return (
    <div className="grid gap-4 border-b border-white/[0.06] p-4 last:border-b-0 lg:grid-cols-[minmax(220px,1fr)_160px_1.4fr]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-semibold text-text-primary font-display">
            {adapter.name}
          </p>
          <Badge variant={adapter.locality === "local" ? "success" : "default"}>
            {adapter.locality}
          </Badge>
          {adapter.kind === "openjarvis-local" && <Badge variant="info">OpenJarvis</Badge>}
        </div>
        <p className="mt-1 text-xs text-text-secondary">{adapter.description}</p>
      </div>
      <div>
        <p className="text-[10px] uppercase tracking-wider text-text-muted font-display">
          Modes
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {adapter.supportedModes.map((mode) => (
            <Badge key={mode} variant="low">
              {toLabel(mode)}
            </Badge>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {capabilityList.map(([label, enabled]) => (
          <CapabilityPill key={label} label={label} enabled={enabled} />
        ))}
      </div>
    </div>
  );
}

function SessionRow({
  session,
  agentName,
  onCancel,
  onFinalize,
  cancelling,
  finalizing,
}: {
  session: RuntimeSession;
  agentName: string;
  onCancel: () => void;
  onFinalize: () => void;
  cancelling: boolean;
  finalizing: boolean;
}) {
  const canCancel = session.status === "queued" || session.status === "running";
  const canFinalize =
    session.finalizeRequired &&
    !session.finalizedAt &&
    finalizableSessionStatuses.has(session.status);

  return (
    <div className="flex flex-col gap-3 border-b border-white/[0.06] p-4 last:border-b-0 xl:flex-row xl:items-center xl:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-semibold text-text-primary font-display">
            {agentName}
          </p>
          <Badge variant={statusVariant(session.status)}>{toLabel(session.status)}</Badge>
          <Badge variant="low">{toLabel(session.mode)}</Badge>
        </div>
        <p className="mt-1 text-xs text-text-secondary">
          Run {compactId(session.runId)} via {session.adapterId} - updated {formatDateTime(session.updatedAt)}
        </p>
        {session.cancellationReason && (
          <p className="mt-1 text-xs text-error">{session.cancellationReason}</p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={<ShieldCheck className="h-3.5 w-3.5" />}
          disabled={!canFinalize}
          loading={finalizing}
          onClick={onFinalize}
        >
          Finalize
        </Button>
        <Button
          variant="danger"
          size="sm"
          icon={<PauseCircle className="h-3.5 w-3.5" />}
          disabled={!canCancel}
          loading={cancelling}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function RuntimeLauncher({
  agents,
  adapters,
  selectedAgentId,
  setSelectedAgentId,
  sessionControlsDisabled = false,
  wakeControlsDisabled = false,
}: {
  agents: Agent[];
  adapters: RuntimeAdapterDescriptor[];
  selectedAgentId: string;
  setSelectedAgentId: (value: string) => void;
  sessionControlsDisabled?: boolean;
  wakeControlsDisabled?: boolean;
}) {
  const { companyId } = useParams();
  const [selectedAdapterId, setSelectedAdapterId] = useState("");
  const [mode, setMode] = useState<RuntimeSessionMode>("on_demand");
  const createSession = useCreateRuntimeSession(companyId!);
  const wakeAgent = useWakeAgent(companyId!);

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId);
  const defaultAdapterId = selectedAgent ? defaultAdapterIdForAgent(selectedAgent) : "";
  const effectiveAdapterId = selectedAdapterId || defaultAdapterId;
  const effectiveAdapter = adapters.find((adapter) => adapter.id === effectiveAdapterId);
  const availableSessionModeOptions = useMemo(() => {
    if (!effectiveAdapter) return sessionModeOptions.slice(0, 1);

    const adapterModes = new Set(effectiveAdapter.supportedModes);
    const supported = sessionModeOptions.filter((option) => {
      if (
        option.value !== "on_demand" &&
        option.value !== "scheduled" &&
        option.value !== "continuous"
      ) {
        return false;
      }
      return adapterModes.has(option.value);
    });

    return supported.length ? supported : sessionModeOptions.slice(0, 1);
  }, [effectiveAdapter]);

  useEffect(() => {
    if (!availableSessionModeOptions.some((option) => option.value === mode)) {
      setMode(availableSessionModeOptions[0]?.value ?? "on_demand");
    }
  }, [availableSessionModeOptions, mode]);

  function handleCreateSession(event: FormEvent) {
    event.preventDefault();
    if (sessionControlsDisabled) {
      toast.error("Session controls are unavailable");
      return;
    }
    if (!selectedAgentId) {
      toast.error("Choose an agent before creating a runtime session");
      return;
    }

    createSession.mutate(
      {
        agentId: selectedAgentId,
        adapterId: selectedAdapterId || selectedAgent?.adapterId || undefined,
        mode,
      },
      {
        onSuccess: () => toast.success("Runtime session created"),
        onError: (error) => toast.error(error instanceof Error ? error.message : "Session failed"),
      },
    );
  }

  function handleWake() {
    if (wakeControlsDisabled) {
      toast.error("Wake controls are unavailable");
      return;
    }
    if (!selectedAgentId) {
      toast.error("Choose an agent before waking it");
      return;
    }
    wakeAgent.mutate(selectedAgentId, {
      onSuccess: () => toast.success("Agent wake requested"),
      onError: (error) => toast.error(error instanceof Error ? error.message : "Wake failed"),
    });
  }

  return (
    <div className="glass rounded-xl overflow-hidden">
      <div className="border-b border-white/[0.06] px-5 py-4">
        <div className="flex items-center gap-2">
          <RadioTower className="h-4 w-4 text-accent" />
          <h3 className="text-sm font-semibold text-text-primary font-display">
            Jarvis Launcher
          </h3>
        </div>
        <p className="mt-1 text-xs text-text-secondary">
          Wake an agent or start a durable runtime session against a local, cloud, or OpenJarvis adapter.
        </p>
      </div>
      <form onSubmit={handleCreateSession} className="space-y-4 p-5">
        <Select
          label="Agent"
          value={selectedAgentId}
          onChange={(event) => setSelectedAgentId(event.target.value)}
          placeholder="Choose an agent"
          disabled={sessionControlsDisabled && wakeControlsDisabled}
          options={agents.map((agent) => ({
            value: agent.id,
            label: `${agent.name} (${agent.role})`,
          }))}
        />
        <Select
          label="Runtime adapter"
          value={selectedAdapterId}
          onChange={(event) => setSelectedAdapterId(event.target.value)}
          disabled={sessionControlsDisabled}
          options={[
            {
              value: "",
              label: defaultAdapterId ? `Use ${defaultAdapterId}` : "Use agent default",
            },
            ...adapters.map((adapter) => ({
              value: adapter.id,
              label: `${adapter.name} (${adapter.locality})`,
            })),
          ]}
        />
        <Select
          label="Session mode"
          value={mode}
          onChange={(event) => setMode(event.target.value as RuntimeSessionMode)}
          disabled={sessionControlsDisabled}
          options={availableSessionModeOptions}
        />
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            type="button"
            variant="secondary"
            icon={<Play className="h-3.5 w-3.5" />}
            disabled={wakeControlsDisabled}
            loading={wakeAgent.isPending}
            onClick={handleWake}
          >
            Wake agent
          </Button>
          <Button
            type="submit"
            icon={<TerminalSquare className="h-3.5 w-3.5" />}
            disabled={sessionControlsDisabled}
            loading={createSession.isPending}
          >
            Start session
          </Button>
        </div>
      </form>
    </div>
  );
}

function RoutinePanel({ agents }: { agents: Agent[] }) {
  const { companyId } = useParams();
  const { data: routines, isLoading, isError, error } = useJarvisRoutines(companyId);
  const createRoutine = useCreateJarvisRoutine(companyId!);
  const triggerRoutine = useTriggerJarvisRoutine(companyId!);
  const [name, setName] = useState("Daily operator briefing");
  const [mode, setMode] = useState<JarvisRoutine["mode"]>("scheduled");
  const [jarvisMode, setJarvisMode] = useState<JarvisRoutine["jarvisMode"]>("daily_briefing");
  const [agentId, setAgentId] = useState("");
  const [schedule, setSchedule] = useState("0 8 * * *");
  const [prompt, setPrompt] = useState(
    "Prepare a concise briefing from open tasks, approvals, runtime sessions, blocked work, and follow-up items.",
  );

  function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (isError) {
      toast.error("Routine controls are unavailable");
      return;
    }
    createRoutine.mutate(
      {
        name,
        mode,
        jarvisMode,
        agentId: agentId || null,
        schedule: schedule || null,
        prompt,
      },
      {
        onSuccess: () => toast.success("Routine created"),
        onError: (error) => toast.error(error instanceof Error ? error.message : "Routine failed"),
      },
    );
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
      <div className="glass rounded-xl overflow-hidden">
        <div className="border-b border-white/[0.06] px-5 py-4">
          <div className="flex items-center gap-2">
            <RefreshCw className="h-4 w-4 text-neon-cyan" />
            <h3 className="text-sm font-semibold text-text-primary font-display">
              Routines
            </h3>
          </div>
          <p className="mt-1 text-xs text-text-secondary">
            Scheduled and continuous Jarvis modes for briefing, monitoring, research, and follow-up.
          </p>
        </div>
        {isLoading ? (
          <div className="space-y-4 p-5">
            <Skeleton lines={3} />
            <Skeleton lines={3} />
          </div>
        ) : isError ? (
          <ErrorPanel title="Routines unavailable" error={error} />
        ) : !routines?.length ? (
          <p className="p-5 text-sm text-text-secondary">
            No routines yet. Create a briefing, monitor, research, or follow-up routine to give Jarvis a persistent operating rhythm.
          </p>
        ) : (
          <div>
            {routines.map((routine) => (
              <div
                key={routine.id}
                className="flex flex-col gap-3 border-b border-white/[0.06] p-4 last:border-b-0 lg:flex-row lg:items-center lg:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-semibold text-text-primary font-display">
                      {routine.name}
                    </p>
                    <Badge variant={routine.enabled ? "success" : "default"}>
                      {routine.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                    <Badge variant="info">{toLabel(routine.jarvisMode)}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-text-secondary">
                    {toLabel(routine.mode)} - {routine.schedule || "manual trigger"} - last {formatDateTime(routine.lastTriggeredAt)}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Play className="h-3.5 w-3.5" />}
                  loading={triggerRoutine.isPending}
                  disabled={isError}
                  onClick={() =>
                    triggerRoutine.mutate(routine.id, {
                      onSuccess: () => toast.success("Routine triggered"),
                      onError: (error) =>
                        toast.error(error instanceof Error ? error.message : "Trigger failed"),
                    })
                  }
                >
                  Trigger
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <form onSubmit={handleCreate} className="glass rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-semibold text-text-primary font-display">
          Create routine
        </h3>
        <Input label="Name" value={name} onChange={(event) => setName(event.target.value)} />
        <Select
          label="Jarvis mode"
          value={jarvisMode}
          onChange={(event) => setJarvisMode(event.target.value as JarvisRoutine["jarvisMode"])}
          options={jarvisModeOptions}
        />
        <Select
          label="Run mode"
          value={mode}
          onChange={(event) => setMode(event.target.value as JarvisRoutine["mode"])}
          options={routineModeOptions}
        />
        <Select
          label="Agent"
          value={agentId}
          onChange={(event) => setAgentId(event.target.value)}
          options={[
            { value: "", label: "Company-level routine" },
            ...agents.map((agent) => ({ value: agent.id, label: agent.name })),
          ]}
        />
        <Input
          label="Schedule"
          value={schedule}
          onChange={(event) => setSchedule(event.target.value)}
          placeholder="0 8 * * *"
        />
        <Textarea
          label="Prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          className="min-h-28"
        />
        <Button
          type="submit"
          loading={createRoutine.isPending}
          disabled={isError}
          icon={<Sparkles className="h-3.5 w-3.5" />}
        >
          Add routine
        </Button>
      </form>
    </div>
  );
}

function SkillPanel({ agents }: { agents: Agent[] }) {
  const { companyId } = useParams();
  const { data: skills, isLoading, isError, error } = useCompanySkills(companyId);
  const installSkill = useInstallCompanySkill(companyId!);
  const [name, setName] = useState("daily-briefing");
  const [source, setSource] = useState("agentskills.io/manual");
  const [agentId, setAgentId] = useState("");
  const [content, setContent] = useState(
    "# Skill: Daily Briefing\n\nSummarize urgent approvals, active sessions, blocked work, and follow-up commitments. Return concise action items.",
  );

  function handleInstall(event: FormEvent) {
    event.preventDefault();
    if (isError) {
      toast.error("Skill controls are unavailable");
      return;
    }
    installSkill.mutate(
      {
        name,
        source,
        provenance: "manual",
        trustLevel: "markdown_only",
        content,
        tags: ["jarvis", "briefing"],
        agentIds: agentId ? [agentId] : [],
      },
      {
        onSuccess: () => toast.success("Skill installed"),
        onError: (error) => toast.error(error instanceof Error ? error.message : "Skill install failed"),
      },
    );
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
      <div className="glass rounded-xl overflow-hidden">
        <div className="border-b border-white/[0.06] px-5 py-4">
          <div className="flex items-center gap-2">
            <FileCode2 className="h-4 w-4 text-accent" />
            <h3 className="text-sm font-semibold text-text-primary font-display">
              Skills catalog
            </h3>
          </div>
          <p className="mt-1 text-xs text-text-secondary">
            Company-owned skills that can materialize into local adapter homes using the agentskills.io shape.
          </p>
        </div>
        {isLoading ? (
          <div className="space-y-4 p-5">
            <Skeleton lines={3} />
            <Skeleton lines={3} />
          </div>
        ) : isError ? (
          <ErrorPanel title="Skills unavailable" error={error} />
        ) : !skills?.length ? (
          <p className="p-5 text-sm text-text-secondary">
            No skills installed yet. Start with markdown-only skills, then promote trusted assets or executable skills deliberately.
          </p>
        ) : (
          <div className="divide-y divide-white/[0.06]">
            {skills.map((skill: CompanySkill) => (
              <div key={skill.id} className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-text-primary font-display">
                    {skill.name}
                  </p>
                  <Badge variant="low">v{skill.version}</Badge>
                  <Badge variant={skill.trustLevel === "scripts_executables" ? "warning" : "success"}>
                    {toLabel(skill.trustLevel)}
                  </Badge>
                  <Badge variant="info">{skill.provenance}</Badge>
                </div>
                <p className="mt-1 text-xs text-text-secondary">
                  {skill.source} - updated {formatDateTime(skill.updatedAt)}
                </p>
                {!!skill.tags.length && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {skill.tags.map((tag) => (
                      <Badge key={tag} variant="default">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <form onSubmit={handleInstall} className="glass rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-semibold text-text-primary font-display">
          Install skill
        </h3>
        <Input label="Name" value={name} onChange={(event) => setName(event.target.value)} />
        <Input label="Source" value={source} onChange={(event) => setSource(event.target.value)} />
        <Select
          label="Assign to agent"
          value={agentId}
          onChange={(event) => setAgentId(event.target.value)}
          options={[
            { value: "", label: "Install company-wide" },
            ...agents.map((agent) => ({ value: agent.id, label: agent.name })),
          ]}
        />
        <Textarea
          label="Skill content"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          className="min-h-40 font-mono text-xs"
        />
        <Button
          type="submit"
          loading={installSkill.isPending}
          disabled={isError}
          icon={<FileCode2 className="h-3.5 w-3.5" />}
        >
          Install skill
        </Button>
      </form>
    </div>
  );
}

export function JarvisRuntime() {
  const { companyId } = useParams();
  const { data: session } = useSession();
  const isAdmin = hasRuntimeAdminAccess(
    session?.user.role,
    session?.session.activeOrganizationRole,
  );
  const { data: agents = [] } = useAgents(companyId);
  const adaptersQuery = useRuntimeAdapters();
  const sessionsQuery = useRuntimeSessions(companyId, isAdmin);
  const skillsQuery = useCompanySkills(companyId, isAdmin);
  const routinesQuery = useJarvisRoutines(companyId);
  const adapters = adaptersQuery.data ?? [];
  const sessions = sessionsQuery.data ?? [];
  const skills = skillsQuery.data ?? [];
  const routines = routinesQuery.data ?? [];
  const cancelSession = useCancelRuntimeSession(companyId!);
  const finalizeSession = useFinalizeRuntimeSession(companyId!);
  const [selectedAgentId, setSelectedAgentId] = useState("");

  const agentNameById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.name])),
    [agents],
  );
  const activeSessions = sessions.filter((session) =>
    activeSessionStatuses.has(session.status),
  );
  const visibleSessions = useMemo(
    () =>
      [...sessions].sort((a, b) => {
        const aActive = activeSessionStatuses.has(a.status);
        const bActive = activeSessionStatuses.has(b.status);
        if (aActive !== bActive) return aActive ? -1 : 1;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      }),
    [sessions],
  );
  const localAdapters = adapters.filter((adapter) => adapter.locality !== "cloud");
  const openJarvisAdapters = adapters.filter((adapter) => adapter.kind === "openjarvis-local");
  const sessionControlsDisabled =
    !isAdmin || adaptersQuery.isError || sessionsQuery.isError || !agents.length;
  const wakeControlsDisabled = !agents.length;

  return (
    <PageTransition>
      <div className="mx-auto max-w-7xl space-y-8 p-6 lg:p-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <BrainCircuit className="h-5 w-5 text-accent" />
              <h2 className="font-display text-2xl font-bold tracking-tight text-text-primary">
                Jarvis Runtime
              </h2>
            </div>
            <p className="mt-2 max-w-3xl text-sm text-text-secondary">
              Operate local and cloud agent runtimes with durable sessions, skills, routines, workspace finalization, and OpenJarvis-compatible adapter targets.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {openJarvisAdapters.length > 0 ? (
              <Badge variant="info">OpenJarvis local adapter ready</Badge>
            ) : (
              <Badge variant="warning">OpenJarvis adapter unavailable</Badge>
            )}
            <Badge variant={activeSessions.length > 0 ? "success" : "default"}>
              {activeSessions.length} active sessions
            </Badge>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatTile icon={Cpu} label="Runtime adapters" value={adapters.length} tone="cyan" />
          <StatTile icon={TerminalSquare} label="Local capable" value={localAdapters.length} tone="accent" />
          <StatTile icon={Activity} label="Sessions" value={sessions.length} tone="success" />
          <StatTile icon={Gauge} label="Routines" value={routines.length} tone="warning" />
        </div>

        <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
          <RuntimeLauncher
            agents={agents}
            adapters={adapters}
            selectedAgentId={selectedAgentId}
            setSelectedAgentId={setSelectedAgentId}
            sessionControlsDisabled={sessionControlsDisabled}
            wakeControlsDisabled={wakeControlsDisabled}
          />

          <div className="glass rounded-xl overflow-hidden">
            <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
              <div>
                <div className="flex items-center gap-2">
                  <TerminalSquare className="h-4 w-4 text-neon-cyan" />
                  <h3 className="text-sm font-semibold text-text-primary font-display">
                    Runtime sessions
                  </h3>
                </div>
                <p className="mt-1 text-xs text-text-secondary">
                  Durable runs with cancellation and finalize gates.
                </p>
              </div>
              <Badge variant="low">{sessions.length} total</Badge>
            </div>
            {!isAdmin ? (
              <AdminRequiredPanel title="Runtime sessions require admin access" />
            ) : sessionsQuery.isLoading ? (
              <div className="space-y-4 p-5">
                <Skeleton lines={3} />
                <Skeleton lines={3} />
              </div>
            ) : sessionsQuery.isError ? (
              <ErrorPanel title="Runtime sessions unavailable" error={sessionsQuery.error} />
            ) : sessions.length === 0 ? (
              <p className="p-5 text-sm text-text-secondary">
                No runtime sessions yet. Start a session from the launcher to lease a workspace and create a resumable run id.
              </p>
            ) : (
              <div>
                {visibleSessions.slice(0, 8).map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    agentName={agentNameById.get(session.agentId) ?? compactId(session.agentId)}
                    cancelling={cancelSession.isPending}
                    finalizing={finalizeSession.isPending}
                    onCancel={() =>
                      cancelSession.mutate(
                        { sessionId: session.id, reason: "Cancelled from Jarvis Runtime" },
                        {
                          onSuccess: () => toast.success("Session cancelled"),
                          onError: (error) =>
                            toast.error(error instanceof Error ? error.message : "Cancel failed"),
                        },
                      )
                    }
                    onFinalize={() =>
                      finalizeSession.mutate(session.id, {
                        onSuccess: () => toast.success("Workspace finalized"),
                        onError: (error) =>
                          toast.error(error instanceof Error ? error.message : "Finalize failed"),
                      })
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="glass rounded-xl overflow-hidden">
          <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
            <div>
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-accent" />
                <h3 className="text-sm font-semibold text-text-primary font-display">
                  Runtime adapters
                </h3>
              </div>
              <p className="mt-1 text-xs text-text-secondary">
                Capability metadata for providers, local processes, HTTP runtimes, MCP runtimes, and OpenJarvis-local control.
              </p>
            </div>
            <Badge variant="low">{adapters.length} registered</Badge>
          </div>
          {adaptersQuery.isLoading ? (
            <div className="space-y-4 p-5">
              <Skeleton lines={3} />
              <Skeleton lines={3} />
              <Skeleton lines={3} />
            </div>
          ) : adaptersQuery.isError ? (
            <ErrorPanel title="Runtime adapters unavailable" error={adaptersQuery.error} />
          ) : (
            adapters.map((adapter) => <AdapterRow key={adapter.id} adapter={adapter} />)
          )}
        </div>

        <RoutinePanel agents={agents} />
        {isAdmin ? (
          <SkillPanel agents={agents} />
        ) : (
          <div className="glass rounded-xl overflow-hidden">
            <div className="border-b border-white/[0.06] px-5 py-4">
              <div className="flex items-center gap-2">
                <FileCode2 className="h-4 w-4 text-accent" />
                <h3 className="text-sm font-semibold text-text-primary font-display">
                  Skills catalog
                </h3>
              </div>
            </div>
            <AdminRequiredPanel title="Skills require admin access" />
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="glass rounded-xl p-5">
            <Bot className="h-5 w-5 text-neon-cyan" />
            <h3 className="mt-3 text-sm font-semibold text-text-primary font-display">
              Agent routing
            </h3>
            <p className="mt-1 text-sm text-text-secondary">
              Agents can now carry adapter defaults, session policy, routine policy, and skill assignments into real runs.
            </p>
          </div>
          <div className="glass rounded-xl p-5">
            <ShieldCheck className="h-5 w-5 text-success" />
            <h3 className="mt-3 text-sm font-semibold text-text-primary font-display">
              Operator gates
            </h3>
            <p className="mt-1 text-sm text-text-secondary">
              Sessions expose cancellation and workspace finalization instead of hiding unfinished runtime state.
            </p>
          </div>
          <div className="glass rounded-xl p-5">
            <FileCode2 className="h-5 w-5 text-accent" />
            <h3 className="mt-3 text-sm font-semibold text-text-primary font-display">
              Skill portability
            </h3>
            <p className="mt-1 text-sm text-text-secondary">
              Markdown-first skills give Eidolon a path to absorb OpenJarvis, Hermes, and OpenClaw-style capabilities.
            </p>
          </div>
        </div>
      </div>
    </PageTransition>
  );
}
