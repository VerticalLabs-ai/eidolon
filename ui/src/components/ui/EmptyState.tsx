import type { ReactNode } from "react";
import { clsx } from "clsx";

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={clsx(
        "flex flex-col items-center justify-center py-16 px-4 text-center glass rounded-xl",
        className,
      )}
    >
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-neon-cyan/10 text-neon-cyan shadow-[0_0_20px_rgba(0,243,255,0.1)]">
        {icon}
      </div>
      <h3 className="text-sm font-semibold text-text-primary font-display">{title}</h3>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-text-secondary">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
