import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JarvisRuntime } from "../src/pages/JarvisRuntime";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  testSession: vi.fn(),
  runSession: vi.fn(),
  cancelSession: vi.fn(),
  finalizeSession: vi.fn(),
  runPending: false,
  userRole: "admin",
}));

vi.mock("@/components/ui/PageTransition", () => ({
  PageTransition: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/lib/auth", () => ({
  useSession: () => ({
    data: {
      user: { role: mocks.userRole },
      session: { activeOrganizationRole: "owner" },
    },
  }),
}));

const agent = {
  id: "agent-1",
  companyId: "company-1",
  name: "Runtime Agent",
  role: "engineer",
  provider: "openai",
  adapterId: "http:remote",
  adapterConfig: {
    url: "https://runtime.example.com/run",
    timeoutSec: 30,
    responseFields: ["status"],
  },
};

const adapter = {
  id: "http:remote",
  name: "Remote HTTP runtime",
  kind: "remote-http",
  locality: "cloud",
  description: "Run prompts against an approved HTTP endpoint.",
  supportedModes: ["on_demand"],
  operations: { run: true, test: true },
  configFields: [
    { key: "url", label: "Endpoint URL", type: "url", required: true },
    { key: "timeoutSec", label: "Timeout", type: "number", defaultValue: 30 },
    { key: "responseFields", label: "Response fields", type: "string-list" },
  ],
  capabilities: {
    runtime: true,
    streaming: false,
    tools: false,
    mcp: false,
    skills: false,
    vision: false,
    browser: false,
    voice: false,
    shell: false,
    filesystem: false,
    reasoning: false,
    jsonMode: false,
    systemPrompt: false,
    costTracking: false,
    requiresApiKey: false,
    local: false,
    sessionResume: false,
    energyTelemetry: false,
  },
  models: [],
};

const runtimeSession = {
  id: "session-1",
  companyId: "company-1",
  agentId: "agent-1",
  taskId: null,
  executionId: null,
  environmentId: null,
  runId: "run-1",
  adapterId: "http:remote",
  adapterConfig: agent.adapterConfig,
  mode: "on_demand",
  status: "queued",
  resumeState: {},
  transcript: [],
  cancellationReason: null,
  finalizeRequired: true,
  finalizedAt: null,
  startedAt: null,
  completedAt: null,
  createdAt: "2026-07-30T18:00:00.000Z",
  updatedAt: "2026-07-30T18:00:00.000Z",
};

vi.mock("@/lib/hooks", () => ({
  useAgents: () => ({ data: [agent] }),
  useRuntimeAdapters: () => ({ data: [adapter], isLoading: false, isError: false }),
  useRuntimeSessions: () => ({ data: [runtimeSession], isLoading: false, isError: false }),
  useCompanySkills: () => ({ data: [], isLoading: false, isError: false }),
  useJarvisRoutines: () => ({ data: [], isLoading: false, isError: false }),
  useCreateRuntimeSession: () => ({ mutate: mocks.createSession, isPending: false }),
  useTestRuntimeSession: () => ({ mutate: mocks.testSession, isPending: false }),
  useRunRuntimeSession: () => ({ mutate: mocks.runSession, isPending: mocks.runPending }),
  useCancelRuntimeSession: () => ({ mutate: mocks.cancelSession, isPending: false }),
  useFinalizeRuntimeSession: () => ({ mutate: mocks.finalizeSession, isPending: false }),
  useWakeAgent: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateJarvisRoutine: () => ({ mutate: vi.fn(), isPending: false }),
  useTriggerJarvisRoutine: () => ({ mutate: vi.fn(), isPending: false }),
  useInstallCompanySkill: () => ({ mutate: vi.fn(), isPending: false }),
}));

function renderRuntime() {
  return render(
    <MemoryRouter initialEntries={["/company/company-1/runtime"]}>
      <Routes>
        <Route path="/company/:companyId/runtime" element={<JarvisRuntime />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("JarvisRuntime adapter operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runPending = false;
    mocks.userRole = "admin";
    mocks.testSession.mockImplementation((_sessionId, options) =>
      options?.onSuccess?.({
        ok: false,
        reachable: true,
        inconclusive: true,
        adapterId: "http:remote",
        message: "Endpoint is reachable but rejects HEAD.",
      }),
    );
    mocks.runSession.mockImplementation((_args, options) =>
      options?.onSuccess?.({
        ...runtimeSession,
        status: "completed",
        transcript: [
          {
            timestamp: "2026-07-30T18:01:00.000Z",
            stream: "stdout",
            kind: "text",
            content: "Queue summarized: two tasks are blocked.",
          },
        ],
      }),
    );
  });

  it("creates, tests, and runs a configured adapter session", async () => {
    const user = userEvent.setup();
    renderRuntime();

    await user.selectOptions(screen.getByLabelText("Agent"), "agent-1");
    expect(screen.getByLabelText("Endpoint URL")).toHaveValue(
      "https://runtime.example.com/run",
    );

    await user.click(screen.getByRole("button", { name: "Start session" }));
    expect(mocks.createSession).toHaveBeenCalledWith(
      {
        agentId: "agent-1",
        adapterId: "http:remote",
        adapterConfig: agent.adapterConfig,
        mode: "on_demand",
      },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );

    await user.click(screen.getByRole("button", { name: "Test adapter" }));
    expect(mocks.testSession).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
    expect(screen.getByText("Endpoint is reachable but rejects HEAD.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Run prompt" }));
    await user.type(screen.getByLabelText("Prompt for Runtime Agent"), "Summarize the queue");
    await user.click(screen.getByRole("button", { name: "Run now" }));
    expect(mocks.runSession).toHaveBeenCalledWith(
      { sessionId: "session-1", prompt: "Summarize the queue" },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
    expect(screen.getByText("Latest runtime output")).toBeInTheDocument();
    expect(screen.getByText("1 entry")).toBeInTheDocument();
    expect(screen.getByText("Queue summarized: two tasks are blocked.")).toBeInTheDocument();
  });

  it("disables duplicate prompt submission while a run is pending", async () => {
    mocks.runPending = true;
    const user = userEvent.setup();
    renderRuntime();

    await user.click(screen.getByRole("button", { name: "Run prompt" }));
    expect(screen.getByRole("button", { name: "Run now" })).toBeDisabled();
  });

  it("hides platform-only test and run controls from organization admins", () => {
    mocks.userRole = "member";
    renderRuntime();

    expect(screen.queryByRole("button", { name: "Test adapter" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run prompt" })).not.toBeInTheDocument();
  });

  it("requires an explicit second click before cancelling a session", async () => {
    const user = userEvent.setup();
    renderRuntime();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.cancelSession).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm cancel" }));
    expect(mocks.cancelSession).toHaveBeenCalledWith(
      { sessionId: "session-1", reason: "Cancelled from Jarvis Runtime" },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });
});
