import { useState } from "react";
import { Inbox as InboxIcon, Bell } from "lucide-react";
import { Tabs } from "@/components/ui/Tabs";
import { EmptyState } from "@/components/ui/EmptyState";
import { BoardChat } from "@/pages/BoardChat";
import { MessageCenter } from "@/pages/MessageCenter";
import type { Tab } from "@/components/ui/Tabs";

const tabs: Tab[] = [
  { id: "chat", label: "Chat" },
  { id: "messages", label: "Messages" },
  { id: "notifications", label: "Notifications" },
];

export function Inbox() {
  const [activeTab, setActiveTab] = useState("chat");

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar */}
      <div className="shrink-0 bg-surface">
        <div className="flex items-center gap-3 px-5 pt-4 pb-0">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15">
            <InboxIcon className="h-4 w-4 text-accent" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-text-primary font-display tracking-wide">
              Inbox
            </h1>
          </div>
        </div>
        <Tabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === "chat" && <BoardChat />}
        {activeTab === "messages" && <MessageCenter />}
        {activeTab === "notifications" && (
          <div className="flex h-full items-center justify-center p-6">
            <EmptyState
              icon={<Bell className="h-6 w-6" />}
              title="No notifications yet"
              description="You'll see agent updates, task completions, and system alerts here."
            />
          </div>
        )}
      </div>
    </div>
  );
}
