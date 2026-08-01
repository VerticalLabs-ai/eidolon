import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGoals } from "../src/lib/api";

const fetchMock = vi.fn();

describe("goal API", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("serializes the project filter", async () => {
    await getGoals("company-1", { projectId: "project-a" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/companies/company-1/goals?project=project-a",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("does not emit a project parameter without a filter", async () => {
    await getGoals("company-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/companies/company-1/goals",
      expect.objectContaining({ credentials: "include" }),
    );
  });
});
