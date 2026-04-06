import { clsx } from "clsx";

interface SkeletonProps {
  className?: string;
  lines?: number;
  circle?: boolean;
}

export function Skeleton({ className, lines = 1, circle = false }: SkeletonProps) {
  if (circle) {
    return (
      <div
        className={clsx(
          "rounded-full bg-[#0a0a0a] skeleton-shimmer",
          className ?? "h-10 w-10",
        )}
      />
    );
  }

  return (
    <div className={clsx("space-y-2.5", className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className={clsx(
            "h-3 rounded-md bg-[#0a0a0a] skeleton-shimmer",
            i === lines - 1 && lines > 1 && "w-3/4",
          )}
          style={{ animationDelay: `${i * 0.08}s` }}
        />
      ))}
    </div>
  );
}
