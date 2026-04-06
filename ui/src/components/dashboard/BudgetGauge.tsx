import { clsx } from "clsx";

interface BudgetGaugeProps {
  used: number;
  total: number;
  label?: string;
  size?: number;
  className?: string;
}

export function BudgetGauge({
  used,
  total,
  label = "Budget",
  size = 120,
  className,
}: BudgetGaugeProps) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const radius = (size - 12) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - pct / 100);

  const gradientId = `gauge-gradient-${label.replace(/\s+/g, "-")}`;
  const glowId = `gauge-glow-${label.replace(/\s+/g, "-")}`;

  return (
    <div className={clsx("flex flex-col items-center gap-2", className)}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="-rotate-90"
        >
          <defs>
            <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#F0B429" />
              <stop offset="100%" stopColor="#C4911F" />
            </linearGradient>
            <filter id={glowId}>
              <feGaussianBlur stdDeviation="3" result="coloredBlur" />
              <feMerge>
                <feMergeNode in="coloredBlur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          {/* Track */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="rgba(255,255,255,0.04)"
            strokeWidth={6}
          />
          {/* Fill arc with gradient and glow */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={`url(#${gradientId})`}
            strokeWidth={6}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            className="transition-all duration-700 ease-out"
            filter={`url(#${glowId})`}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-bold tabular-nums text-text-primary font-display">
            {Math.round(pct)}%
          </span>
          <span className="text-[10px] text-text-secondary">used</span>
        </div>
      </div>
      <div className="text-center">
        <p className="text-xs font-medium text-text-primary font-display">{label}</p>
        <p className="text-[10px] text-text-secondary tabular-nums">
          ${used.toLocaleString()} / ${total.toLocaleString()}
        </p>
      </div>
    </div>
  );
}
