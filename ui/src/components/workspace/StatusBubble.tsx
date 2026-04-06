interface StatusBubbleProps {
  x: number;
  y: number;
  taskTitle: string | null;
  status: string;
  isHovered: boolean;
  isActive: boolean;
}

function StatusIcon({ status }: { status: string }) {
  const s = status.toLowerCase();

  if (s === "working" || s === "in_progress") {
    return (
      <g>
        {/* Spinning gear */}
        <circle cx="0" cy="0" r="4" fill="none" stroke="#10b981" strokeWidth="1.5" strokeDasharray="3 2" className="animate-spin-slow" style={{ transformOrigin: "0 0" }} />
        <circle cx="0" cy="0" r="1.5" fill="#10b981" />
      </g>
    );
  }

  if (s === "error" || s === "failed") {
    return (
      <g>
        <circle cx="0" cy="0" r="4" fill="#ef4444" fillOpacity="0.2" />
        <line x1="-2" y1="-2" x2="2" y2="2" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="2" y1="-2" x2="-2" y2="2" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
      </g>
    );
  }

  if (s === "paused") {
    return (
      <g>
        <circle cx="0" cy="0" r="4" fill="#f59e0b" fillOpacity="0.2" />
        <rect x="-2.5" y="-2.5" width="2" height="5" rx="0.5" fill="#f59e0b" />
        <rect x="0.5" y="-2.5" width="2" height="5" rx="0.5" fill="#f59e0b" />
      </g>
    );
  }

  // idle
  return (
    <g>
      <circle cx="0" cy="0" r="4" fill="#4c6ef5" fillOpacity="0.2" />
      <circle cx="0" cy="0" r="2" fill="#4c6ef5" fillOpacity="0.5" className="animate-breathe" style={{ transformOrigin: "0 0" }} />
    </g>
  );
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 1) + "\u2026" : text;
}

export function StatusBubble({ x, y, taskTitle, status, isHovered, isActive }: StatusBubbleProps) {
  const show = isHovered || isActive;
  const bubbleWidth = isHovered ? 160 : 120;
  const bubbleHeight = isHovered && taskTitle ? 44 : 28;

  return (
    <g
      transform={`translate(${x}, ${y - 70})`}
      opacity={show ? 1 : 0}
      style={{
        transition: "opacity 0.3s ease",
        pointerEvents: "none",
      }}
    >
      {/* Connector line */}
      <line x1="0" y1={bubbleHeight + 4} x2="0" y2={bubbleHeight + 16} stroke="#2e3345" strokeWidth="1" strokeDasharray="2 2" opacity="0.5" />

      {/* Bubble background */}
      <rect
        x={-bubbleWidth / 2}
        y="0"
        width={bubbleWidth}
        height={bubbleHeight}
        rx="8"
        fill="#1a1d28"
        stroke="#2e3345"
        strokeWidth="1"
        className={show ? "animate-workspace-slide-up" : ""}
      />

      {/* Glow effect */}
      <rect
        x={-bubbleWidth / 2}
        y="0"
        width={bubbleWidth}
        height={bubbleHeight}
        rx="8"
        fill="none"
        stroke={status === "working" ? "#10b981" : status === "error" ? "#ef4444" : "#4c6ef5"}
        strokeWidth="0.5"
        strokeOpacity="0.3"
      />

      {/* Status icon */}
      <g transform={`translate(${-bubbleWidth / 2 + 14}, 14)`}>
        <StatusIcon status={status} />
      </g>

      {/* Status text */}
      <text
        x={-bubbleWidth / 2 + 26}
        y="17"
        fill="#e8eaed"
        fontSize="10"
        fontFamily="system-ui, sans-serif"
        fontWeight="500"
      >
        {status.charAt(0).toUpperCase() + status.slice(1).replace("_", " ")}
      </text>

      {/* Task title on hover */}
      {isHovered && taskTitle && (
        <text
          x={-bubbleWidth / 2 + 10}
          y="36"
          fill="#9ca3af"
          fontSize="8.5"
          fontFamily="system-ui, sans-serif"
        >
          {truncate(taskTitle, 22)}
        </text>
      )}

      {/* Progress dots for working status */}
      {(status === "working" || status === "in_progress") && (
        <g transform={`translate(${bubbleWidth / 2 - 20}, 14)`}>
          <circle cx="0" cy="0" r="1.5" fill="#10b981" style={{ animation: "typing 1s ease-in-out 0s infinite" }} />
          <circle cx="5" cy="0" r="1.5" fill="#10b981" style={{ animation: "typing 1s ease-in-out 0.2s infinite" }} />
          <circle cx="10" cy="0" r="1.5" fill="#10b981" style={{ animation: "typing 1s ease-in-out 0.4s infinite" }} />
        </g>
      )}
    </g>
  );
}
