import { useMemo } from "react";

interface AgentAvatarProps {
  name: string;
  role: string;
  status: string;
  title: string | null;
  x: number;
  y: number;
  isHovered: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onClick: () => void;
}

interface RoleTheme {
  primary: string;
  secondary: string;
  icon: React.ReactNode;
}

function getRoleTheme(role: string): RoleTheme {
  const r = role.toLowerCase();

  if (r.includes("ceo") || r.includes("chief executive")) {
    return {
      primary: "#f59e0b",
      secondary: "#d97706",
      icon: (
        /* Crown */
        <g transform="translate(-6, -6) scale(0.5)">
          <path d="M12 2 L15 8 L22 6 L19 14 L5 14 L2 6 L9 8 Z" fill="#f59e0b" />
          <circle cx="4" cy="5" r="1.5" fill="#fbbf24" />
          <circle cx="12" cy="1" r="1.5" fill="#fbbf24" />
          <circle cx="20" cy="5" r="1.5" fill="#fbbf24" />
        </g>
      ),
    };
  }

  if (r.includes("cto") || r.includes("chief tech")) {
    return {
      primary: "#4c6ef5",
      secondary: "#3b5bdb",
      icon: (
        /* Gear */
        <g transform="translate(0, 0)">
          <circle cx="0" cy="0" r="3" fill="none" stroke="#4c6ef5" strokeWidth="1.5" />
          {[0, 60, 120, 180, 240, 300].map((a) => (
            <rect
              key={a}
              x="-1"
              y="-5.5"
              width="2"
              height="3"
              rx="0.5"
              fill="#4c6ef5"
              transform={`rotate(${a})`}
            />
          ))}
        </g>
      ),
    };
  }

  if (r.includes("engineer") || r.includes("developer") || r.includes("dev")) {
    return {
      primary: "#10b981",
      secondary: "#059669",
      icon: (
        /* Code brackets */
        <g>
          <text x="-5" y="4" fill="#10b981" fontSize="11" fontFamily="monospace" fontWeight="bold">&lt;/&gt;</text>
        </g>
      ),
    };
  }

  if (r.includes("design")) {
    return {
      primary: "#a855f7",
      secondary: "#9333ea",
      icon: (
        /* Palette */
        <g>
          <circle cx="-2" cy="-2" r="2" fill="#a855f7" fillOpacity="0.8" />
          <circle cx="2" cy="-2" r="2" fill="#c084fc" fillOpacity="0.8" />
          <circle cx="0" cy="2" r="2" fill="#7c3aed" fillOpacity="0.8" />
        </g>
      ),
    };
  }

  if (r.includes("market") || r.includes("cmo") || r.includes("growth")) {
    return {
      primary: "#ec4899",
      secondary: "#db2777",
      icon: (
        /* Megaphone */
        <g>
          <path d="M -4 -2 L 2 -4 L 2 4 L -4 2 Z" fill="#ec4899" />
          <rect x="-6" y="-1.5" width="3" height="3" rx="0.5" fill="#ec4899" fillOpacity="0.7" />
          <line x1="3" y1="-3" x2="5" y2="-4" stroke="#ec4899" strokeWidth="1" strokeLinecap="round" />
          <line x1="3" y1="0" x2="6" y2="0" stroke="#ec4899" strokeWidth="1" strokeLinecap="round" />
          <line x1="3" y1="3" x2="5" y2="4" stroke="#ec4899" strokeWidth="1" strokeLinecap="round" />
        </g>
      ),
    };
  }

  if (r.includes("analyst") || r.includes("data") || r.includes("cfo")) {
    return {
      primary: "#14b8a6",
      secondary: "#0d9488",
      icon: (
        /* Chart */
        <g>
          <rect x="-4" y="0" width="2" height="4" rx="0.5" fill="#14b8a6" />
          <rect x="-1" y="-2" width="2" height="6" rx="0.5" fill="#14b8a6" fillOpacity="0.8" />
          <rect x="2" y="-4" width="2" height="8" rx="0.5" fill="#14b8a6" fillOpacity="0.6" />
        </g>
      ),
    };
  }

  // Custom / default
  return {
    primary: "#6b7280",
    secondary: "#4b5563",
    icon: (
      /* Star */
      <g>
        <path
          d="M 0 -4 L 1.2 -1.2 L 4 -1.2 L 2 0.8 L 2.8 4 L 0 2.4 L -2.8 4 L -2 0.8 L -4 -1.2 L -1.2 -1.2 Z"
          fill="#6b7280"
        />
      </g>
    ),
  };
}

