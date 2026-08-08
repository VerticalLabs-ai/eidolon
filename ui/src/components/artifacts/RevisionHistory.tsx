import { formatDistanceToNow } from "date-fns";
import { History, RotateCcw, Bot, User } from "lucide-react";
import { clsx } from "clsx";
import type { ArtifactRevision } from "@/lib/api";

interface RevisionHistoryProps {
  revisions: ArtifactRevision[];
  currentVersion: number;
  onRestore: (version: number) => void;
  restoring?: boolean;
}

export function RevisionHistory({
  revisions,
  currentVersion,
  onRestore,
  restoring,
}: RevisionHistoryProps) {
  // Show newest first
  const sorted = [...revisions].sort((a, b) => b.version - a.version);

  return (
    <aside
      className="flex w-64 shrink-0 flex-col border-l border-white/[0.06] bg-surface/60"
      aria-label="Revision history"
    >
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
        <History className="h-4 w-4 text-accent" />
        <h3 className="text-sm font-semibold text-text-primary font-display">
          History
        </h3>
      </div>
      <div className="flex-1 overflow-auto">
        {sorted.length === 0 ? (
          <p className="px-4 py-6 text-xs text-text-secondary text-center">
            No revisions yet.
          </p>
        ) : (
          <ul role="list" className="divide-y divide-white/[0.04]">
            {sorted.map((rev) => {
              const isCurrent = rev.version === currentVersion;
              const canRestore = !isCurrent && !restoring;
              return (
                <li
                  key={rev.id}
                  className={clsx(
                    "px-3 py-2.5",
                    isCurrent && "bg-accent/[0.04]",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-text-primary tabular-nums">
                      v{rev.version}
                    </span>
                    {isCurrent && (
                      <span className="text-[10px] text-accent font-medium">
                        current
                      </span>
                    )}
                    <span className="ml-auto flex items-center gap-1 text-[10px] text-text-secondary">
                      {rev.editSource === "agent" ? (
                        <>
                          <Bot className="h-3 w-3" />
                          Agent
                        </>
                      ) : (
                        <>
                          <User className="h-3 w-3" />
                          User
                        </>
                      )}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[10px] text-text-secondary">
                    {formatDistanceToNow(new Date(rev.createdAt), {
                      addSuffix: true,
                    })}
                  </p>
                  {rev.message && (
                    <p className="mt-0.5 truncate text-[10px] text-text-secondary italic">
                      {rev.message}
                    </p>
                  )}
                  {canRestore && (
                    <button
                      onClick={() => onRestore(rev.version)}
                      disabled={restoring}
                      className="mt-1.5 flex items-center gap-1 text-[10px] text-accent hover:text-accent/80 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded disabled:opacity-40"
                      aria-label={`Restore version ${rev.version}`}
                    >
                      <RotateCcw className="h-3 w-3" />
                      Restore
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
