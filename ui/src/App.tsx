import { Component, type ReactNode } from "react";
import { Routes, Route } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { AuthGuard } from "@/components/auth/AuthGuard";
import { Login } from "@/pages/Login";
import { Register } from "@/pages/Register";
import { CompanyList } from "@/pages/CompanyList";
import { CompanyDashboard } from "@/pages/CompanyDashboard";
import { Inbox } from "@/pages/Inbox";
import { ProjectList } from "@/pages/ProjectList";
import { ProjectDetail } from "@/pages/ProjectDetail";
import { TaskBoard } from "@/pages/TaskBoard";
import { TaskDetail } from "@/pages/TaskDetail";
import { GoalTree } from "@/pages/GoalTree";
import { AgentList } from "@/pages/AgentList";
import { AgentDetail } from "@/pages/AgentDetail";
import { OrgChart } from "@/pages/OrgChart";
import { VirtualWorkspace } from "@/pages/VirtualWorkspace";
import { Documents } from "@/pages/Documents";
import { PromptStudio } from "@/pages/PromptStudio";
import { Analytics } from "@/pages/Analytics";
import { Integrations } from "@/pages/Integrations";
import { CompanySettings } from "@/pages/CompanySettings";
import { Templates } from "@/pages/Templates";
import { Approvals } from "@/pages/Approvals";

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
        {/* Public routes */}
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />

        {/* Protected routes */}
        <Route
          path="/"
          element={
            <AuthGuard>
              <CompanyList />
            </AuthGuard>
          }
        />
        <Route
          path="/templates"
          element={
            <AuthGuard>
              <Templates />
            </AuthGuard>
          }
        />
        <Route
          path="/company/:companyId"
          element={
            <AuthGuard>
              <AppShell />
            </AuthGuard>
          }
        >
          <Route index element={<CompanyDashboard />} />
          <Route path="inbox" element={<Inbox />} />
          <Route path="projects" element={<ProjectList />} />
          <Route path="projects/:projectId" element={<ProjectDetail />} />
          <Route path="issues" element={<TaskBoard />} />
          <Route path="tasks/:taskId" element={<TaskDetail />} />
          <Route path="goals" element={<GoalTree />} />
          <Route path="agents" element={<AgentList />} />
          <Route path="agents/:agentId" element={<AgentDetail />} />
          <Route path="org-chart" element={<OrgChart />} />
          <Route path="workspace" element={<VirtualWorkspace />} />
          <Route path="documents" element={<Documents />} />
          <Route path="prompts" element={<PromptStudio />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="integrations" element={<Integrations />} />
          <Route path="approvals" element={<Approvals />} />
          <Route path="settings" element={<CompanySettings />} />
        </Route>
      </Routes>
    </ErrorBoundary>
  );
}
