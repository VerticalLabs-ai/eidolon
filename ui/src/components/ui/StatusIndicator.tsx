import { clsx } from "clsx";

type Status = "working" | "idle" | "error" | "offline" | "connected" | "disconnected";

interface StatusIndicatorProps {
  status: Status;
  label?: string;
  size?: "sm" | "md";
}

const statusColors: Record<Status, string> = {
  working: "bg-neon-cyan",
  idle: "bg-warning",
  error: "bg-error",
  offline: "bg-text-secondary/30",
  connected: "bg-neon-cyan",
  disconnected: "bg-text-secondary/30",
};

const statusGlow: Record<Status, string> = {
  working: "shadow-[0_0_8px_rgba(0,243,255,0.6)]",
  idle: "shadow-[0_0_6px_rgba(255,170,0,0.4)]",
  error: "shadow-[0_0_6px_rgba(255,68,102,0.5)]",
  offline: "",
  connected: "shadow-[0_0_8px_rgba(0,243,255,0.6)]",
  disconnected: "",
};

const statusLabels: Record<Status, string> = {
  working: "Working",
  idle: "Idle",
  error: "Error",
  offline: "Offline",
  connected: "Connected",
  disconnected: "Disconnected",
};

export function StatusIndicator({
  status,
  label,
  size = "md",
}: StatusIndicatorProps) {
  const animate = status === "working" || status === "connected";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="relative flex">
        <span
          className={clsx(
            "rounded-full",
            statusColors[status],
            statusGlow[status],
            size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2",
          )}
        />
        {animate && (
          <span
            className={clsx(
              "absolute inset-0 rounded-full animate-ping opacity-60",
              statusColors[status],
              size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2",
            )}
          />
        )}
      </span>
      {label !== undefined ? (
        <span className="text-xs text-text-secondary capitalize">
          {label || statusLabels[status]}
        </span>
      ) : null}
    </span>
  );
}
