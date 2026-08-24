import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionStepProgress } from '../src/components/projects/MissionStepProgress';
import type { MissionPlanRevision, MissionRunSnapshot, MissionReplayEvent } from '../src/lib/api';

// ── Mocks ────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  useMissionCurrentPlanRevision: vi.fn(),
}));

vi.mock('@/lib/hooks', async () => {
  const actual = await vi.importActual('@/lib/hooks');
  return {
    ...actual,
    useMissionCurrentPlanRevision: mocks.useMissionCurrentPlanRevision,
  };
});

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

const APPROVED_HASH = 'b'.repeat(64);

function approvedRevision(overrides: Partial<MissionPlanRevision> = {}): MissionPlanRevision {
  return {
    id: 'plan-rev-2',
    revision: 2,
    status: 'approved',
    contentHash: APPROVED_HASH,
    parentRevisionId: 'plan-rev-1',
    createdAt: '2026-08-23T10:00:00.000Z',
    content: {
      schemaVersion: 1,
      objective: 'Analyze the quarterly revenue report and produce a cited summary.',
      steps: [
        {
          stepKey: 'gather',
          parentStepKey: null,
          childOrdinal: 0,
          nodeKind: 'root',
          title: 'Gather source data',
          description: 'Retrieve the quarterly revenue figures.',
          dependencies: [],
          inputBindings: [],
          routing: {
            kind: 'concreteAgent',
            executingAgentId: 'agent-42',
          },
          toolAllowlist: ['research.search', 'research.extract'],
          replayClass: 'read_only',
          sideEffecting: false,
          expectedOutputs: ['sourceSet'],
          evidenceRequirements: { citationsRequired: false },
          completionCriteria: 'At least three independent sources are retrieved.',
          budgetCents: 500,
          limits: {},
        },
        {
          stepKey: 'synthesize',
          parentStepKey: null,
          childOrdinal: 1,
          nodeKind: 'child',
          title: 'Synthesize cited summary',
          description: 'Produce a cited summary from the gathered sources.',
          dependencies: ['gather'],
          inputBindings: [],
          routing: {
            kind: 'concreteAgent',
            executingAgentId: 'agent-42',
          },
          toolAllowlist: ['artifact.create'],
          replayClass: 'idempotent_write',
          sideEffecting: true,
          expectedOutputs: ['summaryArtifact'],
          evidenceRequirements: { citationsRequired: true },
          completionCriteria: 'Summary artifact committed with inline citations.',
          budgetCents: 1000,
          limits: {},
        },
      ],
      synthesis: {
        instructions: 'Merge step outputs into one cited summary artifact.',
        declaredInputs: [{ kind: 'stepOutput', stepKey: 'synthesize', output: 'summaryArtifact' }],
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
    },
    ...overrides,
  };
}

/** A snapshot with an approved plan and the given policy/completeness. */
function snapshot(overrides: Partial<MissionRunSnapshot> = {}): MissionRunSnapshot {
  return {
    id: 'run-1',
    companyId: 'comp-1',
    projectId: 'proj-1',
    projectThreadId: 'thread-1',
    rootRunId: 'run-1',
    parentRunId: null,
    retryOfRunId: null,
    depth: 0,
    childOrdinal: null,
    routingKind: 'company_agent',
    status: 'running',
    stateVersion: 5,
    lastEventSequence: 10,
    resolvedMode: 'deep_work',
    modeProfileId: null,
    policySnapshotId: 'pol-1',
    policyContentHash: 'p'.repeat(64),
    requestContentHash: 'r'.repeat(64),
    currentQuestionSetId: null,
    currentPlanRevisionId: 'plan-rev-2',
    approvedPlanRevisionId: 'plan-rev-2',
    waitingFromStatus: null,
    partialResultPolicy: 'require_all',
    cancelRequestedAt: null,
    cancelRequestedBy: null,
    cancellationDeadlineAt: null,
    failureCategory: null,
    failureCode: null,
    safeErrorMessage: null,
    startedAt: '2026-08-23T10:01:00.000Z',
    terminalAt: null,
    createdAt: '2026-08-23T10:00:00.000Z',
    updatedAt: '2026-08-23T10:05:00.000Z',
    attemptCount: 1,
    providerCallCount: 2,
    descendantCount: 0,
    inputTokens: 1000,
    outputTokens: 500,
    outputBytes: 2048,
    actualCostCents: 300,
    budget: {
      reservedCents: 5000,
      settledCents: 300,
      releasedCents: 0,
      costCentsCeiling: 5000,
      actualCostCents: 300,
    },
    childSummary: { running: 0, completed: 0, failed: 0, cancelled: 0, total: 0 },
    artifacts: [],
    links: { ui: '/companies/comp-1/projects/proj-1/work?mission=run-1' },
    resultCompleteness: null,
    ...overrides,
  };
}

/** Build a child.* / execution.* event with a stepKey payload. */
function evt(sequence: number, type: string, payload: Record<string, unknown>): MissionReplayEvent {
  return {
    sequence,
    type,
    schemaVersion: 1,
    payload,
    commandId: null,
    actorType: 'system',
    actorId: null,
    traceId: null,
    occurredAt: '2026-08-23T10:02:00.000Z',
  };
}

function renderCard(
  revision: MissionPlanRevision | null,
  snap: MissionRunSnapshot,
  events: MissionReplayEvent[],
) {
  mocks.useMissionCurrentPlanRevision.mockReturnValue({
    data: revision,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MissionStepProgress
          companyId="comp-1"
          projectId="proj-1"
          runId="run-1"
          currentPlanRevisionId={snap.approvedPlanRevisionId}
          snapshot={snap}
          events={events}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MissionStepProgress', () => {
  describe('VAL-PLAN-067: step progress follows approved plan', () => {
    it('renders one progress item per approved step keyed by stepKey', () => {
      renderCard(approvedRevision(), snapshot(), []);
      const list = screen.getByRole('list', { name: 'Approved step progress' });
      expect(within(list).getAllByRole('listitem')).toHaveLength(2);
      expect(within(list).getByText('Gather source data')).toBeInTheDocument();
      expect(within(list).getByText('Synthesize cited summary')).toBeInTheDocument();
      // Each step exposes its approved stepKey so progress maps to the plan.
      expect(screen.getByText('gather')).toBeInTheDocument();
      expect(screen.getByText('synthesize')).toBeInTheDocument();
    });

    it('derives understandable status transitions from child events (pending → running → completed)', () => {
      const events = [
        evt(3, 'child.started', { stepKey: 'gather', childRunId: 'child-1', agentId: 'agent-42' }),
        evt(4, 'child.completed', {
          stepKey: 'gather',
          childRunId: 'child-1',
          agentId: 'agent-42',
          outputSummary: '3 sources retrieved',
          costCents: 250,
        }),
        evt(5, 'child.started', {
          stepKey: 'synthesize',
          childRunId: 'child-2',
          agentId: 'agent-42',
        }),
      ];
      renderCard(approvedRevision(), snapshot(), events);
      const items = screen.getAllByRole('listitem');
      // Step 1 (gather): completed.
      expect(within(items[0]).getByText('Completed')).toBeInTheDocument();
      // Step 2 (synthesize): running.
      expect(within(items[1]).getByText('Running')).toBeInTheDocument();
    });

    it('renders nothing when there is no approved plan revision', () => {
      renderCard(approvedRevision(), snapshot({ approvedPlanRevisionId: null }), []);
      expect(
        screen.queryByRole('list', { name: 'Approved step progress' }),
      ).not.toBeInTheDocument();
    });

    it('renders all steps pending when no execution events exist', () => {
      renderCard(approvedRevision(), snapshot({ status: 'queued' }), []);
      const items = screen.getAllByRole('listitem');
      expect(within(items[0]).getByText('Pending')).toBeInTheDocument();
      expect(within(items[1]).getByText('Pending')).toBeInTheDocument();
    });
  });

  describe('VAL-PLAN-068: dependencies gate step start', () => {
    it('shows dependency gating text while a dependency is incomplete', () => {
      // gather is running, synthesize depends on gather → synthesize is waiting.
      const events = [
        evt(3, 'child.started', { stepKey: 'gather', childRunId: 'child-1', agentId: 'agent-42' }),
      ];
      renderCard(approvedRevision(), snapshot(), events);
      const items = screen.getAllByRole('listitem');
      // synthesize is pending and blocked by gather.
      expect(within(items[1]).getByText('Waiting on: gather')).toBeInTheDocument();
      // synthesize cannot be running while gather is incomplete.
      expect(within(items[1]).queryByText('Running')).not.toBeInTheDocument();
    });

    it('does not show waiting text for a step whose dependencies are complete', () => {
      const events = [
        evt(3, 'child.started', { stepKey: 'gather', childRunId: 'child-1', agentId: 'agent-42' }),
        evt(4, 'child.completed', {
          stepKey: 'gather',
          childRunId: 'child-1',
          agentId: 'agent-42',
        }),
      ];
      renderCard(approvedRevision(), snapshot(), events);
      expect(screen.queryByText('Waiting on: gather')).not.toBeInTheDocument();
    });
  });

  describe('VAL-PLAN-069: independent steps show bounded parallel progress', () => {
    it('shows running count against the approved fan-out limit', () => {
      const rev = approvedRevision();
      // Make both steps independent (no dependencies) and both running.
      rev.content.steps[1].dependencies = [];
      const events = [
        evt(3, 'child.started', { stepKey: 'gather', childRunId: 'child-1', agentId: 'agent-42' }),
        evt(4, 'child.started', {
          stepKey: 'synthesize',
          childRunId: 'child-2',
          agentId: 'agent-43',
        }),
      ];
      renderCard(
        rev,
        snapshot({ childSummary: { running: 2, completed: 0, failed: 0, cancelled: 0, total: 2 } }),
        events,
      );
      expect(screen.getByText('2 steps running (fan-out limit: 4)')).toBeInTheDocument();
    });
  });

  describe('VAL-PLAN-070: successful step exposes its output', () => {
    it('exposes status, producing agent, tools, cost, and output for a completed step', () => {
      const events = [
        evt(3, 'child.started', { stepKey: 'gather', childRunId: 'child-1', agentId: 'agent-42' }),
        evt(4, 'child.completed', {
          stepKey: 'gather',
          childRunId: 'child-1',
          agentId: 'agent-42',
          outputSummary: '3 sources retrieved',
          costCents: 250,
        }),
      ];
      renderCard(approvedRevision(), snapshot(), events);
      const items = screen.getAllByRole('listitem');
      const step1 = items[0];
      expect(within(step1).getByText('Completed')).toBeInTheDocument();
      expect(within(step1).getByText('agent-42')).toBeInTheDocument();
      expect(within(step1).getByText('research.search')).toBeInTheDocument();
      expect(within(step1).getByText('research.extract')).toBeInTheDocument();
      expect(within(step1).getByText('$2.50')).toBeInTheDocument();
      expect(within(step1).getByText('3 sources retrieved')).toBeInTheDocument();
    });
  });

  describe('VAL-PLAN-071: step failure is explicit', () => {
    it('shows failed text, a safe failure message/category, and the affected step/agent', () => {
      const events = [
        evt(3, 'child.started', { stepKey: 'gather', childRunId: 'child-1', agentId: 'agent-42' }),
        evt(4, 'child.failed', {
          stepKey: 'gather',
          childRunId: 'child-1',
          agentId: 'agent-42',
          failureCategory: 'tool_failed',
          failureCode: 'EXTRACT_TIMEOUT',
          safeErrorMessage: 'Source extraction timed out after 30s.',
        }),
      ];
      renderCard(approvedRevision(), snapshot(), events);
      const items = screen.getAllByRole('listitem');
      const step1 = items[0];
      expect(within(step1).getByText('Failed')).toBeInTheDocument();
      expect(within(step1).getByText('Source extraction timed out after 30s.')).toBeInTheDocument();
      expect(within(step1).getByText(/Category: tool_failed/)).toBeInTheDocument();
      // Does not present the step as successful.
      expect(within(step1).queryByText('Completed')).not.toBeInTheDocument();
    });
  });

  describe('VAL-PLAN-072: require-all failure stops dependent success', () => {
    it('marks dependents as not run under require_all when a required step fails', () => {
      const rev = approvedRevision(); // partialResultPolicy: require_all
      const events = [
        evt(3, 'child.started', { stepKey: 'gather', childRunId: 'child-1', agentId: 'agent-42' }),
        evt(4, 'child.failed', {
          stepKey: 'gather',
          childRunId: 'child-1',
          agentId: 'agent-42',
          failureCategory: 'tool_failed',
          failureCode: 'EXTRACT_TIMEOUT',
          safeErrorMessage: 'Source extraction timed out.',
        }),
      ];
      renderCard(
        rev,
        snapshot({
          status: 'failed',
          failureCategory: 'child_failed',
          safeErrorMessage: 'A required step failed.',
        }),
        events,
      );
      const items = screen.getAllByRole('listitem');
      // gather failed.
      expect(within(items[0]).getByText('Failed')).toBeInTheDocument();
      // synthesize (depends on gather) did not run; not completed/running.
      expect(within(items[1]).queryByText('Completed')).not.toBeInTheDocument();
      expect(within(items[1]).queryByText('Running')).not.toBeInTheDocument();
    });
  });

  describe('VAL-PLAN-073: best-effort failure permits partial result', () => {
    it('labels the result partial when a sibling fails under best_effort while another succeeds', () => {
      const rev = approvedRevision();
      rev.content.partialResultPolicy = 'best_effort';
      rev.content.steps[1].dependencies = []; // independent siblings
      const events = [
        evt(3, 'child.started', { stepKey: 'gather', childRunId: 'child-1', agentId: 'agent-42' }),
        evt(4, 'child.completed', {
          stepKey: 'gather',
          childRunId: 'child-1',
          agentId: 'agent-42',
          outputSummary: '3 sources retrieved',
          costCents: 250,
        }),
        evt(5, 'child.started', {
          stepKey: 'synthesize',
          childRunId: 'child-2',
          agentId: 'agent-43',
        }),
        evt(6, 'child.failed', {
          stepKey: 'synthesize',
          childRunId: 'child-2',
          agentId: 'agent-43',
          failureCategory: 'tool_failed',
          failureCode: 'ARTIFACT_COMMIT_ERROR',
          safeErrorMessage: 'Artifact commit failed.',
        }),
      ];
      renderCard(
        rev,
        snapshot({
          status: 'completed',
          partialResultPolicy: 'best_effort',
          resultCompleteness: 'partial',
        }),
        events,
      );
      // One step completed, one failed; result labelled partial.
      expect(screen.getByText(/Result: partial/)).toBeInTheDocument();
      // The missing/failed step is named.
      expect(screen.getByText(/synthesize/)).toBeInTheDocument();
    });
  });

  describe('VAL-PLAN-074: failure cannot alter approved scope', () => {
    it('shows the approved revision and hash governing the progress', () => {
      const events = [
        evt(3, 'child.started', { stepKey: 'gather', childRunId: 'child-1', agentId: 'agent-42' }),
        evt(4, 'child.failed', {
          stepKey: 'gather',
          childRunId: 'child-1',
          agentId: 'agent-42',
          failureCategory: 'tool_failed',
          failureCode: 'EXTRACT_TIMEOUT',
          safeErrorMessage: 'Source extraction timed out.',
        }),
      ];
      renderCard(
        approvedRevision(),
        snapshot({ status: 'failed', failureCategory: 'child_failed' }),
        events,
      );
      // The approved revision number and hash prefix govern progress.
      expect(screen.getByText('Revision 2')).toBeInTheDocument();
      expect(screen.getByText(APPROVED_HASH.slice(0, 12))).toBeInTheDocument();
    });
  });

  describe('VAL-PLAN-065: cross-surface navigation preserves context', () => {
    it('exposes a stable anchor id and approved revision/hash for deep-link focus', () => {
      renderCard(approvedRevision(), snapshot(), []);
      const section = screen.getByTestId('mission-step-progress');
      expect(section).toHaveAttribute('id', 'mission-step-progress-run-1');
      // Revision and hash are visible so navigation preserves the plan context.
      expect(screen.getByText('Revision 2')).toBeInTheDocument();
    });
  });

  describe('accessibility and responsive contract', () => {
    it('conveys status with text, never color alone', () => {
      const events = [
        evt(3, 'child.started', { stepKey: 'gather', childRunId: 'child-1', agentId: 'agent-42' }),
        evt(4, 'child.completed', {
          stepKey: 'gather',
          childRunId: 'child-1',
          agentId: 'agent-42',
        }),
      ];
      renderCard(approvedRevision(), snapshot(), events);
      // Each status has explicit text.
      expect(screen.getByText('Completed')).toBeInTheDocument();
      expect(screen.getByText('Pending')).toBeInTheDocument();
    });

    it('uses a semantic ordered list for step progress', () => {
      renderCard(approvedRevision(), snapshot(), []);
      expect(screen.getByRole('list', { name: 'Approved step progress' })).toBeInTheDocument();
    });

    it('announces meaningful status changes through a polite live region', () => {
      const events = [
        evt(3, 'child.started', { stepKey: 'gather', childRunId: 'child-1', agentId: 'agent-42' }),
        evt(4, 'child.completed', {
          stepKey: 'gather',
          childRunId: 'child-1',
          agentId: 'agent-42',
        }),
      ];
      renderCard(approvedRevision(), snapshot(), events);
      const live = screen.getByTestId('step-progress-live-region');
      expect(live).toHaveAttribute('aria-live', 'polite');
    });
  });
});
