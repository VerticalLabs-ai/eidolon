import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDetail } from "../src/pages/AgentDetail";

const mocks = vi.hoisted(() => ({
  updateAgent: vi.fn(),
}));

const agent = {
  id: "agent-1",
  companyId: "company-1",
  name: "Runtime Agent",
  role: "engineer",
  title: "Runtime Engineer",
  provider: "openai",
  model: "gpt-5",
  adapterId: "http:remote",
  adapterConfig: {
    url: "https://runtime.example.com/run",
    timeoutSec: 30,
  },
  status: "idle",
  reportsTo: null,
  capabilities: [],
  systemPrompt: null,
  budgetMonthlyCents: 10_000,
  spentMonthlyCents: 0,
  lastHeartbeatAt: null,
  createdAt: "2026-07-30T18:00:00.000Z",
  updatedAt: "2026-07-30T18:00:00.000Z",
};

const adapter = {
  id: "http:remote",
  name: "Remote HTTP runtime",
  locality: "cloud",
  description: "Run prompts against an approved HTTP endpoint.",
  operations: { run: true, test: true },
  configFields: [
    { key: "url", label: "Endpoint URL", type: "url", required: true },
    { key: "timeoutSec", label: "Timeout", type: "number", defaultValue: 30 },
  ],
};

vi.mock("@/lib/hooks", () => ({
  useAgent: () => ({ data: agent, isLoading: false }),
  useAgents: () => ({ data: [agent] }),
  useTasks: () => ({ data: [] }),
  useUpdateAgent: () => ({ mutate: mocks.updateAgent, isPending: false }),
  useRuntimeAdapters: () => ({ data: [adapter] }),
  useRefreshAgentModels: () => ({ mutate: vi.fn(), isPending: false, data: undefined }),
  useAgentInstructions: () => ({ data: undefined }),
  useUpdateAgentInstructions: () => ({ mutate: vi.fn(), isPending: false }),
  useAgentRevisions: () => ({ data: [], isLoading: false }),
  useAgentExecutions: () => ({ data: [], isLoading: false }),
}));

describe("AgentDetail runtime adapter configuration", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads and saves persisted typed adapter configuration", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/company/company-1/agents/agent-1#config"]}>
        <Routes>
          <Route path="/company/:companyId/agents/:agentId" element={<AgentDetail />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByLabelText("Adapter")).toHaveValue("http:remote");
    expect(screen.getByLabelText("Endpoint URL")).toHaveValue(
      "https://runtime.example.com/run",
    );
    await user.clear(screen.getByLabelText("Timeout"));
    await user.type(screen.getByLabelText("Timeout"), "45");
    await user.click(screen.getByRole("button", { name: "Save Configuration" }));

    expect(mocks.updateAgent).toHaveBeenCalledWith(
      {
        agentId: "agent-1",
        data: expect.objectContaining({
          adapterId: "http:remote",
          adapterConfig: {
            url: "https://runtime.example.com/run",
            timeoutSec: 45,
          },
        }),
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });
});
