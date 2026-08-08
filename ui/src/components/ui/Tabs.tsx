import { clsx } from "clsx";

export interface Tab {
  id: string;
  label: string;
  count?: number;
}

interface TabsProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (id: string) => void;
  className?: string;
}

export function Tabs({ tabs, activeTab, onTabChange, className }: TabsProps) {
  return (
    <div
      className={clsx(
        "flex items-center gap-1 border-b border-white/[0.06] px-5",
        className,
      )}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={clsx(
              "relative flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium transition-all duration-200 cursor-pointer rounded-t-md outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
              isActive
                ? "text-accent"
                : "text-text-secondary hover:text-text-primary",
            )}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span
                className={clsx(
                  "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-semibold tabular-nums font-display",
                  isActive
                    ? "bg-accent/15 text-accent"
                    : "bg-white/[0.06] text-text-secondary",
                )}
              >
                {tab.count}
              </span>
            )}
            {/* Active indicator */}
            {isActive && (
              <span className="absolute bottom-0 left-0 right-0 h-[2px] rounded-full bg-accent" />
            )}
          </button>
        );
      })}
    </div>
  );
}
