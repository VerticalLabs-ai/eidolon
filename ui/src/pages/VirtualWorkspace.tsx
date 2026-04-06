import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAgents, useTasks } from "@/lib/hooks";
import { EmptyState } from "@/components/ui/EmptyState";
import { FloorGrid } from "@/components/workspace/FloorGrid";
import { Desk } from "@/components/workspace/Desk";
import { AgentAvatar } from "@/components/workspace/AgentAvatar";
import { StatusBubble } from "@/components/workspace/StatusBubble";
import { ConnectionLine } from "@/components/workspace/ConnectionLine";
import type { Agent, Task } from "@/lib/api";

// ── Layout algorithm ──────────────────────────────────────────────────────

interface PositionedAgent {
  agent: Agent;
  x: number;
  y: number;
  task: Task | null;
}

function buildHierarchyPositions(
  agents: Agent[],
  tasks: Task[],
  canvasWidth: number,
): PositionedAgent[] {
  if (agents.length === 0) return [];

  const taskByAgent = new Map<string, Task>();
  for (const t of tasks) {
    if (t.assigneeAgentId && (t.status === "in_progress" || t.status === "working")) {
      taskByAgent.set(t.assigneeAgentId, t);
    }
  }

  // Build adjacency
  const childrenMap = new Map<string, Agent[]>();
  const roots: Agent[] = [];

  for (const a of agents) {
    if (a.reportsTo && agents.some((p) => p.id === a.reportsTo)) {
      const list = childrenMap.get(a.reportsTo) ?? [];
      list.push(a);
      childrenMap.set(a.reportsTo, list);
    } else {
      roots.push(a);
    }
  }

  // BFS to create level-based layout
  const levels: Agent[][] = [];
  let currentLevel = roots;

  while (currentLevel.length > 0) {
    levels.push(currentLevel);
    const next: Agent[] = [];
    for (const a of currentLevel) {
      const children = childrenMap.get(a.id);
      if (children) next.push(...children);
    }
    currentLevel = next;
  }

  // Position agents on canvas
  const DESK_SPACING_X = 160;
  const DESK_SPACING_Y = 180;
  const START_Y = 100;
  const positioned: PositionedAgent[] = [];

  for (let level = 0; level < levels.length; level++) {
    const row = levels[level];
    const rowWidth = row.length * DESK_SPACING_X;
    const startX = (canvasWidth - rowWidth) / 2 + DESK_SPACING_X / 2;

    for (let i = 0; i < row.length; i++) {
      const agent = row[i];
      positioned.push({
        agent,
        x: startX + i * DESK_SPACING_X,
        y: START_Y + level * DESK_SPACING_Y,
        task: taskByAgent.get(agent.id) ?? null,
      });
    }
  }

  return positioned;
}

// ── Status Legend ──────────────────────────────────────────────────────────

const STATUS_LEGEND = [
  { label: "Working", color: "#00e68a" },
  { label: "Idle", color: "#00f3ff" },
  { label: "Thinking", color: "#ffaa00" },
  { label: "Error", color: "#ff4466" },
  { label: "Paused", color: "#6b7280" },
];

const ROLE_LEGEND = [
  { label: "CEO", color: "#ffaa00" },
  { label: "CTO", color: "#00f3ff" },
  { label: "Engineer", color: "#00e68a" },
  { label: "Designer", color: "#bd00ff" },
  { label: "Marketer", color: "#ec4899" },
  { label: "Analyst", color: "#14b8a6" },
];

// ── Main Component ────────────────────────────────────────────────────────

