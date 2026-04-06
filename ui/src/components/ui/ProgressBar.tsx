import { clsx } from "clsx";

interface ProgressBarProps {
  value: number;
  max?: number;
  label?: string;
  showValue?: boolean;
  size?: "sm" | "md";
  color?: "blue" | "green" | "warning" | "error";
  className?: string;
}

const colorClasses = {
  blue: "bg-accent",
  green: "bg-success",
  warning: "bg-warning",
  error: "bg-error",
};

function getAutoColor(pct: number): "green" | "warning" | "error" {
  if (pct >= 90) return "error";
  if (pct >= 70) return "warning";
  return "green";
}

export function ProgressBar({
  value,
  max = 100,
  label,
  showValue = true,
  size = "md",
  color,
  className,
}: ProgressBarProps) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const resolvedColor = color || getAutoColor(pct);

  return (
    <div className={clsx("space-y-1.5", className)}>
      {(label || showValue) && (
        <div className="flex items-center justify-between text-xs">
          {label && <span className="text-text-secondary">{label}</span>}
          {showValue && (
            <span className="text-text-secondary tabular-nums">
              {Math.round(pct)}%
            </span>
          )}
        </div>
      )}
      <div
        className={clsx(
          "w-full overflow-hidden rounded-full bg-white/[0.04]",
          size === "sm" ? "h-1" : "h-2",
        )}
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
      >
        <div
          className={clsx(
            "h-full rounded-full transition-all duration-500 ease-out",
            colorClasses[resolvedColor],
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
