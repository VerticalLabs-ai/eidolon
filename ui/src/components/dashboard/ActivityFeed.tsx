import { formatDistanceToNow } from "date-fns";
import {
  CheckCircle2,
  MessageSquare,
  AlertCircle,
  Play,
  UserPlus,
  Target,
} from "lucide-react";
import { clsx } from "clsx";
import type { ReactNode } from "react";

interface ActivityItem {
  id: string;
  type: string;
  title: string;
  description?: string | null;
  timestamp: string;
  agentName?: string;
}

interface ActivityFeedProps {
  items: ActivityItem[];
  className?: string;
}

const iconMap: Record<ActivityItem["type"], { icon: ReactNode; dot: string }> = {
  task_completed: {
    icon: <CheckCircle2 className="h-4 w-4 text-success" />,
    dot: "bg-success shadow-[0_0_6px_rgba(0,230,138,0.5)]",
  },
  message: {
    icon: <MessageSquare className="h-4 w-4 text-neon-cyan" />,
    dot: "bg-neon-cyan shadow-[0_0_6px_rgba(0,243,255,0.5)]",
  },
  error: {
    icon: <AlertCircle className="h-4 w-4 text-error" />,
    dot: "bg-error shadow-[0_0_6px_rgba(255,68,102,0.5)]",
  },
  task_started: {
    icon: <Play className="h-4 w-4 text-warning" />,
    dot: "bg-warning shadow-[0_0_6px_rgba(255,170,0,0.5)]",
  },
  agent_created: {
    icon: <UserPlus className="h-4 w-4 text-neon-purple" />,
    dot: "bg-neon-purple shadow-[0_0_6px_rgba(189,0,255,0.5)]",
  },
  goal_update: {
    icon: <Target className="h-4 w-4 text-success" />,
    dot: "bg-success shadow-[0_0_6px_rgba(0,230,138,0.5)]",
  },
};

const defaultIcon = {
  icon: <Play className="h-4 w-4 text-text-secondary" />,
  dot: "bg-text-secondary/40",
};

export function ActivityFeed({ items, className }: ActivityFeedProps) {
  if (items.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-text-secondary">
        No recent activity
      </p>
    );
  }

  return (
    <div className={clsx("space-y-0", className)}>
      {items.map((item, i) => {
        const entry = iconMap[item.type as keyof typeof iconMap] ?? defaultIcon;
        return (
          <div
            key={item.id}
            className={clsx(
              "flex gap-3 px-1 py-3 animate-slide-up rounded-lg transition-all duration-300 hover:bg-white/[0.03]",
              i < items.length - 1 && "border-b border-white/[0.04]",
            )}
            style={{ animationDelay: `${i * 50}ms` }}
          >
            <div className="relative mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/[0.04]">
              {entry.icon}
              <span
                className={clsx(
                  "absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full",
                  entry.dot,
                )}
              />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-text-primary leading-snug">
                {item.agentName && (
                  <span className="font-medium text-neon-cyan/80">{item.agentName} </span>
                )}
                {item.title}
              </p>
              {item.description && (
                <p className="mt-0.5 text-xs text-text-secondary truncate">
                  {item.description}
                </p>
              )}
            </div>
            <time className="shrink-0 text-xs text-text-muted tabular-nums">
              {formatDistanceToNow(new Date(item.timestamp), { addSuffix: true })}
            </time>
          </div>
        );
      })}
    </div>
  );
}

export type { ActivityItem };
