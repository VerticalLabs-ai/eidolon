import { Component, type ReactNode } from 'react';
import {
  createBrowserRouter,
  createRoutesFromElements,
  Route,
  RouterProvider,
  Navigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { AuthGuard } from '@/components/auth/AuthGuard';
import { Login } from '@/pages/Login';
import { Register } from '@/pages/Register';
import { CompanyList } from '@/pages/CompanyList';
import { CompanyDashboard } from '@/pages/CompanyDashboard';
import { Inbox } from '@/pages/Inbox';
import { ProjectList } from '@/pages/ProjectList';
import { ProjectDetail } from '@/pages/ProjectDetail';
import { TaskBoard } from '@/pages/TaskBoard';
import { TaskDetail } from '@/pages/TaskDetail';
import { GoalTree } from '@/pages/GoalTree';
import { AgentList } from '@/pages/AgentList';
import { AgentDetail } from '@/pages/AgentDetail';
import { JarvisRuntime } from '@/pages/JarvisRuntime';
import { OrgChart } from '@/pages/OrgChart';
import { VirtualWorkspace } from '@/pages/VirtualWorkspace';
import { Documents } from '@/pages/Documents';
import { PromptStudio } from '@/pages/PromptStudio';
import { Analytics } from '@/pages/Analytics';
import { Integrations } from '@/pages/Integrations';
import { CompanySettings } from '@/pages/CompanySettings';
import { Templates } from '@/pages/Templates';
import { Approvals } from '@/pages/Approvals';
import { CompanyArtifacts } from '@/pages/CompanyArtifacts';
import { SearchResults } from '@/pages/SearchResults';
import { MeetingDetail } from '@/pages/MeetingDetail';
import { TeamsPage } from '@/pages/TeamsPage';
import { SecuritySettings } from '@/pages/SecuritySettings';
import { CompanyMembers } from '@/pages/CompanyMembers';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, color: '#ef4444', fontFamily: 'monospace' }}>
          <h1>Render Error</h1>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{this.state.error.message}</pre>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, color: '#999' }}>
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => {
              this.setState({ error: null });
              window.location.href = '/';
            }}
            style={{ marginTop: 20, padding: '8px 16px', cursor: 'pointer' }}
          >
            Go Home
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// Route definitions converted to data-router route objects via
// createRoutesFromElements. Using createBrowserRouter (instead of the
// low-level BrowserRouter) enables data-router hooks such as useBlocker,
// which the AppShell uses to intercept navigation when an artifact editor has
// unsaved changes.
const router = createBrowserRouter(
  createRoutesFromElements(
    <>
      {/* Public routes */}
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />

      {/* Redirect: server links.ui uses plural /companies/ path but the app
       * route uses singular /company/. Redirect preserving all query params
       * so deep links from start responses and snapshots resolve correctly
       * (VAL-RUN-097, VAL-CROSS-076, VAL-CROSS-083, VAL-CROSS-101).
       *
       * The canonical Mission link grammar appends `/work` to the path; the
       * redirect strips that subpath and adds `tab=work` to the query so the
       * singular app route renders the Work tab while preserving the
       * `thread`/`mission`/target query params. */}
      <Route
        path="/companies/:companyId/projects/:projectId/work"
        element={<PluralCompanyRedirect forceWorkTab />}
      />
      <Route path="/companies/:companyId/projects/:projectId" element={<PluralCompanyRedirect />} />

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
        <Route path="issues" element={<TaskBoard title="Issues" />} />
        <Route path="tasks/:taskId" element={<TaskDetail />} />
        <Route path="meetings/:meetingId" element={<MeetingDetail />} />
        <Route path="goals" element={<GoalTree />} />
        <Route path="agents" element={<AgentList />} />
        <Route path="agents/:agentId" element={<AgentDetail />} />
        <Route path="jarvis" element={<JarvisRuntime />} />
        <Route path="org-chart" element={<OrgChart />} />
        <Route path="workspace" element={<VirtualWorkspace />} />
        <Route path="documents" element={<Documents />} />
        <Route path="prompts" element={<PromptStudio />} />
        <Route path="analytics" element={<Analytics />} />
        <Route path="integrations" element={<Integrations />} />
        <Route path="approvals" element={<Approvals />} />
        <Route path="artifacts" element={<CompanyArtifacts />} />
        <Route path="search" element={<SearchResults />} />
        <Route path="teams" element={<TeamsPage />} />
        <Route path="security" element={<SecuritySettings />} />
        <Route path="settings" element={<CompanySettings />} />
        <Route path="settings/members" element={<CompanyMembers />} />
      </Route>
    </>,
  ),
);

export function App() {
  return (
    <ErrorBoundary>
      <RouterProvider router={router} />
    </ErrorBoundary>
  );
}

/**
 * Redirect from the plural `/companies/:companyId/projects/:projectId` path
 * (used by server-generated `links.ui`) to the singular
 * `/company/:companyId/projects/:projectId` app route, preserving all query
 * params (thread, mission, target, tab) so deep links restore context
 * (VAL-RUN-097, VAL-CROSS-076, VAL-CROSS-083, VAL-CROSS-101).
 *
 * When `forceWorkTab` is set (the canonical `/work` subpath route), the
 * redirect adds `tab=work` to the query unless an explicit `tab` is already
 * present, so the singular app route renders the Work tab while preserving
 * the `thread`/`mission`/target query params from the closed grammar.
 */
function PluralCompanyRedirect({ forceWorkTab = false }: { forceWorkTab?: boolean }) {
  const { companyId, projectId } = useParams();
  const [searchParams] = useSearchParams();
  const next = new URLSearchParams(searchParams);
  if (forceWorkTab && !next.has('tab')) {
    next.set('tab', 'work');
  }
  const qs = next.toString();
  const target = `/company/${companyId}/projects/${projectId}${qs ? `?${qs}` : ''}`;
  return <Navigate to={target} replace />;
}
