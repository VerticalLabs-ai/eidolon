import { clsx } from "clsx";
import type { ReactNode } from "react";

interface StatCardProps {
  icon: ReactNode;
  label: string;
  value: string | number;
  trend?: { value: number; label: string };
  className?: string;
}

export function StatCard({ icon, label, value, trend, className }: StatCardProps) {
  return (
    <div
      className={clsx(
        "relative rounded-xl glass transition-all duration-200 p-5 hover:border-accent/15 group",
        className,
      )}
    >
      {/* Neon left accent */}
      <span className="absolute left-0 top-4 bottom-4 w-[2px] rounded-r-full bg-accent opacity-60 group-hover:opacity-100 transition-opacity duration-200" />

      <div className="flex items-start justify-between">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent">
          {icon}
        </div>
        {trend && (
          <span
            className={clsx(
              "inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-medium border backdrop-blur-sm",
              trend.value >= 0
                ? "bg-success/10 text-success border-success/20"
                : "bg-error/10 text-error border-error/20",
            )}
          >
            <span className="text-[10px]">{trend.value >= 0 ? "\u2191" : "\u2193"}</span>
            {trend.value >= 0 ? "+" : ""}
            {trend.value}%
          </span>
        )}
      </div>
      <div className="mt-4">
        <p className="text-2xl font-bold tabular-nums text-text-primary font-display">{value}</p>
        <p className="mt-0.5 text-sm text-text-secondary">{label}</p>
      </div>
      {trend && (
        <p className="mt-2 text-xs text-text-muted">{trend.label}</p>
      )}
    </div>
  );
}
