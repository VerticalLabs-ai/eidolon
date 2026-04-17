import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { clsx } from "clsx";
import { useServerEvents } from "@/lib/ws";
import type { Execution } from "@/lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LogEntry = NonNullable<Execution["log"]>[number];

type Phase = "observe" | "think" | "act" | "reflect";

interface Props {
  companyId: string;
  execution: Execution;
}

// ---------------------------------------------------------------------------
// Phase presentation
// ---------------------------------------------------------------------------

const phaseLabels: Record<Phase, string> = {
  observe: "Observe",
  think: "Think",
  act: "Act",
  reflect: "Reflect",
};

const phaseTint: Record<Phase, string> = {
  observe:
    "bg-neon-cyan/10 text-neon-cyan border-neon-cyan/20",
  think:
    "bg-neon-purple/10 text-neon-purple border-neon-purple/20",
  act: "bg-success/10 text-success border-success/20",
  reflect: "bg-warning/10 text-warning border-warning/20",
};

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Dedupe helper — server payload may arrive twice (initial load + WS replay)
// ---------------------------------------------------------------------------

function dedupeEntries(entries: LogEntry[]): LogEntry[] {
  const seen = new Set<string>();
  const out: LogEntry[] = [];
  for (const entry of entries) {
    const key = `${entry.timestamp}|${entry.phase ?? ""}|${entry.iteration ?? ""}|${(entry.content ?? entry.message).slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TranscriptView({ companyId, execution }: Props) {
  const [liveEntries, setLiveEntries] = useState<LogEntry[]>([]);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());

  // Reset live buffer whenever we switch which execution is being viewed
  useEffect(() => {
    setLiveEntries([]);
    setExpandedTools(new Set());
  }, [execution.id]);

  // Subscribe to execution.log events for THIS execution only
  useServerEvents(companyId, "execution.log", (event) => {
    const payload = event.payload as {
      executionId?: string;
      step?: {
        phase?: Phase;
        content?: string;
        timestamp?: string;
        toolCalls?: LogEntry["toolCalls"];
      };
      iteration?: number;
    };
    if (payload.executionId !== execution.id || !payload.step) return;

    const next: LogEntry = {
      timestamp: payload.step.timestamp ?? event.timestamp,
      level: "info",
      message:
        payload.step.content?.slice(0, 200) ??
        `[${payload.step.phase ?? "act"}] iteration ${payload.iteration ?? ""}`,
      phase: payload.step.phase,
      iteration: payload.iteration,
      content: payload.step.content,
      toolCalls: payload.step.toolCalls,
    };

    setLiveEntries((prev) => [...prev, next]);
  });

  const entries = useMemo(
    () => dedupeEntries([...(execution.log ?? []), ...liveEntries]),
    [execution.log, liveEntries],
  );

  if (entries.length === 0) {
    return (
      <div className="rounded-lg border border-white/[0.06] bg-black/20 px-4 py-6 text-center text-xs text-text-secondary">
        No transcript yet. Run the agent on this task to see the Observe →
        Think → Act → Reflect trace here.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {entries.map((entry, idx) => {
        const phase = (entry.phase ?? "act") as Phase;
        const toolKey = `${execution.id}:${idx}`;
        const toolOpen = expandedTools.has(toolKey);
        const hasTools = !!entry.toolCalls && entry.toolCalls.length > 0;
        const content = entry.content ?? entry.message;

        return (
          <div
            key={toolKey}
            className={clsx(
              "rounded-lg border bg-surface/40 px-4 py-3 backdrop-blur-sm",
              entry.level === "error"
                ? "border-error/25"
                : "border-white/[0.06]",
            )}
          >
            <div className="flex items-center justify-between gap-3 text-[11px] text-text-secondary font-display">
              <div className="flex items-center gap-2">
                <span
                  className={clsx(
                    "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
                    phaseTint[phase],
                  )}
                >
                  {phaseLabels[phase]}
                </span>
                {entry.iteration != null && (
                  <span className="text-text-secondary">
                    iteration {entry.iteration}
                  </span>
                )}
              </div>
              <span className="tabular-nums">
                {formatTime(entry.timestamp)}
              </span>
            </div>

            <pre
              className={clsx(
                "mt-2 whitespace-pre-wrap font-sans text-sm leading-relaxed",
                entry.level === "error"
                  ? "text-error"
                  : "text-text-primary",
              )}
            >
              {content}
            </pre>

            {hasTools && (
              <button
                onClick={() =>
                  setExpandedTools((prev) => {
                    const next = new Set(prev);
                    if (next.has(toolKey)) {
                      next.delete(toolKey);
                    } else {
                      next.add(toolKey);
                    }
                    return next;
                  })
                }
                className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-medium text-neon-cyan hover:text-neon-cyan/80"
              >
                {toolOpen ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                <Wrench className="h-3 w-3" />
                {entry.toolCalls!.length} tool call
                {entry.toolCalls!.length === 1 ? "" : "s"}
              </button>
            )}

            {hasTools && toolOpen && (
              <div className="mt-2 space-y-2">
                {entry.toolCalls!.map((tc, tcIdx) => (
                  <div
                    key={tcIdx}
                    className="rounded-md border border-neon-cyan/15 bg-black/30 p-3"
                  >
                    <p className="text-[11px] font-medium text-neon-cyan">
                      {tc.tool}
                      {tc.serverId && (
                        <span className="ml-2 text-text-secondary">
                          · server {tc.serverId.slice(0, 8)}
                        </span>
                      )}
                    </p>
                    <div className="mt-1.5">
                      <p className="text-[10px] uppercase tracking-wider text-text-secondary">
                        Arguments
                      </p>
                      <pre className="mt-1 max-h-48 overflow-auto rounded bg-black/40 p-2 text-[11px] leading-snug text-text-primary">
                        {JSON.stringify(tc.args, null, 2)}
                      </pre>
                    </div>
                    <div className="mt-2">
                      <p className="text-[10px] uppercase tracking-wider text-text-secondary">
                        Result
                      </p>
                      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-2 text-[11px] leading-snug text-text-primary">
                        {tc.result}
                      </pre>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