function WorkingParticles({ color }: { color: string }) {
  const particles = useMemo(() => {
    return Array.from({ length: 6 }, (_, i) => ({
      x: -10 + Math.random() * 20,
      delay: i * 0.4,
      duration: 1.5 + Math.random(),
      char: ["0", "1", "{", "}", ";", "=", "<", ">", "/"][Math.floor(Math.random() * 9)],
    }));
  }, []);

  return (
    <g>
      {particles.map((p, i) => (
        <text
          key={i}
          x={p.x}
          y="0"
          fill={color}
          fontSize="7"
          fontFamily="monospace"
          opacity="0"
          style={{
            animation: `particle-float ${p.duration}s ease-out ${p.delay}s infinite`,
          }}
        >
          {p.char}
        </text>
      ))}
    </g>
  );
}

function ThinkingIndicator({ color }: { color: string }) {
  return (
    <g transform="translate(16, -16)">
      {/* Thought bubbles */}
      <circle cx="0" cy="0" r="2" fill={color} fillOpacity="0.3" style={{ animation: "float 1.5s ease-in-out infinite" }} />
      <circle cx="4" cy="-5" r="3" fill={color} fillOpacity="0.3" style={{ animation: "float 1.5s ease-in-out 0.2s infinite" }} />
      <circle cx="7" cy="-12" r="5" fill={color} fillOpacity="0.2" stroke={color} strokeWidth="0.5" strokeOpacity="0.3" style={{ animation: "float 1.5s ease-in-out 0.4s infinite" }} />
      {/* Gear inside thought */}
      <g transform="translate(7, -12)" style={{ animation: "spin-slow 3s linear infinite", transformOrigin: "0 0" }}>
        <circle cx="0" cy="0" r="2" fill="none" stroke={color} strokeWidth="1" />
        {[0, 90, 180, 270].map((a) => (
          <rect key={a} x="-0.5" y="-3.5" width="1" height="2" rx="0.3" fill={color} transform={`rotate(${a})`} />
        ))}
      </g>
    </g>
  );
}

