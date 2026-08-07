import { useEffect, useRef, useState } from "react";
import { Bot, User } from "lucide-react";
import { useMentionSearch } from "@/lib/hooks";
import type { MentionableEntity } from "@/lib/api";

export interface MentionPickerProps {
  companyId: string;
  query: string;
  onSelect: (entity: MentionableEntity) => void;
  onClose: () => void;
  anchorRect?: DOMRect | null;
}

/**
 * Mention picker — shows company-scoped agents + teammates.
 * Keyboard accessible: arrow keys to navigate, Enter to select, Escape to close.
 */
export function MentionPicker({
  companyId,
  query,
  onSelect,
  onClose,
  anchorRect,
}: MentionPickerProps) {
  const { data: entities, isLoading } = useMentionSearch(companyId, query);
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const results = entities ?? [];

  // Reset active index when results change
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Keyboard navigation
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (results[activeIndex]) {
          onSelect(results[activeIndex]);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [results, activeIndex, onSelect, onClose]);

  // Scroll active item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[activeIndex] as HTMLElement | undefined;
    if (item) {
      item.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  const style: React.CSSProperties = anchorRect
    ? {
        position: "fixed",
        top: anchorRect.bottom + 4,
        left: anchorRect.left,
        zIndex: 50,
      }
    : { position: "relative", zIndex: 50 };

  if (isLoading && results.length === 0) {
    return (
      <div
        role="listbox"
        aria-label="Mention picker"
        style={style}
        className="w-72 rounded-lg border border-white/10 bg-surface shadow-xl"
      >
        <div className="px-3 py-2 text-xs text-text-muted">Searching…</div>
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div
        role="listbox"
        aria-label="Mention picker"
        style={style}
        className="w-72 rounded-lg border border-white/10 bg-surface shadow-xl"
      >
        <div className="px-3 py-2 text-xs text-text-muted">No matches found</div>
      </div>
    );
  }

  return (
    <div
      role="listbox"
      aria-label="Mention picker"
      aria-activedescendant={`mention-option-${activeIndex}`}
      style={style}
      className="max-h-60 w-72 overflow-y-auto rounded-lg border border-white/10 bg-surface shadow-xl"
    >
      <ul ref={listRef} className="py-1">
        {results.map((entity, index) => (
          <li
            key={`${entity.entityType}-${entity.entityId}`}
            id={`mention-option-${index}`}
            role="option"
            aria-selected={index === activeIndex}
            tabIndex={-1}
            onClick={() => onSelect(entity)}
            onMouseEnter={() => setActiveIndex(index)}
            className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm ${
              index === activeIndex
                ? "bg-accent/10 text-text-primary"
                : "text-text-secondary hover:bg-white/[0.03]"
            }`}
          >
            {entity.entityType === "agent" ? (
              <Bot className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
            ) : (
              <User className="h-3.5 w-3.5 text-blue-400" aria-hidden="true" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-text-primary">{entity.label}</div>
              {entity.subtitle && (
                <div className="truncate text-xs text-text-muted">{entity.subtitle}</div>
              )}
            </div>
            <span className="text-xs text-text-muted">
              {entity.entityType === "agent" ? "Agent" : "Teammate"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mention chip — rendered in the composer and thread items
// ---------------------------------------------------------------------------

export function MentionChip({
  entityType,
  label,
}: {
  entityType: "agent" | "user";
  label: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-accent/10 px-1.5 py-0.5 text-xs font-medium text-accent"
      data-testid="mention-chip"
      data-entity-type={entityType}
    >
      {entityType === "agent" ? (
        <Bot className="h-3 w-3" aria-hidden="true" />
      ) : (
        <User className="h-3 w-3" aria-hidden="true" />
      )}
      {label}
    </span>
  );
}
