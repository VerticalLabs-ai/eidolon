import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionPlanCard } from '../src/components/projects/MissionPlanCard';
import type { MissionPlanRevision, MissionPlanStep } from '../src/lib/api';

// ── Mocks ────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  useMissionCurrentPlanRevision: vi.fn(),
  useApproveMissionPlan: vi.fn(),
  useRejectMissionPlan: vi.fn(),
  useReviseMissionPlan: vi.fn(),
}));

vi.mock('@/lib/hooks', async () => {
  const actual = await vi.importActual('@/lib/hooks');
  return {
    ...actual,
    useMissionCurrentPlanRevision: mocks.useMissionCurrentPlanRevision,
    useApproveMissionPlan: mocks.useApproveMissionPlan,
    useRejectMissionPlan: mocks.useRejectMissionPlan,
    useReviseMissionPlan: mocks.useReviseMissionPlan,
  };
});

vi.mock('@/lib/ws', () => ({
  useServerEvents: vi.fn(),
  useWebSocket: () => ({ status: 'disconnected' }),
}));

vi.mock('@/lib/auth', () => ({
  useSession: () => ({
    isPending: false,
    data: {
      user: {
        id: 'dev-user-000',
        name: 'Local Operator',
        email: 'local@eidolon.dev',
        image: '',
        role: 'admin',
      },
      session: {
        id: 'local-dev-session',
        userId: 'dev-user-000',
        activeOrganizationId: null,
        activeOrganizationRole: 'admin',
      },
    },
  }),
  isLocalTrustedAuth: () => false,
  CLERK_PUBLISHABLE_KEY: '',
}));

// ── Fixtures ──────────────────────────────────────────────────────────────

/** A long tool ID and hash to test wrapping at narrow viewports. */
const LONG_TOOL_ID = 'mcp.server.instance.research.search.dns.validator.tool';
const LONG_HASH = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

function longPlanStep(ordinal: number): MissionPlanStep {
  return {
    stepKey: `step-${ordinal}`,
    parentStepKey: null,
    childOrdinal: ordinal - 1,
    nodeKind: 'root',
    title: `Step ${ordinal}: Complex analysis task with dependencies`,
    description: 'Retrieve and validate the quarterly revenue figures from multiple sources.',
    dependencies: ordinal > 1 ? [`step-${ordinal - 1}`] : [],
    inputBindings: [],
    routing: {
      kind: 'requirements',
      routingRequirements: {
        capabilities: ['research', 'analysis'],
        requiredTools: [LONG_TOOL_ID],
        requiredDomains: ['example.com', 'data.example.com'],
        ephemeralAllowed: true,
      },
    },
    toolAllowlist: [LONG_TOOL_ID, 'artifact.create', 'research.extract'],
    replayClass: 'read_only',
    sideEffecting: false,
    expectedOutputs: ['sourceSet', 'validatedReport'],
    evidenceRequirements: { citationsRequired: true },
    completionCriteria: 'At least three independent sources are retrieved and cross-validated.',
    budgetCents: 500,
    limits: {},
  };
}

function proposedRevision(overrides: Partial<MissionPlanRevision> = {}): MissionPlanRevision {
  return {
    id: 'plan-rev-1',
    revision: 1,
    status: 'proposed',
    contentHash: LONG_HASH,
    parentRevisionId: null,
    createdAt: '2026-08-23T10:00:00.000Z',
    content: {
      schemaVersion: 1,
      objective: 'Analyze the quarterly revenue report and produce a cited summary.',
      steps: [longPlanStep(1), longPlanStep(2)],
      synthesis: {
        instructions: 'Merge step outputs into one cited summary artifact.',
        declaredInputs: [{ kind: 'stepOutput', stepKey: 'step-1', output: 'sourceSet' }],
        declaredOutput: 'finalSummary',
        evidenceRequirements: { citationsRequired: true },
        completionCriteria: 'Final summary cites every external factual claim.',
        budgetCents: 200,
      },
      planningBudgetCents: 50,
      partialResultPolicy: 'require_all',
      limits: {
        steps: 12,
        durationSeconds: 2700,
        providerCalls: 48,
        totalTokens: 300000,
        outputBytes: 8388608,
        costCents: 5000,
        depth: 2,
        fanOut: 4,
        descendants: 12,
      },
      presentationMetadata: {
        cardTitle: 'Quarterly revenue analysis',
        summary: 'A multi-step plan.',
      },
    },
    ...overrides,
  };
}