export function AgentAvatar({
  name,
  role,
  status,
  title,
  x,
  y,
  isHovered,
  onMouseEnter,
  onMouseLeave,
  onClick,
}: AgentAvatarProps) {
  const theme = useMemo(() => getRoleTheme(role), [role]);
  const s = status.toLowerCase();
  const isWorking = s === "working" || s === "in_progress";
  const isThinking = s === "thinking" || s === "planning";
  const isError = s === "error" || s === "failed";
  const isPaused = s === "paused";
  const isIdle = !isWorking && !isThinking && !isError && !isPaused;

  // Animation class selection
  let avatarAnimation = "";
  if (isWorking) avatarAnimation = "";
  else if (isThinking) avatarAnimation = "";
  else if (isError) avatarAnimation = "animate-pulse-glow";
  else if (isPaused) avatarAnimation = "";
  else avatarAnimation = ""; // idle float handled inline

  return (
    <g
      transform={`translate(${x}, ${y})`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
      style={{ cursor: "pointer" }}
    >
      {/* Hover highlight ring */}
      <circle
        cx="0"
        cy="-12"
        r="22"
        fill={theme.primary}
        fillOpacity={isHovered ? 0.06 : 0}
        stroke={theme.primary}
        strokeWidth={isHovered ? 1 : 0}
        strokeOpacity="0.2"
        style={{ transition: "all 0.3s ease" }}
      />

      {/* Character group with animation */}
      <g
        style={
          isIdle
            ? { animation: "float 3s ease-in-out infinite" }
            : isWorking
              ? { animation: "breathe 1.5s ease-in-out infinite" }
              : isPaused
                ? { opacity: 0.5 }
                : undefined
        }
      >
        {/* Body / shoulders */}
        <g transform="translate(0, 2)">
          <path
            d="M -10 4 Q -10 -2 -4 -4 L 4 -4 Q 10 -2 10 4 L 10 10 L -10 10 Z"
            fill={theme.primary}
            fillOpacity="0.25"
            stroke={theme.primary}
            strokeWidth="0.8"
            strokeOpacity="0.4"
          />
          {/* Shirt detail */}
          <line x1="0" y1="-3" x2="0" y2="8" stroke={theme.primary} strokeWidth="0.5" strokeOpacity="0.2" />
        </g>

        {/* Head */}
        <g transform="translate(0, -12)">
          {/* Head glow */}
          <circle
            cx="0"
            cy="0"
            r="13"
            fill={theme.primary}
            fillOpacity="0.05"
            className={isError ? "animate-pulse-glow" : ""}
            style={isError ? { color: "#ef4444" } : undefined}
          />

          {/* Head circle */}
          <circle
            cx="0"
            cy="0"
            r="11"
            fill="#1a1d28"
            stroke={isError ? "#ef4444" : theme.primary}
            strokeWidth="1.5"
            strokeOpacity={isError ? 0.8 : 0.6}
          />

          {/* Face */}
          <g>
            {/* Eyes */}
            <g className="animate-blink" style={{ transformOrigin: "-3.5px 0px" }}>
              <circle cx="-3.5" cy="-1" r="1.5" fill={theme.primary} />
            </g>
            <g className="animate-blink" style={{ transformOrigin: "3.5px 0px" }}>
              <circle cx="3.5" cy="-1" r="1.5" fill={theme.primary} />
            </g>

            {/* Eye highlights */}
            <circle cx="-3" cy="-1.5" r="0.5" fill="white" fillOpacity="0.6" />
            <circle cx="4" cy="-1.5" r="0.5" fill="white" fillOpacity="0.6" />

            {/* Mouth */}
            {isWorking ? (
              <rect x="-2" y="3" width="4" height="1.5" rx="0.75" fill={theme.primary} fillOpacity="0.5" />
            ) : isError ? (
              <path d="M -3 5 Q 0 3 3 5" fill="none" stroke="#ef4444" strokeWidth="1" strokeLinecap="round" />
            ) : (
              <path d="M -3 3 Q 0 5.5 3 3" fill="none" stroke={theme.primary} strokeWidth="1" strokeLinecap="round" strokeOpacity="0.6" />
            )}
          </g>

          {/* Role badge icon */}
          <g transform="translate(0, -14)">
            {theme.icon}
          </g>
        </g>

        {/* Working particles */}
        {isWorking && (
          <g transform="translate(0, -20)">
            <WorkingParticles color={theme.primary} />
          </g>
        )}

        {/* Thinking indicator */}
        {isThinking && <ThinkingIndicator color={theme.primary} />}

        {/* Error pulse ring */}
        {isError && (
          <circle
            cx="0"
            cy="-12"
            r="14"
            fill="none"
            stroke="#ef4444"
            strokeWidth="1"
            opacity="0.4"
            style={{ animation: "pulse-glow 1.5s ease-in-out infinite", color: "#ef4444" }}
          />
        )}
      </g>

      {/* Name label */}
      <g transform="translate(0, 22)">
        <text
          x="0"
          y="0"
          textAnchor="middle"
          fill="#e8eaed"
          fontSize="10"
          fontFamily="system-ui, sans-serif"
          fontWeight="600"
        >
          {name.length > 14 ? name.slice(0, 13) + "\u2026" : name}
        </text>
        <text
          x="0"
          y="13"
          textAnchor="middle"
          fill="#9ca3af"
          fontSize="8"
          fontFamily="system-ui, sans-serif"
        >
          {(title ?? role).length > 18 ? (title ?? role).slice(0, 17) + "\u2026" : (title ?? role)}
        </text>
      </g>
    </g>
  );
}
