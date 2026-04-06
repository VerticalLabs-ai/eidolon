interface ConnectionLineProps {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  type: "reports-to" | "communication" | "delegation";
  isActive: boolean;
}

const LINE_STYLES: Record<string, { stroke: string; dashArray: string; width: number }> = {
  "reports-to": { stroke: "#2e3345", dashArray: "none", width: 1 },
  communication: { stroke: "#4c6ef5", dashArray: "4 4", width: 1.2 },
  delegation: { stroke: "#f59e0b", dashArray: "8 3", width: 1.5 },
};

export function ConnectionLine({ x1, y1, x2, y2, type, isActive }: ConnectionLineProps) {
  const style = LINE_STYLES[type] ?? LINE_STYLES["reports-to"];

  // Calculate a curved path via control points
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  // Offset control point perpendicular to line
  const offset = Math.min(Math.abs(dy) * 0.3, 40);
  const cpX = midX + (dy > 0 ? -offset : offset) * 0.3;
  const cpY = midY - offset * 0.5;

  const pathD = `M ${x1} ${y1} Q ${cpX} ${cpY} ${x2} ${y2}`;

  return (
    <g opacity={isActive ? 0.7 : 0.25} style={{ transition: "opacity 0.3s ease" }}>
      {/* Glow layer for active connections */}
      {isActive && type !== "reports-to" && (
        <path
          d={pathD}
          fill="none"
          stroke={style.stroke}
          strokeWidth={style.width + 3}
          strokeOpacity="0.1"
          strokeLinecap="round"
        />
      )}

      {/* Main line */}
      <path
        d={pathD}
        fill="none"
        stroke={style.stroke}
        strokeWidth={style.width}
        strokeDasharray={style.dashArray}
        strokeLinecap="round"
        style={
          isActive && style.dashArray !== "none"
            ? { animation: "connection-flow 0.8s linear infinite" }
            : undefined
        }
      />

      {/* Directional arrow at endpoint */}
      {type === "delegation" && (
        <g transform={`translate(${x2}, ${y2})`}>
          <circle r="3" fill={style.stroke} fillOpacity="0.4" />
          <circle r="1.5" fill={style.stroke} />
        </g>
      )}

      {/* Pulse dot traveling along path for communication */}
      {isActive && type === "communication" && (
        <circle r="2.5" fill="#4c6ef5">
          <animateMotion dur="2s" repeatCount="indefinite" path={pathD} />
        </circle>
      )}
    </g>
  );
}