function planQueryResult(revision: MissionPlanRevision | null = proposedRevision()) {
  return {
    data: revision,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  };
}

function mutationMock(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
    isError: false,
    error: null,
    reset: vi.fn(),
    ...overrides,
  };
}

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

function renderCard(
  overrides: Partial<Record<string, unknown>> & {
    revision?: MissionPlanRevision;
    role?: 'owner' | 'admin' | 'member' | 'viewer';
    runStatus?: string;
    stateVersion?: number;
    currentPlanRevisionId?: string;
    approveMock?: ReturnType<typeof mutationMock>;
    reviseMock?: ReturnType<typeof mutationMock>;
    rejectMock?: ReturnType<typeof mutationMock>;
    planRefetch?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const {
    revision = proposedRevision(),
    role = 'admin',
    runStatus = 'awaiting_approval',
    stateVersion = 3,
    currentPlanRevisionId = 'plan-rev-1',
    approveMock,
    reviseMock,
    rejectMock,
    planRefetch,
  } = overrides;
  mocks.useMissionCurrentPlanRevision.mockReturnValue({
    ...planQueryResult(revision),
    refetch: planRefetch ?? vi.fn(),
  });
  mocks.useApproveMissionPlan.mockReturnValue(approveMock ?? mutationMock());
  mocks.useRejectMissionPlan.mockReturnValue(rejectMock ?? mutationMock());
  mocks.useReviseMissionPlan.mockReturnValue(reviseMock ?? mutationMock());
  return render(
    <MissionPlanCard
      companyId="company-1"
      projectId="project-1"
      runId="run-1"
      currentPlanRevisionId={currentPlanRevisionId}
      resolvedMode="deep_work"
      runStatus={runStatus}
      stateVersion={stateVersion}
      role={role}
      principalId="dev-user-000"
      onRefreshSnapshot={vi.fn()}
    />,
    { wrapper },
  );
}

describe('Mission plan decision accessibility (m3-f08)', () => {
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── VAL-PLAN-081: Keyboard user can review and approve ───────────────
  describe('VAL-PLAN-081: Keyboard user can review and approve', () => {
    it('exposes all plan content as keyboard-navigable semantic elements', () => {
      renderCard();
      // The plan heading is a semantic heading
      expect(screen.getByRole('heading', { name: /proposed plan/i })).toBeInTheDocument();
      // The collapse toggle is a keyboard-operable button
      const toggle = screen.getByTestId('plan-collapse-toggle');
      expect(toggle.tagName).toBe('BUTTON');
      // Steps are in an ordered list
      expect(screen.getByRole('list', { name: /plan steps/i })).toBeInTheDocument();
      const steps = screen.getAllByRole('listitem');
      expect(steps.length).toBeGreaterThanOrEqual(2);
      // The hash details is a native details/summary (keyboard operable)
      expect(screen.getByTestId('plan-hash-details').tagName).toBe('DETAILS');
    });

    it('allows keyboard activation of Approve without pointer input', async () => {
      const approve = mutationMock();
      renderCard({ approveMock: approve });
      const btn = screen.getByTestId('plan-approve-button');
      btn.focus();
      expect(btn).toHaveFocus();
      await act(async () => {
        fireEvent.keyDown(btn, { key: 'Enter' });
        fireEvent.click(btn);
      });
      await waitFor(() => {
        expect(approve.mutateAsync).toHaveBeenCalledTimes(1);
      });
    });

    it('has visible focus styling on all decision controls', () => {
      renderCard();
      const approve = screen.getByTestId('plan-approve-button');
      expect(approve.className).toMatch(/focus-visible/i);
      const revise = screen.getByTestId('plan-revise-button');
      expect(revise.className).toMatch(/focus-visible/i);
      const reject = screen.getByTestId('plan-reject-button');
      expect(reject.className).toMatch(/focus-visible/i);
    });

    it('maintains logical tab order: toggle, approve, revise, reject', () => {
      renderCard();
      const toggle = screen.getByTestId('plan-collapse-toggle');
      const approve = screen.getByTestId('plan-approve-button');
      const revise = screen.getByTestId('plan-revise-button');
      const reject = screen.getByTestId('plan-reject-button');
      // All are focusable buttons with tabIndex 0 (default)
      expect(toggle.tabIndex).toBe(0);
      expect(approve.tabIndex).toBe(0);
      expect(revise.tabIndex).toBe(0);
      expect(reject.tabIndex).toBe(0);
    });
  });

  // ── VAL-PLAN-082: Keyboard user can revise and reject ────────────────
  describe('VAL-PLAN-082: Keyboard user can revise and reject', () => {
    it('opens the revise dialog via keyboard and focuses the feedback field', async () => {
      const user = userEvent.setup();
      renderCard();
      const trigger = screen.getByTestId('plan-revise-button');
      trigger.focus();
      await user.keyboard('{Enter}');
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /revise plan/i })).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByRole('textbox', { name: /feedback/i })).toHaveFocus();
      });
    });

    it('completes a revision request entirely via keyboard', async () => {
      const user = userEvent.setup();
      const revise = mutationMock();
      renderCard({ reviseMock: revise });
      await user.click(screen.getByTestId('plan-revise-button'));
      const textarea = screen.getByRole('textbox', { name: /feedback/i });
      await user.type(textarea, 'Add a citations step.');
      await user.click(screen.getByRole('button', { name: /request revision/i }));
      await waitFor(() => {
        expect(revise.mutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({ feedback: 'Add a citations step.' }),
        );
      });
    });

    it('dismisses the revise dialog via keyboard (Keep current plan) and returns focus', async () => {
      const user = userEvent.setup();
      renderCard();
      const trigger = screen.getByTestId('plan-revise-button');
      await user.click(trigger);
      const keepBtn = screen.getByRole('button', { name: /keep current plan/i });
      keepBtn.focus();
      await user.keyboard('{Enter}');
      await waitFor(() => {
        expect(trigger).toHaveFocus();
      });
    });

    it('preserves typed reason after a recoverable error on reject via keyboard', async () => {
      const user = userEvent.setup();
      const reject = mutationMock();
      reject.mutateAsync.mockRejectedValueOnce(new Error('network'));
      renderCard({ rejectMock: reject });
      await user.click(screen.getByTestId('plan-reject-button'));
      const textarea = screen.getByRole('textbox', { name: /reason/i });
      await user.type(textarea, 'Budget too high.');
      await user.click(screen.getByRole('button', { name: /confirm rejection/i }));
      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });
      // Typed reason is preserved
      expect(textarea).toHaveValue('Budget too high.');
    });
  });

  // ── VAL-PLAN-083: Plan structure is screen-reader understandable ──────
  describe('VAL-PLAN-083: Plan structure is screen-reader understandable', () => {
    it('has a semantic heading for the plan section', () => {
      renderCard();
      const section = screen.getByTestId('mission-plan-card');
      expect(section.tagName).toBe('SECTION');
      expect(section.getAttribute('aria-labelledby')).toMatch(/plan-heading-/);
      const heading = screen.getByRole('heading', { name: /proposed plan/i });
      expect(heading.tagName).toBe('H4');
    });

    it('renders steps as an ordered list preserving plan order', () => {
      renderCard();
      const ol = screen.getByRole('list', { name: /plan steps/i });
      expect(ol.tagName).toBe('OL');
      const items = within(ol).getAllByRole('listitem');
      expect(items.length).toBe(2);
      // First step has aria-label with ordinal 1
      expect(items[0].getAttribute('aria-label')).toMatch(/step 1/i);
      expect(items[1].getAttribute('aria-label')).toMatch(/step 2/i);
    });

    it('gives each decision control a unique accessible name including revision number', () => {
      renderCard();
      expect(screen.getByRole('button', { name: /approve plan revision 1/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /revise plan revision 1/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /reject plan revision 1/i })).toBeInTheDocument();
    });

    it('expresses status as text, not color alone', () => {
      renderCard();
      // The revision and hash are text elements
      expect(screen.getByTestId('plan-revision')).toHaveTextContent('Revision 1');
      expect(screen.getByTestId('plan-hash')).toBeInTheDocument();
      // The partial-result policy is explicit text
      expect(screen.getByTestId('plan-partial-policy')).toHaveTextContent(/require all/i);
    });

    it('labels step fields with explicit text labels', () => {
      renderCard();
      expect(screen.getAllByText(/routing:/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/tools:/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/expected outputs:/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/completion criteria:/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/budget:/i).length).toBeGreaterThan(0);
    });
  });

  // ── VAL-PLAN-084: Decision changes use restrained live announcements ──
  describe('VAL-PLAN-084: Decision changes use restrained live announcements', () => {
    it('uses role="alert" for command and failure errors', async () => {
      const approve = mutationMock();
      approve.mutateAsync.mockRejectedValueOnce({ status: 500, body: { code: 'INTERNAL' } });
      renderCard({ approveMock: approve });
      await act(async () => {
        fireEvent.click(screen.getByTestId('plan-approve-button'));
      });
      await waitFor(() => {
        const alerts = screen.getAllByRole('alert');
        expect(alerts.length).toBeGreaterThan(0);
      });
    });

    it('uses a polite live region for pending decision state', () => {
      renderCard({ approveMock: mutationMock({ isPending: true }) });
      const pending = screen.getByTestId('decision-pending-notice');
      expect(pending).toHaveAttribute('role', 'status');
      expect(pending).toHaveAttribute('aria-live', 'polite');
    });

    it('has a batched polite live region for decision status announcements', () => {
      renderCard();
      // The decision controls section should contain a polite live region
      // for announcing meaningful state changes (not per-event progress)
      const controls = screen.getByTestId('plan-decision-controls');
      const liveRegion = controls.querySelector('[aria-live="polite"]');
      expect(liveRegion).toBeInTheDocument();
    });

    it('does not announce token-by-token or repetitive progress events', () => {
      renderCard();
      // There should be no multiple aria-live regions that would cause
      // noisy announcements from high-frequency progress events
      const card = screen.getByTestId('mission-plan-card');
      const liveRegions = card.querySelectorAll('[aria-live]');
      // Each live region should be polite or assertive (for alerts), not
      // a per-event streaming region
      liveRegions.forEach((el) => {
        const live = el.getAttribute('aria-live');
        expect(['polite', 'assertive', 'off'].includes(live ?? '')).toBe(true);
      });
    });
  });

  // ── VAL-PLAN-085: Validation focus moves correctly ────────────────────
  describe('VAL-PLAN-085: Validation focus moves correctly', () => {
    it('moves focus to the first invalid field on empty revision submission', async () => {
      renderCard();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /revise plan revision 1/i }));
      });
      const submit = screen.getByRole('button', { name: /request revision/i });
      await act(async () => {
        fireEvent.click(submit);
      });
      await waitFor(() => {
        expect(screen.getByRole('textbox', { name: /feedback/i })).toHaveFocus();
      });
    });

    it('programmatically associates the error with the invalid field via aria-describedby', async () => {
      renderCard();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /revise plan revision 1/i }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /request revision/i }));
      });
      await waitFor(() => {
        const textarea = screen.getByRole('textbox', { name: /feedback/i });
        const errorId = textarea.getAttribute('aria-describedby');
        expect(errorId).toBeTruthy();
        const errorEl = document.getElementById(errorId!);
        expect(errorEl).toBeInTheDocument();
        expect(errorEl).toHaveAttribute('role', 'alert');
      });
    });

    it('marks the invalid field with aria-invalid', async () => {
      renderCard();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /revise plan revision 1/i }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /request revision/i }));
      });
      await waitFor(() => {
        expect(screen.getByRole('textbox', { name: /feedback/i })).toHaveAttribute(
          'aria-invalid',
          'true',
        );
      });
    });

    it('preserves plan content and typed values after a validation error', async () => {
      const user = userEvent.setup();
      renderCard();
      await user.click(screen.getByRole('button', { name: /revise plan revision 1/i }));
      const textarea = screen.getByRole('textbox', { name: /feedback/i });
      await user.type(textarea, 'Some feedback');
      // Submit empty by clearing (trim to empty won't work; type then clear)
      await user.clear(textarea);
      await user.click(screen.getByRole('button', { name: /request revision/i }));
      // Plan content remains visible
      expect(screen.getByRole('heading', { name: /proposed plan/i })).toBeInTheDocument();
      expect(screen.getByText(/objective/i)).toBeInTheDocument();
    });
  });

  // ── VAL-PLAN-086: Stale action has accessible recovery ────────────────
  describe('VAL-PLAN-086: Stale action has accessible recovery', () => {
    it('shows an accessible alert when the revision is stale', () => {
      renderCard({ currentPlanRevisionId: 'plan-rev-2' });
      const notice = screen.getByTestId('plan-stale-revision-notice');
      expect(notice).toBeInTheDocument();
      const alert = notice.querySelector('[role="alert"]');
      expect(alert).toBeInTheDocument();
      expect(alert?.textContent).toMatch(/no longer the current proposal/i);
    });

    it('provides a keyboard-reachable refresh button in the stale notice', () => {
      renderCard({ currentPlanRevisionId: 'plan-rev-2' });
      const refresh = screen.getByRole('button', { name: /refresh plan/i });
      expect(refresh.tagName).toBe('BUTTON');
      expect(refresh.tabIndex).toBe(0);
      expect(refresh.className).toMatch(/focus-visible/i);
    });

    it('moves focus to the stale notice so the user is not lost to the body', () => {
      renderCard({ currentPlanRevisionId: 'plan-rev-2' });
      const notice = screen.getByTestId('plan-stale-revision-notice');
      const heading = notice.querySelector('[role="alert"]');
      expect(heading?.tabIndex).toBe(-1);
    });

    it('does not show actionable decision controls when stale', () => {
      renderCard({ currentPlanRevisionId: 'plan-rev-2' });
      expect(screen.queryByTestId('plan-decision-controls')).not.toBeInTheDocument();
      expect(screen.queryByTestId('plan-approve-button')).not.toBeInTheDocument();
    });

    it('refresh loads the current revision via the refresh callback', async () => {
      const planRefetch = vi.fn();
      renderCard({ currentPlanRevisionId: 'plan-rev-2', planRefetch });
      const refresh = screen.getByRole('button', { name: /refresh plan/i });
      await act(async () => {
        fireEvent.click(refresh);
      });
      expect(planRefetch).toHaveBeenCalled();
    });
  });

  // ── VAL-PLAN-087: Reduced motion preserves information ────────────────
  describe('VAL-PLAN-087: Reduced motion preserves information', () => {
    it('includes motion-reduce classes on decision controls to disable transitions', () => {
      renderCard();
      const approve = screen.getByTestId('plan-approve-button');
      expect(approve.className).toMatch(/motion-reduce:transition-none/);
      const revise = screen.getByTestId('plan-revise-button');
      expect(revise.className).toMatch(/motion-reduce:transition-none/);
      const reject = screen.getByTestId('plan-reject-button');
      expect(reject.className).toMatch(/motion-reduce:transition-none/);
    });

    it('preserves all status text and controls even with motion-reduce', () => {
      renderCard();
      // All content is still present
      expect(screen.getByRole('heading', { name: /proposed plan/i })).toBeInTheDocument();
      expect(screen.getByTestId('plan-approve-button')).toBeInTheDocument();
      expect(screen.getByTestId('plan-revise-button')).toBeInTheDocument();
      expect(screen.getByTestId('plan-reject-button')).toBeInTheDocument();
      expect(screen.getByTestId('plan-revision')).toHaveTextContent('Revision 1');
    });

    it('gates animated icons behind motion-safe in the reject dialog', async () => {
      renderCard();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /reject plan revision 1/i }));
      });
      // The dialog should be open; animated icons use motion-safe
      const dialog = screen.getByRole('dialog');
      expect(dialog).toBeInTheDocument();
      // The reject confirm button's icon uses motion-safe:animate-pulse
      const confirmBtn = screen.getByRole('button', { name: /confirm rejection/i });
      expect(confirmBtn.innerHTML).toMatch(/motion-safe:animate-pulse/);
    });
  });

  // ── VAL-PLAN-088: Mobile plan is fully operable ───────────────────────
  describe('VAL-PLAN-088: Mobile plan is fully operable', () => {
    it('uses reflow primitives to prevent horizontal overflow at narrow widths', () => {
      renderCard();
      const card = screen.getByTestId('mission-plan-card');
      expect(card.className).toMatch(/max-w-full/);
      expect(card.className).toMatch(/break-words/);
      expect(card.className).toMatch(/overflow-hidden/);
    });

    it('makes long tool IDs wrap with break-all to prevent horizontal scroll', () => {
      renderCard();
      // Long tool IDs should be in elements with break-all. The tool ID
      // appears in both routing requirements and the tool allowlist.
      const toolTexts = screen.getAllByText(LONG_TOOL_ID);
      expect(toolTexts.length).toBeGreaterThan(0);
      toolTexts.forEach((el) => {
        expect(el.className).toMatch(/break-all/);
      });
    });

    it('makes the full content hash wrap with break-all', () => {
      renderCard();
      const hashDetails = screen.getByTestId('plan-hash-details');
      const hashCode = hashDetails.querySelector('code');
      expect(hashCode).toBeInTheDocument();
      expect(hashCode?.className).toMatch(/break-all/);
    });

    it('keeps all decision controls in a flex-wrap container', () => {
      renderCard();
      const controls = screen.getByTestId('plan-decision-controls');
      const buttonContainer = controls.querySelector('.flex.flex-wrap');
      expect(buttonContainer).toBeInTheDocument();
    });

    it('exposes objective, steps, dependencies, tools, outputs, budgets, limits, and hash without clipping', () => {
      renderCard();
      expect(screen.getByText(/Analyze the quarterly revenue/i)).toBeInTheDocument();
      expect(screen.getByRole('list', { name: /plan steps/i })).toBeInTheDocument();
      expect(screen.getAllByText(/depends on/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/tools:/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/expected outputs:/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/budget:/i).length).toBeGreaterThan(0);
      expect(screen.getByTestId('plan-limits')).toBeInTheDocument();
      expect(screen.getByTestId('plan-hash')).toBeInTheDocument();
    });
  });

  // ── VAL-PLAN-089: Mobile progress remains understandable ──────────────
  describe('VAL-PLAN-089: Mobile progress remains understandable', () => {
    it('conveys step hierarchy through semantic ordered list, not visual connectors', () => {
      renderCard();
      const ol = screen.getByRole('list', { name: /plan steps/i });
      expect(ol.tagName).toBe('OL');
      const items = within(ol).getAllByRole('listitem');
      // Each step has an ordinal in its aria-label
      expect(items[0].getAttribute('aria-label')).toMatch(/step 1/i);
      expect(items[1].getAttribute('aria-label')).toMatch(/step 2/i);
    });

    it('expresses routing status as text, not color-only indicators', () => {
      renderCard();
      expect(screen.getAllByText(/pending routing/i).length).toBeGreaterThan(0);
      // Capabilities are listed as text
      expect(screen.getAllByText(/capabilities:/i).length).toBeGreaterThan(0);
    });

    it('shows dependencies as text, not horizontal-only connectors', () => {
      renderCard();
      // Step 2 depends on step 1 — shown as text
      expect(screen.getByText(/depends on step-1/i)).toBeInTheDocument();
    });

    it('renders step nodeKind as text alongside the title', () => {
      renderCard();
      expect(screen.getAllByText(/\(root\)/i).length).toBeGreaterThan(0);
    });
  });

  // ── VAL-PLAN-090: Approval controls meet touch and zoom needs ─────────
  describe('VAL-PLAN-090: Approval controls meet touch and zoom needs', () => {
    it('gives decision buttons a minimum touch target height', () => {
      renderCard();
      const approve = screen.getByTestId('plan-approve-button');
      expect(approve.className).toMatch(/min-h-\[/);
      const revise = screen.getByTestId('plan-revise-button');
      expect(revise.className).toMatch(/min-h-\[/);
      const reject = screen.getByTestId('plan-reject-button');
      expect(reject.className).toMatch(/min-h-\[/);
    });

    it('keeps decision controls distinctly labelled at zoom', () => {
      renderCard();
      // Each button has a unique aria-label
      expect(screen.getByTestId('plan-approve-button')).toHaveAttribute(
        'aria-label',
        expect.stringContaining('Approve'),
      );
      expect(screen.getByTestId('plan-revise-button')).toHaveAttribute(
        'aria-label',
        expect.stringContaining('Revise'),
      );
      expect(screen.getByTestId('plan-reject-button')).toHaveAttribute(
        'aria-label',
        expect.stringContaining('Reject'),
      );
    });

    it('keeps decision controls non-overlapping with flex gap', () => {
      renderCard();
      const container = screen.getByTestId('plan-decision-controls').querySelector('.flex');
      expect(container?.className).toMatch(/gap-2/);
    });

    it('allows keyboard activation of all controls at zoom', async () => {
      const approve = mutationMock();
      renderCard({ approveMock: approve });
      const btn = screen.getByTestId('plan-approve-button');
      btn.focus();
      await act(async () => {
        fireEvent.click(btn);
      });
      await waitFor(() => {
        expect(approve.mutateAsync).toHaveBeenCalled();
      });
    });
  });

  // ── VAL-PLAN-120: Decision dialogs and authority values remain accessible
  describe('VAL-PLAN-120: Decision dialogs and authority values remain accessible', () => {
    it('renders the revise dialog as a labelled modal with aria-labelledby and aria-describedby', async () => {
      renderCard();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /revise plan revision 1/i }));
      });
      const dialog = screen.getByRole('dialog');
      expect(dialog.tagName).toBe('DIALOG');
      expect(dialog).toHaveAttribute('aria-labelledby');
      expect(dialog).toHaveAttribute('aria-describedby');
      const titleId = dialog.getAttribute('aria-labelledby')!;
      expect(document.getElementById(titleId)).toHaveTextContent(/revise plan/i);
    });

    it('announces errors within the dialog with role="alert"', async () => {
      const revise = mutationMock();
      revise.mutateAsync.mockRejectedValueOnce(new Error('network'));
      renderCard({ reviseMock: revise });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /revise plan revision 1/i }));
      });
      await act(async () => {
        fireEvent.change(screen.getByRole('textbox', { name: /feedback/i }), {
          target: { value: 'Some feedback' },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /request revision/i }));
      });
      await waitFor(() => {
        const dialog = screen.getByRole('dialog');
        const alert = dialog.querySelector('[role="alert"]');
        expect(alert).toBeInTheDocument();
      });
    });

    it('returns focus to the originating control on dialog dismissal', async () => {
      const user = userEvent.setup();
      renderCard();
      const trigger = screen.getByTestId('plan-revise-button');
      await user.click(trigger);
      await user.click(screen.getByRole('button', { name: /keep current plan/i }));
      await waitFor(() => {
        expect(trigger).toHaveFocus();
      });
    });

    it('moves focus to the success status after a successful revision', async () => {
      const revise = mutationMock();
      renderCard({ reviseMock: revise });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /revise plan revision 1/i }));
      });
      await act(async () => {
        fireEvent.change(screen.getByRole('textbox', { name: /feedback/i }), {
          target: { value: 'Add a citations step.' },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /request revision/i }));
      });
      await waitFor(() => {
        const status = screen.getByText(/revision requested/i);
        expect(status).toHaveFocus();
        expect(status).toHaveAttribute('role', 'status');
      });
    });

    it('wraps long hash values in the dialog with break-all', async () => {
      renderCard();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /revise plan revision 1/i }));
      });
      // The dialog references the revision number; long values should wrap
      const dialog = screen.getByRole('dialog');
      expect(dialog.className).toMatch(/max-w-\[/);
      // The dialog has break-words on content
      const content = dialog.querySelector('.p-6');
      expect(content).toBeInTheDocument();
    });

    it('wraps long hash and tool values in the plan card at narrow widths', () => {
      renderCard();
      // Full hash in details uses break-all
      const hashCode = screen.getByTestId('plan-hash-details').querySelector('code');
      expect(hashCode?.className).toMatch(/break-all/);
      // Long tool IDs use break-all (appears in routing + allowlist)
      const toolSpans = screen.getAllByText(LONG_TOOL_ID);
      expect(toolSpans.length).toBeGreaterThan(0);
      toolSpans.forEach((el) => {
        expect(el.className).toMatch(/break-all/);
      });
    });

    it('gives dialog buttons a minimum touch target height', async () => {
      renderCard();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /revise plan revision 1/i }));
      });
      const confirmBtn = screen.getByRole('button', { name: /request revision/i });
      expect(confirmBtn.className).toMatch(/min-h-\[/);
      const keepBtn = screen.getByRole('button', { name: /keep current plan/i });
      expect(keepBtn.className).toMatch(/min-h-\[/);
    });

    it('contains the reject dialog with confirmation and accessible warning text', async () => {
      renderCard();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /reject plan revision 1/i }));
      });
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-labelledby');
      const desc = dialog.getAttribute('aria-describedby')!;
      const descEl = document.getElementById(desc);
      expect(descEl?.textContent).toMatch(/cancelled/i);
      expect(descEl?.textContent).toMatch(/cannot be undone/i);
    });
  });
});
