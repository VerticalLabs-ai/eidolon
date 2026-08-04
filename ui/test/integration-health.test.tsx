import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Integrations } from "../src/pages/Integrations";
import type { Integration, HealthStatus } from "../src/lib/api";

const mocks = vi.hoisted(() => ({
  useIntegrations: vi.fn(),
  useCreateIntegration: vi.fn(),
  useDeleteIntegration: vi.fn(),
  useTestIntegration: vi.fn(),
}));

vi.mock("@/lib/hooks", () => mocks);

function makeIntegration(overrides: Partial<Integration> = {}): Integration {
  return {
    id: "int-1",
    companyId: "company-1",
    projectId: null,
    name: "My Custom API",
    type: "custom_api",
    provider: "custom",
    config: {},
    credentialsEncrypted: "****",
    status: "active",
    healthStatus: "unknown",
    lastHealthCheckAt: null,
    healthError: null,
    healthCheckMethod: null,
    lastUsedAt: null,
    usageCount: 0,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

function mutationResult(overrides: Partial<{ mutate: ReturnType<typeof vi.fn>; isPending: boolean }> = {}) {
  return { mutate: vi.fn(), isPending: false, ...overrides };
}

function renderWithRouter(companyId = "company-1") {
  return render(
    <MemoryRouter initialEntries={[`/company/${companyId}/integrations`]}>
      <Routes>
        <Route path="/company/:companyId/integrations" element={<Integrations />} />
      </Routes>
    </MemoryRouter>,
  );
}

const catalog = [
  { type: "custom_api", provider: "custom", name: "Custom API", description: "Any REST API", configFields: ["baseUrl", "apiKey"] },
  { type: "github", provider: "github", name: "GitHub", description: "Code repos", configFields: ["token", "org"] },
];

describe("Integrations — VAL-UI-001/002/003/004, VAL-CROSS-003", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useIntegrations.mockReturnValue({
      data: { data: [], catalog },
      isLoading: false,
      isError: false,
    });
    mocks.useCreateIntegration.mockReturnValue(mutationResult());
    mocks.useDeleteIntegration.mockReturnValue(mutationResult());
    mocks.useTestIntegration.mockReturnValue(mutationResult());
  });

  // VAL-UI-001: New integrations display "Unknown" badge, not "Active" or "Healthy"
  it("renders health badge 'Unknown' for a new integration with healthStatus unknown", () => {
    mocks.useIntegrations.mockReturnValue({
      data: { data: [makeIntegration({ healthStatus: "unknown" as HealthStatus })], catalog },
      isLoading: false,
      isError: false,
    });
    renderWithRouter();
    expect(screen.getByTestId("health-badge-unknown")).toBeInTheDocument();
    expect(screen.getByTestId("health-badge-unknown")).toHaveTextContent("Unknown");
  });

  it("renders color-coded health badges for each status", () => {
    mocks.useIntegrations.mockReturnValue({
      data: {
        data: [
          makeIntegration({ id: "h", healthStatus: "healthy" as HealthStatus, name: "Healthy Int" }),
          makeIntegration({ id: "d", healthStatus: "degraded" as HealthStatus, name: "Degraded Int" }),
          makeIntegration({ id: "e", healthStatus: "error" as HealthStatus, name: "Error Int" }),
          makeIntegration({ id: "u", healthStatus: "unknown" as HealthStatus, name: "Unknown Int" }),
        ],
        catalog,
      },
      isLoading: false,
      isError: false,
    });
    renderWithRouter();
    expect(screen.getByTestId("health-badge-healthy")).toHaveTextContent("Healthy");
    expect(screen.getByTestId("health-badge-degraded")).toHaveTextContent("Degraded");
    expect(screen.getByTestId("health-badge-error")).toHaveTextContent("Error");
    expect(screen.getByTestId("health-badge-unknown")).toHaveTextContent("Unknown");
  });

  // VAL-UI-001: Health badge is distinct from lifecycle status
  it("shows both lifecycle status badge and health badge", () => {
    mocks.useIntegrations.mockReturnValue({
      data: { data: [makeIntegration({ status: "active", healthStatus: "error" as HealthStatus })], catalog },
      isLoading: false,
      isError: false,
    });
    renderWithRouter();
    // Lifecycle status
    expect(screen.getByText("Active")).toBeInTheDocument();
    // Health status
    expect(screen.getByTestId("health-badge-error")).toBeInTheDocument();
  });

  // VAL-UI-002: Health check button performs real POST and updates badge
  it("calls testIntegration mutate when Test Connection is clicked and updates badge", async () => {
    const mutate = vi.fn((_id: string, options: { onSuccess: (res: unknown) => void }) => {
      options.onSuccess({
        data: {
          id: "int-1",
          success: true,
          healthStatus: "healthy",
          healthCheckMethod: "http_head",
          healthError: null,
          message: "Connection successful (HTTP 200).",
          testedAt: "2026-08-02T12:00:00.000Z",
        },
      });
    });
    mocks.useTestIntegration.mockReturnValue(mutationResult({ mutate }));
    mocks.useIntegrations.mockReturnValue({
      data: { data: [makeIntegration({ healthStatus: "unknown" as HealthStatus })], catalog },
      isLoading: false,
      isError: false,
    });
    renderWithRouter();
    // Initially unknown
    expect(screen.getByTestId("health-badge-unknown")).toBeInTheDocument();
    // Click test
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));
    expect(mutate).toHaveBeenCalledWith("int-1", expect.objectContaining({ onSuccess: expect.any(Function) }));
    // Badge should update to healthy
    await waitFor(() => {
      expect(screen.getByTestId("health-badge-healthy")).toBeInTheDocument();
    });
  });

  // VAL-UI-002: Unreachable URL → Error badge
  it("updates badge to error when health check returns error", async () => {
    const mutate = vi.fn((_id: string, options: { onSuccess: (res: unknown) => void }) => {
      options.onSuccess({
        data: {
          id: "int-1",
          success: false,
          healthStatus: "error",
          healthCheckMethod: "http_head",
          healthError: "HTTP 500 Internal Server Error",
          message: "Health check failed: HTTP 500.",
          testedAt: "2026-08-02T12:00:00.000Z",
        },
      });
    });
    mocks.useTestIntegration.mockReturnValue(mutationResult({ mutate }));
    mocks.useIntegrations.mockReturnValue({
      data: { data: [makeIntegration({ healthStatus: "unknown" as HealthStatus })], catalog },
      isLoading: false,
      isError: false,
    });
    renderWithRouter();
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));
    await waitFor(() => {
      expect(screen.getByTestId("health-badge-error")).toBeInTheDocument();
    });
  });

  // VAL-UI-003: Health error message displayed when status is error
  it("displays healthError message when healthStatus is error", () => {
    mocks.useIntegrations.mockReturnValue({
      data: {
        data: [
          makeIntegration({
            healthStatus: "error" as HealthStatus,
            healthError: "Connection refused",
          }),
        ],
        catalog,
      },
      isLoading: false,
      isError: false,
    });
    renderWithRouter();
    expect(screen.getByTestId("health-error-int-1")).toBeInTheDocument();
    expect(screen.getByTestId("health-error-int-1")).toHaveTextContent("Connection refused");
  });

  it("does not display health error when status is healthy", () => {
    mocks.useIntegrations.mockReturnValue({
      data: {
        data: [
          makeIntegration({
            healthStatus: "healthy" as HealthStatus,
            healthError: null,
          }),
        ],
        catalog,
      },
      isLoading: false,
      isError: false,
    });
    renderWithRouter();
    expect(screen.queryByTestId("health-error-int-1")).not.toBeInTheDocument();
  });

  // VAL-UI-004: Last health check timestamp displayed per integration
  it("displays 'Never checked' for a new integration with no lastHealthCheckAt", () => {
    mocks.useIntegrations.mockReturnValue({
      data: { data: [makeIntegration({ lastHealthCheckAt: null })], catalog },
      isLoading: false,
      isError: false,
    });
    renderWithRouter();
    expect(screen.getByTestId("health-check-time-int-1")).toHaveTextContent("Never checked");
  });

  it("displays a formatted timestamp when lastHealthCheckAt is set", () => {
    mocks.useIntegrations.mockReturnValue({
      data: {
        data: [
          makeIntegration({
            lastHealthCheckAt: "2026-08-01T12:30:00.000Z",
          }),
        ],
        catalog,
      },
      isLoading: false,
      isError: false,
    });
    renderWithRouter();
    const ts = screen.getByTestId("health-check-time-int-1");
    expect(ts).not.toHaveTextContent("Never checked");
    // Should contain a date-formatted string (month abbreviation)
    expect(ts.textContent).toMatch(/Aug/);
  });

  // VAL-UI-002: Loading state during test
  it("shows loading state on the test button while testing", () => {
    mocks.useIntegrations.mockReturnValue({
      data: { data: [makeIntegration()], catalog },
      isLoading: false,
      isError: false,
    });
    // mutate that never resolves
    mocks.useTestIntegration.mockReturnValue(mutationResult({ mutate: vi.fn() }));
    renderWithRouter();
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));
    expect(screen.getByText(/testing/i)).toBeInTheDocument();
  });

  // VAL-CROSS-003: Health check updates UI badge
  it("badge transitions from unknown to healthy after a successful check", async () => {
    const mutate = vi.fn((_id: string, options: { onSuccess: (res: unknown) => void }) => {
      options.onSuccess({
        data: {
          id: "int-1",
          success: true,
          healthStatus: "healthy",
          healthCheckMethod: "http_head",
          healthError: null,
          message: "Connection successful (HTTP 200).",
          testedAt: "2026-08-02T12:00:00.000Z",
        },
      });
    });
    mocks.useTestIntegration.mockReturnValue(mutationResult({ mutate }));
    mocks.useIntegrations.mockReturnValue({
      data: { data: [makeIntegration({ healthStatus: "unknown" as HealthStatus })], catalog },
      isLoading: false,
      isError: false,
    });
    renderWithRouter();
    // Before: Unknown
    expect(screen.getByTestId("health-badge-unknown")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));
    // After: Healthy
    await waitFor(() => {
      expect(screen.getByTestId("health-badge-healthy")).toBeInTheDocument();
      expect(screen.queryByTestId("health-badge-unknown")).not.toBeInTheDocument();
    });
  });
});
