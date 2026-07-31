import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTasks } from "../src/lib/api";

const fetchMock = vi.fn();

describe("task API", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("serializes the project filter expected by the server", async () => {
    await getTasks("company-1", { projectId: "project-1" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/companies/company-1/tasks?project=project-1",
      expect.objectContaining({ credentials: "include" }),
    );
  });
});
