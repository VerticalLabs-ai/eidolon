import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionArtifactSection } from '../src/components/projects/MissionArtifactSection';
import type { MissionArtifactSummary } from '../src/lib/api';

// ── Mocks ────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  useMissionRunArtifacts: vi.fn(),
  useArtifactRevisionContent: vi.fn(),
}));

vi.mock('@/lib/hooks', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/hooks');
  return {
    ...actual,
    useMissionRunArtifacts: mocks.useMissionRunArtifacts,
    useArtifactRevisionContent: mocks.useArtifactRevisionContent,
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

const COMPANY = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const RUN = '44444444-4444-4444-8444-444444444444';
const ARTIFACT_ID = '55555555-5555-4555-8555-555555555555';
const LATEST_VERSION = 5;

function artifactSummary(o: Partial<MissionArtifactSummary> = {}): MissionArtifactSummary {
  return {
    artifactId: ARTIFACT_ID,
    title: 'Research Findings',
    type: 'document',
    version: LATEST_VERSION,
    artifactRevisionId: 'art-rev-1',
    citationCount: 2,
    producingRunId: RUN,
    producingStepKey: 'step-1',
    producingChildRunId: null,
    ...o,
  };
}

function doc() {
  return {
    schemaVersion: 1,
    blocks: [
      { type: 'heading', level: 2, spans: [{ type: 'text', text: 'Research Summary' }] },
      {
        type: 'paragraph',
        spans: [{ type: 'text', text: 'According to the report, the findings are significant.' }],
      },
    ],
  };
}

function renderSection(props: React.ComponentProps<typeof MissionArtifactSection>) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MissionArtifactSection {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useMissionRunArtifacts.mockReturnValue({
    data: { artifacts: [artifactSummary()] },
    isLoading: false,
    isError: false,
  });
  mocks.useArtifactRevisionContent.mockReturnValue({
    data: { content: doc() },
    isLoading: false,
    isError: false,
  });
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('MissionArtifactSection deep-link version (VAL-M1-055..065, VAL-M1-112)', () => {
  it('loads the latest revision when no targetVersion is provided (VAL-M1-056)', () => {
    renderSection({ companyId: COMPANY, projectId: PROJECT, runId: RUN });

    // useArtifactRevisionContent called with the latest version (5)
    expect(mocks.useArtifactRevisionContent).toHaveBeenCalledWith(
      COMPANY,
      ARTIFACT_ID,
      LATEST_VERSION,
      PROJECT,
    );
    // No invalid-version notice
    expect(screen.queryByTestId('invalid-version-notice')).toBeNull();
  });

  it('loads the exact revision when targetVersion is provided (VAL-M1-055)', () => {
    renderSection({
      companyId: COMPANY,
      projectId: PROJECT,
      runId: RUN,
      targetArtifactId: ARTIFACT_ID,
      targetVersion: '3',
    });

    // useArtifactRevisionContent called with version 3, not the latest (5)
    expect(mocks.useArtifactRevisionContent).toHaveBeenCalledWith(COMPANY, ARTIFACT_ID, 3, PROJECT);
  });

  it('passes targetCitationId only for the matching artifact (VAL-M1-060)', () => {
    const OTHER_ARTIFACT = '66666666-6666-4666-8666-666666666666';
    mocks.useMissionRunArtifacts.mockReturnValue({
      data: {
        artifacts: [
          artifactSummary(),
          artifactSummary({ artifactId: OTHER_ARTIFACT, title: 'Other Artifact' }),
        ],
      },
      isLoading: false,
      isError: false,
    });

    renderSection({
      companyId: COMPANY,
      projectId: PROJECT,
      runId: RUN,
      targetArtifactId: ARTIFACT_ID,
      targetCitationId: 'cite-42',
      targetVersion: '2',
    });

    // The matching artifact should have been called with version 2
    const calls = mocks.useArtifactRevisionContent.mock.calls;
    const matchingCall = calls.find((c) => c[1] === ARTIFACT_ID);
    expect(matchingCall).toBeDefined();
    expect(matchingCall![2]).toBe(2);

    // The non-matching artifact should use its own latest version
    const otherCall = calls.find((c) => c[1] === OTHER_ARTIFACT);
    expect(otherCall).toBeDefined();
    expect(otherCall![2]).toBe(LATEST_VERSION);
  });

  it('shows invalid-version notice for non-numeric targetVersion (VAL-M1-065)', () => {
    renderSection({
      companyId: COMPANY,
      projectId: PROJECT,
      runId: RUN,
      targetArtifactId: ARTIFACT_ID,
      targetVersion: 'abc',
    });

    // Invalid version notice is shown
    expect(screen.getByTestId('invalid-version-notice')).toBeInTheDocument();
    // Falls back to latest version
    expect(mocks.useArtifactRevisionContent).toHaveBeenCalledWith(
      COMPANY,
      ARTIFACT_ID,
      LATEST_VERSION,
      PROJECT,
    );
  });

  it('shows invalid-version notice for zero targetVersion (VAL-M1-065)', () => {
    renderSection({
      companyId: COMPANY,
      projectId: PROJECT,
      runId: RUN,
      targetArtifactId: ARTIFACT_ID,
      targetVersion: '0',
    });

    expect(screen.getByTestId('invalid-version-notice')).toBeInTheDocument();
    expect(mocks.useArtifactRevisionContent).toHaveBeenCalledWith(
      COMPANY,
      ARTIFACT_ID,
      LATEST_VERSION,
      PROJECT,
    );
  });

  it('shows graceful error when revision does not exist (VAL-M1-064)', () => {
    mocks.useArtifactRevisionContent.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });

    renderSection({
      companyId: COMPANY,
      projectId: PROJECT,
      runId: RUN,
      targetArtifactId: ARTIFACT_ID,
      targetVersion: '999',
    });

    // Error message mentions the revision number
    const errorEl = screen.getByTestId('artifact-revision-load-error');
    expect(errorEl).toBeInTheDocument();
    expect(errorEl.textContent).toContain('999');
  });

  it('shows graceful error for deleted artifact (VAL-M1-112)', () => {
    mocks.useMissionRunArtifacts.mockReturnValue({
      data: { artifacts: [] },
      isLoading: false,
      isError: false,
    });

    renderSection({
      companyId: COMPANY,
      projectId: PROJECT,
      runId: RUN,
      targetArtifactId: ARTIFACT_ID,
      targetVersion: '3',
    });

    expect(screen.getByTestId('artifact-not-found-error')).toBeInTheDocument();
  });

  it('returns null when no artifacts and no target (no error)', () => {
    mocks.useMissionRunArtifacts.mockReturnValue({
      data: { artifacts: [] },
      isLoading: false,
      isError: false,
    });

    const { container } = renderSection({ companyId: COMPANY, projectId: PROJECT, runId: RUN });
    expect(container.firstChild).toBeNull();
  });

  it('uses targetVersion for both artifactVersion and citation deep links', () => {
    // Simulate a citation deep link with version
    renderSection({
      companyId: COMPANY,
      projectId: PROJECT,
      runId: RUN,
      targetArtifactId: ARTIFACT_ID,
      targetCitationId: 'cite-1',
      targetVersion: '4',
    });

    expect(mocks.useArtifactRevisionContent).toHaveBeenCalledWith(COMPANY, ARTIFACT_ID, 4, PROJECT);
  });

  it('does not show invalid-version notice when targetVersion is absent', () => {
    renderSection({ companyId: COMPANY, projectId: PROJECT, runId: RUN });
    expect(screen.queryByTestId('invalid-version-notice')).toBeNull();
  });

  it('does not show invalid-version notice for valid numeric targetVersion', () => {
    renderSection({
      companyId: COMPANY,
      projectId: PROJECT,
      runId: RUN,
      targetArtifactId: ARTIFACT_ID,
      targetVersion: '2',
    });
    expect(screen.queryByTestId('invalid-version-notice')).toBeNull();
  });

  it('ignores targetVersion when targetArtifactId does not match any artifact', () => {
    renderSection({
      companyId: COMPANY,
      projectId: PROJECT,
      runId: RUN,
      targetArtifactId: 'nonexistent-artifact-id',
      targetVersion: '3',
    });

    // Falls back to latest version for the actual artifact
    expect(mocks.useArtifactRevisionContent).toHaveBeenCalledWith(
      COMPANY,
      ARTIFACT_ID,
      LATEST_VERSION,
      PROJECT,
    );
  });
});