export function VirtualWorkspace() {
  const { companyId } = useParams();
  const navigate = useNavigate();
  const { data: agents, isLoading: agentsLoading } = useAgents(companyId);
  const { data: tasks } = useTasks(companyId);

  const [zoom, setZoom] = useState(1);
  const [hoveredAgent, setHoveredAgent] = useState<string | null>(null);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 });
  const svgRef = useRef<SVGSVGElement>(null);

  // Auto-refresh tasks every 5s
  const { refetch: refetchTasks } = useTasks(companyId);
  useEffect(() => {
    const interval = setInterval(() => {
      refetchTasks();
    }, 5000);
    return () => clearInterval(interval);
  }, [refetchTasks]);

  // Canvas dimensions
  const CANVAS_W = 1200;
  const agentCount = agents?.length ?? 0;
  const CANVAS_H = Math.max(600, Math.ceil(agentCount / 4) * 200 + 200);

  // Position agents
  const positioned = useMemo(
    () => buildHierarchyPositions(agents ?? [], tasks ?? [], CANVAS_W),
    [agents, tasks],
  );

  // Build connection data from reporting relationships
  const connections = useMemo(() => {
    const posMap = new Map<string, PositionedAgent>();
    for (const p of positioned) posMap.set(p.agent.id, p);

    return positioned
      .filter((p) => p.agent.reportsTo && posMap.has(p.agent.reportsTo))
      .map((p) => {
        const parent = posMap.get(p.agent.reportsTo!)!;
        const childIsWorking = p.agent.status === "working" || p.agent.status === "in_progress";
        return {
          key: `${parent.agent.id}-${p.agent.id}`,
          x1: parent.x,
          y1: parent.y,
          x2: p.x,
          y2: p.y,
          type: (childIsWorking ? "delegation" : "reports-to") as "reports-to" | "delegation" | "communication",
          isActive: childIsWorking,
        };
      });
  }, [positioned]);

  // Pan handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setIsPanning(true);
    panStart.current = {
      x: e.clientX,
      y: e.clientY,
      offsetX: panOffset.x,
      offsetY: panOffset.y,
    };
  }, [panOffset]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning) return;
    const dx = e.clientX - panStart.current.x;
    const dy = e.clientY - panStart.current.y;
    setPanOffset({
      x: panStart.current.offsetX + dx / zoom,
      y: panStart.current.offsetY + dy / zoom,
    });
  }, [isPanning, zoom]);

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setZoom((z) => Math.min(2, Math.max(0.3, z + delta)));
  }, []);

  // Loading state
  if (agentsLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="relative h-16 w-16">
            <div
              className="absolute inset-0 rounded-full border-2 border-neon-cyan/30"
              style={{ animation: "spin-slow 3s linear infinite" }}
            />
            <div
              className="absolute inset-2 rounded-full border-2 border-t-neon-cyan border-r-transparent border-b-transparent border-l-transparent"
              style={{ animation: "spin-slow 1.5s linear infinite" }}
            />
          </div>
          <p className="text-sm text-text-secondary">Loading virtual workspace...</p>
        </div>
      </div>
    );
  }

  if (!agents?.length) {
    return (
      <div className="p-6">
        <EmptyState
          icon={
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          }
          title="No agents in workspace"
          description="Create agents to see them working in the virtual office."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-4 lg:px-8">
        <div>
          <h2 className="font-display text-xl font-bold text-text-primary tracking-tight">
            Virtual Workspace
          </h2>
          <p className="text-sm text-text-secondary mt-0.5">
            {agents.length} agent{agents.length !== 1 ? "s" : ""} in the office
            {" \u00b7 "}
            {agents.filter((a) => a.status === "working" || a.status === "in_progress").length} working
          </p>
        </div>

        {/* Zoom controls */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setZoom((z) => Math.max(0.3, z - 0.15))}
            className="flex h-8 w-8 items-center justify-center rounded-lg glass-raised text-text-secondary transition-all duration-200 hover:text-neon-cyan hover:shadow-sm hover:shadow-neon-cyan/10"
            aria-label="Zoom out"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <line x1="3" y1="7" x2="11" y2="7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <span className="min-w-[3.5rem] text-center text-xs font-semibold text-text-secondary font-display tabular-nums">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={() => setZoom((z) => Math.min(2, z + 0.15))}
            className="flex h-8 w-8 items-center justify-center rounded-lg glass-raised text-text-secondary transition-all duration-200 hover:text-neon-cyan hover:shadow-sm hover:shadow-neon-cyan/10"
            aria-label="Zoom in"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <line x1="3" y1="7" x2="11" y2="7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="7" y1="3" x2="7" y2="11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <button
            onClick={() => { setZoom(1); setPanOffset({ x: 0, y: 0 }); }}
            className="ml-1 rounded-lg glass-raised px-3 py-1.5 text-xs font-semibold text-text-secondary transition-all duration-200 hover:text-neon-cyan hover:shadow-sm hover:shadow-neon-cyan/10 font-display"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Workspace canvas */}
      <div className="relative flex-1 overflow-hidden bg-surface grid-bg">
        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          viewBox={`${-panOffset.x} ${-panOffset.y} ${CANVAS_W / zoom} ${CANVAS_H / zoom}`}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={handleWheel}
          style={{
            cursor: isPanning ? "grabbing" : "grab",
            userSelect: "none",
          }}
          role="img"
          aria-label="Virtual workspace showing AI agents working at their desks"
        >
          {/* Floor */}
          <FloorGrid width={CANVAS_W} height={CANVAS_H} />

          {/* Connection lines between agents */}
          <g>
            {connections.map((conn) => (
              <ConnectionLine
                key={conn.key}
                x1={conn.x1}
                y1={conn.y1}
                x2={conn.x2}
                y2={conn.y2}
                type={conn.type}
                isActive={conn.isActive}
              />
            ))}
          </g>

          {/* Desks */}
          <g>
            {positioned.map((p) => (
              <Desk
                key={`desk-${p.agent.id}`}
                x={p.x}
                y={p.y}
                role={p.agent.role}
                isActive={p.agent.status === "working" || p.agent.status === "in_progress"}
              />
            ))}
          </g>

          {/* Status bubbles (rendered before avatars so they appear behind on z) */}
          <g>
            {positioned.map((p) => {
              const isActive = p.agent.status === "working" || p.agent.status === "in_progress";
              return (
                <StatusBubble
                  key={`bubble-${p.agent.id}`}
                  x={p.x}
                  y={p.y}
                  taskTitle={p.task?.title ?? null}
                  status={p.agent.status}
                  isHovered={hoveredAgent === p.agent.id}
                  isActive={isActive}
                />
              );
            })}
          </g>

          {/* Agents */}
          <g>
            {positioned.map((p) => (
              <AgentAvatar
                key={`avatar-${p.agent.id}`}
                name={p.agent.name}
                role={p.agent.role}
                status={p.agent.status}
                title={p.agent.title}
                x={p.x}
                y={p.y - 30}
                isHovered={hoveredAgent === p.agent.id}
                onMouseEnter={() => setHoveredAgent(p.agent.id)}
                onMouseLeave={() => setHoveredAgent(null)}
                onClick={() => navigate(`/company/${companyId}/agents/${p.agent.id}`)}
              />
            ))}
          </g>
        </svg>

        {/* Legend overlay */}
        <div className="absolute bottom-4 left-4 flex gap-4 rounded-xl glass p-4 animate-workspace-slide-up">
          {/* Status legend */}
          <div className="flex flex-col gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary font-display">Status</span>
            {STATUS_LEGEND.map((s) => (
              <div key={s.label} className="flex items-center gap-2">
                <span
                  className="block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: s.color, boxShadow: `0 0 6px ${s.color}50` }}
                />
                <span className="text-[10px] text-text-secondary">{s.label}</span>
              </div>
            ))}
          </div>

          <div className="w-px bg-white/[0.06]" />

          {/* Role legend */}
          <div className="flex flex-col gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary font-display">Role</span>
            {ROLE_LEGEND.map((r) => (
              <div key={r.label} className="flex items-center gap-2">
                <span
                  className="block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: r.color, boxShadow: `0 0 6px ${r.color}50` }}
                />
                <span className="text-[10px] text-text-secondary">{r.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Agent count badge */}
        <div className="absolute right-4 bottom-4 rounded-xl glass px-4 py-3 animate-workspace-slide-up">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="block h-2.5 w-2.5 rounded-full bg-success" style={{ boxShadow: "0 0 8px rgba(0,230,138,0.4)" }} />
              <span className="text-xs font-semibold text-text-primary font-display tabular-nums">
                {agents.filter((a) => a.status === "working" || a.status === "in_progress").length}
              </span>
              <span className="text-[10px] text-text-secondary">active</span>
            </div>
            <div className="h-3 w-px bg-white/[0.06]" />
            <div className="flex items-center gap-2">
              <span className="block h-2.5 w-2.5 rounded-full bg-neon-cyan" style={{ boxShadow: "0 0 8px rgba(0,243,255,0.4)" }} />
              <span className="text-xs font-semibold text-text-primary font-display tabular-nums">
                {agents.filter((a) => a.status === "idle").length}
              </span>
              <span className="text-[10px] text-text-secondary">idle</span>
            </div>
            <div className="h-3 w-px bg-white/[0.06]" />
            <div className="flex items-center gap-2">
              <span className="block h-2.5 w-2.5 rounded-full bg-error" style={{ boxShadow: "0 0 8px rgba(255,68,102,0.4)" }} />
              <span className="text-xs font-semibold text-text-primary font-display tabular-nums">
                {agents.filter((a) => a.status === "error" || a.status === "failed").length}
              </span>
              <span className="text-[10px] text-text-secondary">error</span>
            </div>
          </div>
        </div>

        {/* Keyboard shortcut hints */}
        <div className="absolute right-4 top-4 rounded-xl glass px-3 py-2">
          <span className="text-[10px] text-text-secondary font-display">
            Scroll to zoom &middot; Drag to pan
          </span>
        </div>
      </div>
    </div>
  );
}
