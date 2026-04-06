import { clsx } from "clsx";
import type { ReactNode } from "react";

type BadgeVariant =
  | "default"
  | "success"
  | "warning"
  | "error"
  | "info"
  | "critical"
  | "high"
  | "medium"
  | "low";

interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  className?: string;
}

const variantClasses: Record<BadgeVariant, string> = {
  default: "bg-white/[0.06] text-text-secondary border-white/[0.08]",
  success: "bg-success/10 text-success border-success/20",
  warning: "bg-warning/10 text-warning border-warning/20",
  error: "bg-error/10 text-error border-error/20",
  info: "bg-neon-cyan/10 text-neon-cyan border-neon-cyan/20 shadow-[0_0_10px_rgba(0,243,255,0.08)]",
  critical: "bg-error/10 text-error border-error/20",
  high: "bg-warning/10 text-warning border-warning/20",
  medium: "bg-neon-cyan/10 text-eidolon-200 border-neon-cyan/15",
  low: "bg-white/[0.04] text-text-secondary border-white/[0.08]",
};

export function Badge({ children, variant = "default", className }: BadgeProps) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium leading-tight border backdrop-blur-sm",
        variantClasses[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
