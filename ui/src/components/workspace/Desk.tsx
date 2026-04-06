import { useMemo } from "react";

interface DeskProps {
  x: number;
  y: number;
  role: string;
  isActive: boolean;
}

const ROLE_ACCENT: Record<string, string> = {
  ceo: "#f59e0b",
  cto: "#4c6ef5",
  engineer: "#10b981",
  designer: "#a855f7",
  marketer: "#ec4899",
  analyst: "#14b8a6",
};

function getAccent(role: string): string {
  const key = role.toLowerCase();
  for (const [k, v] of Object.entries(ROLE_ACCENT)) {
    if (key.includes(k)) return v;
  }
  return "#6b7280";
}

export function Desk({ x, y, role, isActive }: DeskProps) {
  const accent = useMemo(() => getAccent(role), [role]);
  const isCeo = role.toLowerCase().includes("ceo");

  return (
    <g transform={`translate(${x}, ${y})`}>
      {/* Shadow */}
      <ellipse cx="0" cy="30" rx="52" ry="12" fill="black" fillOpacity="0.25" />

      {/* Chair - behind desk */}
      <g transform="translate(0, 14)">
        {/* Chair back */}
        <rect x="-14" y="-8" width="28" height="20" rx="6" fill="#1a1d28" stroke="#2e3345" strokeWidth="0.8" />
        {/* Chair seat */}
        <ellipse cx="0" cy="14" rx="16" ry="6" fill="#232733" stroke="#2e3345" strokeWidth="0.5" />
      </g>

      {/* Desk surface - isometric style */}
      <g transform="translate(0, -8)">
        {/* Desk top */}
        <rect x="-44" y="0" width="88" height="36" rx="4" fill="#1a1d28" stroke="#2e3345" strokeWidth="1" />
        {/* Desk surface highlight */}
        <rect x="-42" y="2" width="84" height="32" rx="3" fill="#232733" fillOpacity="0.5" />

        {/* Monitor */}
        <g transform="translate(0, -20)">
          {/* Monitor stand */}
          <rect x="-3" y="16" width="6" height="8" fill="#2e3345" rx="1" />
          {/* Monitor base */}
          <rect x="-10" y="22" width="20" height="3" rx="1.5" fill="#2e3345" />
          {/* Monitor frame */}
          <rect x="-22" y="-2" width="44" height="20" rx="2" fill="#0f1117" stroke="#2e3345" strokeWidth="1" />
          {/* Screen */}
          <rect
            x="-20"
            y="0"
            width="40"
            height="16"
            rx="1"
            fill={isActive ? accent : "#1a1d28"}
            fillOpacity={isActive ? 0.15 : 1}
            className={isActive ? "animate-screen-flicker" : ""}
          />
          {/* Screen content lines */}
          {isActive && (
            <g opacity="0.5">
              <rect x="-16" y="3" width="20" height="1.5" rx="0.75" fill={accent} fillOpacity="0.4" />
              <rect x="-16" y="6.5" width="14" height="1.5" rx="0.75" fill={accent} fillOpacity="0.3" />
              <rect x="-16" y="10" width="24" height="1.5" rx="0.75" fill={accent} fillOpacity="0.25" />
            </g>
          )}
          {/* Power LED */}
          <circle cx="0" cy="17" r="1" fill={isActive ? "#10b981" : "#2e3345"} />
        </g>

        {/* Keyboard */}
        <rect x="-16" y="10" width="32" height="10" rx="2" fill="#0f1117" stroke="#2e3345" strokeWidth="0.5" />
        {/* Key rows */}
        <g opacity="0.3">
          <rect x="-14" y="12" width="28" height="1.5" rx="0.5" fill="#2e3345" />
          <rect x="-14" y="15" width="28" height="1.5" rx="0.5" fill="#2e3345" />
        </g>

        {/* Desk details based on role */}
        {isCeo && (
          /* Plant for CEO */
          <g transform="translate(32, 4)">
            <rect x="-3" y="4" width="6" height="8" rx="1" fill="#2e3345" />
            <circle cx="0" cy="2" r="5" fill="#10b981" fillOpacity="0.4" />
            <circle cx="-2" cy="0" r="3" fill="#10b981" fillOpacity="0.3" />
          </g>
        )}

        {/* Coffee cup for everyone */}
        <g transform="translate(-32, 6)">
          <rect x="-3" y="0" width="6" height="7" rx="1.5" fill="#2e3345" />
          {/* Handle */}
          <path d="M 3 1.5 Q 6 1.5 6 4 Q 6 6 3 6" fill="none" stroke="#2e3345" strokeWidth="1" />
          {/* Steam */}
          {isActive && (
            <g opacity="0.3">
              <path
                d="M -1 -1 Q 0 -4 1 -1"
                fill="none"
                stroke="#9ca3af"
                strokeWidth="0.5"
                style={{ animation: "float 2s ease-in-out infinite" }}
              />
              <path
                d="M 1 -1 Q 2 -4 3 -1"
                fill="none"
                stroke="#9ca3af"
                strokeWidth="0.5"
                style={{ animation: "float 2s ease-in-out 0.5s infinite" }}
              />
            </g>
          )}
        </g>
      </g>
    </g>
  );
}
