import { Component, type ReactNode } from "react";
import { Routes, Route } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { CompanyList } from "@/pages/CompanyList";
import { CompanyDashboard } from "@/pages/CompanyDashboard";
import { AgentList } from "@/pages/AgentList";
import { AgentDetail } from "@/pages/AgentDetail";
import { TaskBoard } from "@/pages/TaskBoard";
import { TaskDetail } from "@/pages/TaskDetail";
import { GoalTree } from "@/pages/GoalTree";
import { OrgChart } from "@/pages/OrgChart";
import { MessageCenter } from "@/pages/MessageCenter";
import { AnalyticsDashboard } from "@/pages/AnalyticsDashboard";
import { CompanySettings } from "@/pages/CompanySettings";
import { VirtualWorkspace } from "@/pages/VirtualWorkspace";
import { BoardChat } from "@/pages/BoardChat";
import { KnowledgeBase } from "@/pages/KnowledgeBase";
import { FileManager } from "@/pages/FileManager";
import { Integrations } from "@/pages/Integrations";
import { PromptStudio } from "@/pages/PromptStudio";
import { AgentPerformance } from "@/pages/AgentPerformance";
import { Templates } from "@/pages/Templates";

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, color: "#ef4444", fontFamily: "monospace" }}>
          <h1>Render Error</h1>
          <pre style={{ whiteSpace: "pre-wrap" }}>
            {this.state.error.message}
          </pre>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, color: "#999" }}>
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => {
              this.setState({ error: null });
              window.location.href = "/";
            }}
            style={{ marginTop: 20, padding: "8px 16px", cursor: "pointer" }}
          >
            Go Home
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function App() {
  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/" element={<CompanyList />} />
        <Route path="/templates" element={<Templates />} />
        <Route path="/company/:companyId" element={<AppShell />}>
          <Route index element={<CompanyDashboard />} />
          <Route path="agents" element={<AgentList />} />
          <Route path="agents/:agentId" element={<AgentDetail />} />
          <Route path="tasks" element={<TaskBoard />} />
          <Route path="tasks/:taskId" element={<TaskDetail />} />
          <Route path="goals" element={<GoalTree />} />
          <Route path="org-chart" element={<OrgChart />} />
          <Route path="chat" element={<BoardChat />} />
          <Route path="messages" element={<MessageCenter />} />
          <Route path="analytics" element={<AnalyticsDashboard />} />
          <Route path="knowledge" element={<KnowledgeBase />} />
          <Route path="files" element={<FileManager />} />
          <Route path="integrations" element={<Integrations />} />
          <Route path="prompts" element={<PromptStudio />} />
          <Route path="performance" element={<AgentPerformance />} />
          <Route path="workspace" element={<VirtualWorkspace />} />
          <Route path="settings" element={<CompanySettings />} />
        </Route>
      </Routes>
    </ErrorBoundary>
  );
}
