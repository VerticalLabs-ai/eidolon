import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateAgentModal } from "../src/components/agents/CreateAgentModal";

const mocks = vi.hoisted(() => ({
  createAgent: vi.fn(),
}));

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
  useAgents: () => ({ data: [] }),
  useRuntimeAdapters: () => ({ data: [adapter] }),
  useCreateAgent: () => ({ mutate: mocks.createAgent, isPending: false }),
}));

describe("CreateAgentModal adapter configuration", () => {
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    });
  });

  beforeEach(() => vi.clearAllMocks());

  it("creates an agent with typed adapter configuration", async () => {
    const user = userEvent.setup();
    render(
      <CreateAgentModal
        open
        companyId="company-1"
        onClose={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText("Agent Name"), "Remote Operator");
    await user.selectOptions(screen.getByLabelText("Runtime adapter"), "http:remote");
    await user.type(
      screen.getByLabelText("Endpoint URL"),
      "https://runtime.example.com/run",
    );
    await user.click(screen.getByRole("button", { name: "Hire Agent" }));

    expect(mocks.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Remote Operator",
        adapterId: "http:remote",
        adapterConfig: {
          url: "https://runtime.example.com/run",
          timeoutSec: 30,
        },
      }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });
});
