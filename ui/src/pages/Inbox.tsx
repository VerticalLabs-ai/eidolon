import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Inbox as InboxIcon,
  ShieldCheck,
  Users,
  Bell,
  Check,
  ArrowRight,
  MessageCircle,
  Keyboard,
  Archive,
} from "lucide-react";
import { clsx } from "clsx";
import { motion, type PanInfo } from "framer-motion";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Tabs, type Tab } from "@/components/ui/Tabs";
import { PageTransition } from "@/components/ui/PageTransition";
import {
  useInbox,
  useMarkInboxRead,
  useMarkInboxUnread,
} from "@/lib/hooks";
import { BoardChat } from "@/pages/BoardChat";
import { MessageCenter } from "@/pages/MessageCenter";
import type { InboxItem, InboxItemKind } from "@/lib/api";

const tabs: Tab[] = [
  { id: "inbox", label: "Inbox" },
  { id: "chat", label: "Board chat" },
  { id: "messages", label: "Messages" },
];

const kindIcon: Record<InboxItemKind, typeof ShieldCheck> = {
  approval: ShieldCheck,
  collaboration: Users,
  activity: Bell,
};

const kindTint: Record<InboxItemKind, string> = {
  approval: "text-success bg-success/15",
  collaboration: "text-neon-purple bg-neon-purple/15",
  activity: "text-accent bg-accent/15",
};

const priorityVariant: Record<string, "info" | "warning" | "error"> = {
  low: "info",
  medium: "info",
  high: "warning",
  critical: "error",
};

// ---------------------------------------------------------------------------
// Day bucketing — "Today" vs "Earlier"
// ---------------------------------------------------------------------------

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

// ---------------------------------------------------------------------------
// Feed view
// ---------------------------------------------------------------------------

