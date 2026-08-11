import { useMemo } from "react";
import type { PresenceEntry, ProjectPresenceEntry } from "@/lib/api";

// ---------------------------------------------------------------------------
// PresenceIndicator — avatar stack + typing indicators (M3)
// ---------------------------------------------------------------------------
//
// Renders the set of users currently viewing an artifact, with a live typing
// state on each chip. Self is excluded from the displayed set (the UI shows
// OTHER viewers) so the acting user is not double-counted. The list is
// live-patched by WS presence.* events in useArtifactPresence, so indicators
// appear/clear without a reload.
// ---------------------------------------------------------------------------

interface PresenceIndicatorProps {
  /** Current presence entries for the artifact. */
  presence: PresenceEntry[];
  /** The acting user's id — excluded from the displayed set. */
  selfUserId?: string;
  /** Aria label context (e.g. "Document", "Sheet"). */
  artifactKind?: string;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  if (parts.length === 0) return "?";
  return parts.map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
}

/** A deterministic color from a string (stable avatar tint per user). */
function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `hsl(${h} 60% 45%)`;
}

export function PresenceIndicator({
  presence,
  selfUserId,
  artifactKind = "artifact",
}: PresenceIndicatorProps) {
  const others = useMemo(
    () => presence.filter((p) => p.userId !== selfUserId),
    [presence, selfUserId],
  );

  if (others.length === 0) return null;

  const typingUsers = others.filter((p) => p.typing);
  const maxVisible = 4;
  const visible = others.slice(0, maxVisible);
  const overflow = others.length - visible.length;

  return (
    <div
      className="flex items-center gap-1.5"
      role="group"
      aria-label={`Other viewers on this ${artifactKind.toLowerCase()}`}
    >
      {/* Avatar stack */}
      <div className="flex -space-x-1.5">
        {visible.map((user) => (
          <div
            key={user.userId}
            title={user.name + (user.typing ? " (typing)" : "")}
            className="flex h-6 w-6 items-center justify-center rounded-full border border-surface text-[10px] font-semibold text-white"
            style={{ backgroundColor: colorFor(user.userId) }}
            aria-label={user.name}
          >
            <span aria-hidden="true">{initials(user.name)}</span>
          </div>
        ))}
        {overflow > 0 && (
          <div
            className="flex h-6 w-6 items-center justify-center rounded-full border border-surface bg-surface-elevated text-[10px] font-semibold text-text-secondary"
            aria-label={`${overflow} more viewers`}
          >
            <span aria-hidden="true">+{overflow}</span>
          </div>
        )}
      </div>

      {/* Typing indicator */}
      {typingUsers.length > 0 && (
        <span
          className="flex items-center gap-1 text-xs text-text-secondary"
          role="status"
          aria-live="polite"
          aria-label={`${typingUsers.map((u) => u.name).join(", ")} ${typingUsers.length === 1 ? "is" : "are"} typing`}
        >
          <span className="flex gap-0.5" aria-hidden="true">
            <span className="h-1 w-1 animate-pulse rounded-full bg-accent [animation-delay:0ms]" />
            <span className="h-1 w-1 animate-pulse rounded-full bg-accent [animation-delay:150ms]" />
            <span className="h-1 w-1 animate-pulse rounded-full bg-accent [animation-delay:300ms]" />
          </span>
          {typingUsers.length === 1
            ? `${typingUsers[0].name} is typing…`
            : `${typingUsers.length} people typing…`}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProjectPresenceBadge — aggregated presence across artifact types (M3)
// Renders a compact "N viewing in project" indicator on the Artifacts tab.
// ---------------------------------------------------------------------------

interface ProjectPresenceBadgeProps {
  presence: ProjectPresenceEntry[];
}

export function ProjectPresenceBadge({ presence }: ProjectPresenceBadgeProps) {
  const count = presence.length;
  if (count === 0) return null;

  const names = presence.map((p) => p.name);
  const label =
    count === 1
      ? `${names[0]} viewing in project`
      : `${count} people viewing in project`;

  return (
    <div
      className="flex items-center gap-1.5"
      role="group"
      aria-label={label}
      title={names.join(", ")}
    >
      <div className="flex -space-x-1.5">
        {presence.slice(0, 3).map((user) => (
          <div
            key={user.userId}
            className="flex h-5 w-5 items-center justify-center rounded-full border border-surface text-[9px] font-semibold text-white"
            style={{ backgroundColor: colorFor(user.userId) }}
          >
            <span aria-hidden="true">{initials(user.name)}</span>
          </div>
        ))}
      </div>
      <span className="text-xs text-text-secondary">{label}</span>
    </div>
  );
}
