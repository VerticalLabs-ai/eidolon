import { useState } from "react";
import { FileStack } from "lucide-react";
import { Tabs } from "@/components/ui/Tabs";
import { KnowledgeBase } from "@/pages/KnowledgeBase";
import { FileManager } from "@/pages/FileManager";
import type { Tab } from "@/components/ui/Tabs";

const tabs: Tab[] = [
  { id: "knowledge", label: "Knowledge Base" },
  { id: "files", label: "Files" },
];

export function Documents() {
  const [activeTab, setActiveTab] = useState("knowledge");

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar */}
      <div className="shrink-0 bg-surface">
        <div className="flex items-center gap-3 px-5 pt-4 pb-0">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/15">
            <FileStack className="h-4 w-4 text-amber-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-text-primary font-display tracking-wide">
              Documents
            </h1>
          </div>
        </div>
        <Tabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto">
        {activeTab === "knowledge" && (
          <div className="p-6">
            <KnowledgeBase />
          </div>
        )}
        {activeTab === "files" && <FileManager />}
      </div>
    </div>
  );
}