function InboxFeed({ companyId }: { companyId: string }) {
  const navigate = useNavigate();
  const { data, isLoading } = useInbox(companyId);
  const markRead = useMarkInboxRead(companyId);
  const markUnread = useMarkInboxUnread(companyId);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);

  const items = useMemo(() => data?.data ?? [], [data?.data]);

  // Default selection = first unread, else first item
  useEffect(() => {
    if (selectedId && items.some((i) => i.id === selectedId)) return;
    const firstUnread = items.find((i) => !i.readAt);
    setSelectedId((firstUnread ?? items[0])?.id ?? null);
  }, [items, selectedId]);

  const doMarkRead = useCallback(
    (id: string) => {
      const item = items.find((i) => i.id === id);
      if (!item || item.readAt) return; // already read — no-op
      markRead.mutate([id]);
    },
    [items, markRead],
  );

  const markAllVisible = useCallback(() => {
    const unreadIds = items.filter((i) => !i.readAt).map((i) => i.id);
    if (unreadIds.length === 0) return;
    markRead.mutate(unreadIds);
  }, [items, markRead]);

  const markSelectedUnread = useCallback(
    (id: string) => {
      markUnread.mutate([id]);
    },
    [markUnread],
  );

  // j / k / a / y / o / enter / u / ? keyboard navigation
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent) {
      const target = ev.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;

      if (items.length === 0) return;
      const currentIdx = items.findIndex((i) => i.id === selectedId);

      if (ev.key === "j" || ev.key === "ArrowDown") {
        ev.preventDefault();
        const next = items[Math.min(currentIdx + 1, items.length - 1)];
        if (next) setSelectedId(next.id);
      } else if (ev.key === "k" || ev.key === "ArrowUp") {
        ev.preventDefault();
        const prev = items[Math.max(currentIdx - 1, 0)];
        if (prev) setSelectedId(prev.id);
      } else if (ev.key === "a" || ev.key === "y") {
        // Gmail-style: `y` archives the current conversation. We keep `a`
        // as an alias for discoverability.
        ev.preventDefault();
        if (selectedId) {
          doMarkRead(selectedId);
          const next = items[Math.min(currentIdx + 1, items.length - 1)];
          if (next && next.id !== selectedId) setSelectedId(next.id);
        }
      } else if (ev.key === "u") {
        // Gmail-style: `u` marks unread.
        ev.preventDefault();
        if (selectedId) markSelectedUnread(selectedId);
      } else if (ev.key === "o" || ev.key === "Enter") {
        ev.preventDefault();
        const selected = items.find((i) => i.id === selectedId);
        if (selected) {
          doMarkRead(selected.id);
          navigate(selected.link);
        }
      } else if (ev.key === "?") {
        ev.preventDefault();
        setShowShortcuts((v) => !v);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    items,
    selectedId,
    doMarkRead,
    markSelectedUnread,
    navigate,
  ]);

  const { todayItems, earlierItems } = useMemo(() => {
    const today: InboxItem[] = [];
    const earlier: InboxItem[] = [];
    for (const item of items) {
      (isToday(item.createdAt) ? today : earlier).push(item);
    }
    return { todayItems: today, earlierItems: earlier };
  }, [items]);

  const unreadCount = data?.meta?.unread ?? items.filter((i) => !i.readAt).length;
  const selected = items.find((i) => i.id === selectedId) ?? null;

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-text-secondary">
        Loading inbox…
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={<InboxIcon className="h-6 w-6" />}
          title="Inbox zero"
          description="No pending approvals, collaboration requests, or alerts right now."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-3">
        <div className="flex items-center gap-3 text-xs text-text-secondary">
          <span>
            <strong className="text-text-primary">{unreadCount}</strong> unread
            of {items.length}
          </span>
          {data?.meta?.pendingApprovals ? (
            <span>
              · <strong>{data.meta.pendingApprovals}</strong> pending approvals
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={markAllVisible}
            disabled={markRead.isPending || unreadCount === 0}
            title="Mark everything in this view read"
          >
            <Check className="mr-1.5 h-3.5 w-3.5" />
            Mark all read
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowShortcuts((v) => !v)}
            title="Keyboard shortcuts (?)"
          >
            <Keyboard className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {showShortcuts && (
        <div className="border-b border-white/[0.06] bg-black/20 px-5 py-3 text-xs text-text-secondary">
          <div className="flex flex-wrap gap-4">
            <span>
              <kbd className="kbd">j</kbd> / <kbd className="kbd">↓</kbd> next
            </span>
            <span>
              <kbd className="kbd">k</kbd> / <kbd className="kbd">↑</kbd> prev
            </span>
            <span>
              <kbd className="kbd">y</kbd> / <kbd className="kbd">a</kbd> archive
              (mark read)
            </span>
            <span>
              <kbd className="kbd">u</kbd> mark unread
            </span>
            <span>
              <kbd className="kbd">o</kbd> / <kbd className="kbd">Enter</kbd> open
            </span>
            <span>
              <kbd className="kbd">?</kbd> toggle this help
            </span>
          </div>
          <p className="mt-2 text-[11px] text-text-secondary/80">
            Tip: on touch devices, swipe a row left to archive.
          </p>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 p-5 md:grid-cols-[minmax(0,340px)_1fr]">
        <div
          ref={listRef}
          className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1"
        >
          {todayItems.length > 0 && (
            <DayGroup
              label="Today"
              items={todayItems}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onMarkRead={doMarkRead}
            />
          )}
          {earlierItems.length > 0 && (
            <DayGroup
              label="Earlier"
              items={earlierItems}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onMarkRead={doMarkRead}
            />
          )}
        </div>

        <div className="min-h-0 hidden md:block">
          {selected ? (
            <DetailPane
              item={selected}
              onMarkRead={() => doMarkRead(selected.id)}
              onMarkUnread={() => markSelectedUnread(selected.id)}
              onOpen={() => {
                doMarkRead(selected.id);
                navigate(selected.link);
              }}
            />
          ) : (
            <Card className="flex h-full items-center justify-center p-6 text-sm text-text-secondary">
              Select an item to see details.
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function DayGroup({
  label,
  items,
  selectedId,
  onSelect,
  onMarkRead,
}: {
  label: string;
  items: InboxItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMarkRead: (id: string) => void;
}) {
  return (
    <div>
      <div className="sticky top-0 z-10 mb-2 -mx-1 bg-surface/90 px-1 py-1 text-[10px] font-medium uppercase tracking-wider text-text-secondary backdrop-blur">
        {label}
      </div>
      <div className="space-y-1.5">
        {items.map((item) => (
          <SwipeableInboxRow
            key={item.id}
            item={item}
            isSelected={selectedId === item.id}
            onSelect={() => onSelect(item.id)}
            onMarkRead={() => onMarkRead(item.id)}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SwipeableInboxRow — mouse-click + mobile-swipe both archive.
// Drag left ≥ 80px reveals the Archive affordance, release to commit.
// ---------------------------------------------------------------------------

function SwipeableInboxRow({
  item,
  isSelected,
  onSelect,
  onMarkRead,
}: {
  item: InboxItem;
  isSelected: boolean;
  onSelect: () => void;
  onMarkRead: () => void;
}) {
  const [dragX, setDragX] = useState(0);
  const isRead = !!item.readAt;

  const handleDragEnd = (_: unknown, info: PanInfo) => {
    // Swipe ≥ 80px OR velocity ≥ 500 → archive. Otherwise snap back.
    if (info.offset.x < -80 || info.velocity.x < -500) {
      onMarkRead();
    }
    setDragX(0);
  };

  const revealed = Math.max(0, Math.min(120, -dragX));

  return (
    <div className="relative overflow-hidden rounded-lg">
      {/* Archive affordance behind the row, revealed as the row drags left */}
      <div
        className="pointer-events-none absolute inset-y-0 right-0 flex items-center justify-end pr-4 text-[11px] font-medium text-success"
        style={{ width: revealed }}
      >
        <Archive className="mr-1.5 h-3.5 w-3.5" />
        Archive
      </div>

      <motion.div
        drag="x"
        dragConstraints={{ left: -140, right: 0 }}
        dragElastic={0.2}
        onDrag={(_, info) => setDragX(info.offset.x)}
        onDragEnd={handleDragEnd}
        animate={{ x: 0 }}
        transition={{ type: "spring", stiffness: 400, damping: 30 }}
        className={clsx(
          "group relative flex cursor-pointer items-start gap-3 border px-3 py-2.5 backdrop-blur-sm transition-colors duration-150",
          // Keep rounded corners via inner content, not the drag transform.
          "rounded-lg",
          isSelected
            ? "border-accent/40 bg-accent/[0.07]"
            : "border-white/[0.06] bg-surface hover:border-white/[0.12] hover:bg-white/[0.02]",
        )}
        onClick={() => {
          // Ignore clicks that actually came from a drag
          if (Math.abs(dragX) > 4) return;
          onSelect();
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onMarkRead();
        }}
      >
        <span
          className={clsx(
            "mt-0.5 flex h-2 w-2 shrink-0 rounded-full transition-all",
            isRead
              ? "bg-transparent"
              : "bg-accent shadow-[0_0_6px_rgba(0,243,255,0.6)]",
          )}
        />
        <span
          className={clsx(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
            kindTint[item.kind],
          )}
        >
          {(() => {
            const Icon = kindIcon[item.kind];
            return <Icon className="h-3 w-3" />;
          })()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p
              className={clsx(
                "truncate text-xs",
                isRead
                  ? "font-normal text-text-secondary"
                  : "font-medium text-text-primary",
              )}
            >
              {item.title}
            </p>
            {item.priority && priorityVariant[item.priority] && (
              <Badge variant={priorityVariant[item.priority]}>
                {item.priority}
              </Badge>
            )}
          </div>
          {item.subtitle && (
            <p className="mt-0.5 truncate text-[11px] text-text-secondary">
              {item.subtitle}
            </p>
          )}
        </div>
        <span className="text-[10px] text-text-secondary tabular-nums">
          {formatRelative(item.createdAt)}
        </span>
      </motion.div>
    </div>
  );
}

function DetailPane({
  item,
  onMarkRead,
  onMarkUnread,
  onOpen,
}: {
  item: InboxItem;
  onMarkRead: () => void;
  onMarkUnread: () => void;
  onOpen: () => void;
}) {
  const Icon = kindIcon[item.kind];
  const isRead = !!item.readAt;

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <div className="flex items-start gap-3 border-b border-white/[0.06] p-5">
        <span
          className={clsx(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
            kindTint[item.kind],
          )}
        >
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-text-primary">
            {item.title}
          </h2>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-text-secondary">
            <span className="capitalize">{item.kind}</span>
            {item.priority && (
              <>
                <span>·</span>
                <span className="capitalize">{item.priority}</span>
              </>
            )}
            {item.status && (
              <>
                <span>·</span>
                <span className="capitalize">{item.status}</span>
              </>
            )}
            <span>·</span>
            <span title={item.createdAt}>
              {formatRelative(item.createdAt)} ago
            </span>
            {isRead && item.readAt && (
              <>
                <span>·</span>
                <span title={item.readAt}>read {formatRelative(item.readAt)} ago</span>
              </>
            )}
          </div>
        </div>
      </div>

      {item.subtitle && (
        <div className="border-b border-white/[0.06] p-5 text-sm text-text-secondary whitespace-pre-wrap">
          {item.subtitle}
        </div>
      )}

      <div className="flex-1 overflow-auto p-5 text-xs text-text-secondary">
        <p>
          Open the underlying {item.kind} for the full thread, payload, and
          available actions.
        </p>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] bg-black/15 p-3">
        {isRead ? (
          <Button variant="ghost" size="sm" onClick={onMarkUnread}>
            Mark unread
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={onMarkRead}>
            <Check className="mr-1.5 h-3.5 w-3.5" />
            Mark read
          </Button>
        )}
        <Button size="sm" onClick={onOpen}>
          Open
          <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function Inbox() {
  const { companyId } = useParams();
  const [activeTab, setActiveTab] = useState("inbox");

  return (
    <PageTransition>
      <div className="flex h-full flex-col">
        <div className="shrink-0 bg-surface">
          <div className="flex items-center gap-3 px-5 pt-4 pb-0">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15">
              <InboxIcon className="h-4 w-4 text-accent" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-text-primary font-display tracking-wide">
                Inbox
              </h1>
              <p className="text-[11px] text-text-secondary">
                Approvals, collaborations, and alerts in one feed. Press{" "}
                <kbd className="kbd">?</kbd> for shortcuts.
              </p>
            </div>
          </div>
          <Tabs
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={setActiveTab}
          />
        </div>

        <div className="flex-1 overflow-hidden">
          {activeTab === "inbox" && companyId && (
            <InboxFeed companyId={companyId} />
          )}
          {activeTab === "chat" && <BoardChat />}
          {activeTab === "messages" && (
            <div className="flex h-full flex-col">
              <div className="flex-shrink-0 border-b border-white/[0.06] px-5 py-2 text-[11px] text-text-secondary">
                <MessageCircle className="mr-1.5 inline h-3 w-3" />
                Peer-to-peer agent DMs
              </div>
              <div className="flex-1 overflow-hidden">
                <MessageCenter />
              </div>
            </div>
          )}
        </div>
      </div>
    </PageTransition>
  );
}
