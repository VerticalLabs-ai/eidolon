import { describe, it, expect } from "vitest";
import { EidolonClient, EidolonApiError } from "../client.js";
import type { EidolonMcpConfig } from "../config.js";

function makeFetch(
  handler: (url: string, init: RequestInit) => {
    status?: number;
    body?: unknown;
  },
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn: typeof fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, init });
    const { status = 200, body } = handler(url, init);
    const text = body === undefined ? "" : JSON.stringify(body);
    return new Response(text, {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fn, calls };
}

const baseConfig: EidolonMcpConfig = {
  apiUrl: "http://localhost:3100",
  apiKey: "test-token",
  companyId: "11111111-1111-1111-1111-111111111111",
  agentId: "22222222-2222-2222-2222-222222222222",
  runId: "run-42",
};

describe("EidolonClient", () => {
  it("attaches bearer + agent + run headers on every request", async () => {
    const fetchStub = makeFetch(() => ({
      body: { data: [{ id: "c1" }] },
    }));
    const client = new EidolonClient(baseConfig, fetchStub.fn);

    await client.listCompanies();

    expect(fetchStub.calls).toHaveLength(1);
    const headers = fetchStub.calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers["X-Eidolon-Agent-Id"]).toBe(baseConfig.agentId);
    expect(headers["X-Eidolon-Run-Id"]).toBe("run-42");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("unwraps the {data: ...} envelope returned by the server", async () => {
    const payload = [{ id: "a1", name: "Agent One" }];
    const fetchStub = makeFetch(() => ({ body: { data: payload } }));
    const client = new EidolonClient(baseConfig, fetchStub.fn);

    const agents = await client.listAgents("co-1");
    expect(agents).toEqual(payload);
  });

  it("returns the raw object when the response is not wrapped", async () => {
    const payload = { status: "ok", uptime: 42 };
    const fetchStub = makeFetch(() => ({ body: payload }));
    const client = new EidolonClient(baseConfig, fetchStub.fn);

    const res = await client.request("/api/health");
    expect(res).toEqual(payload);
  });

  it("propagates non-2xx responses as EidolonApiError with server code + message", async () => {
    const fetchStub = makeFetch(() => ({
      status: 404,
      body: { code: "AGENT_NOT_FOUND", message: "Agent x not found" },
    }));
    const client = new EidolonClient(baseConfig, fetchStub.fn);

    await expect(client.getAgent("co", "x")).rejects.toMatchObject({
      status: 404,
      code: "AGENT_NOT_FOUND",
      message: "Agent x not found",
    });

    await expect(client.getAgent("co", "x")).rejects.toBeInstanceOf(
      EidolonApiError,
    );
  });

  it("serializes query params and JSON bodies", async () => {
    const fetchStub = makeFetch(() => ({ body: { data: [] } }));
    const client = new EidolonClient(baseConfig, fetchStub.fn);

    await client.listTasks("co-1", { status: "todo", priority: "high" });
    expect(fetchStub.calls[0].url).toContain("status=todo");
    expect(fetchStub.calls[0].url).toContain("priority=high");

    await client.createTask("co-1", { title: "Do the thing" });
    const body = JSON.parse(String(fetchStub.calls[1].init.body));
    expect(body).toEqual({ title: "Do the thing" });
    expect(fetchStub.calls[1].init.method).toBe("POST");
  });

  it("skips Authorization when no apiKey is set (local_trusted mode)", async () => {
    const fetchStub = makeFetch(() => ({ body: { data: [] } }));
    const client = new EidolonClient(
      { apiUrl: "http://localhost:3100" },
      fetchStub.fn,
    );

    await client.listCompanies();
    const headers = fetchStub.calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("refuses paths that don't start with /", async () => {
    const client = new EidolonClient(baseConfig);
    await expect(client.request("api/companies")).rejects.toThrow(/start with/);
  });
});
