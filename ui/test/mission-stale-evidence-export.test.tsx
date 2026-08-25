import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MissionArtifactCitations,
  MissionProvenanceDrawer,
} from '../src/components/projects/MissionArtifactCitations';
import { MissionArtifactExport } from '../src/components/projects/MissionArtifactExport';
import type {
  MissionArtifactSummary,
  MissionCitationDetail,
  MissionProvenanceDetail,
  CarryForwardOutcome,
} from '../src/lib/api';

// ── Mocks ────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  useMissionRunArtifacts: vi.fn(),
  useArtifactRevisionCitations: vi.fn(),
  useArtifactRevisionProvenance: vi.fn(),
  useCarryForwardOutcomes: vi.fn(),
  downloadArtifactRevisionExport: vi.fn(),
}));

vi.mock('@/lib/hooks', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/hooks');
  return {
    ...actual,
    useMissionRunArtifacts: mocks.useMissionRunArtifacts,
    useArtifactRevisionCitations: mocks.useArtifactRevisionCitations,
    useArtifactRevisionProvenance: mocks.useArtifactRevisionProvenance,
    useCarryForwardOutcomes: mocks.useCarryForwardOutcomes,
  };
});

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/api');
  return {
    ...actual,
    downloadArtifactRevisionExport: mocks.downloadArtifactRevisionExport,
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
const ARTIFACT_VERSION = 2;

function citation(overrides: Partial<MissionCitationDetail> = {}): MissionCitationDetail {
  return {
    citationId: 'cite-1',
    ordinal: 1,
    quote: 'The quick brown fox jumps over the lazy dog.',
    frozenTitle: 'Example Report',
    frozenAuthor: 'Jane Doe',
    canonicalUrl: 'https://example.com/report',
    frozenRetrievedAt: '2026-08-24T10:01:00.000Z',
    frozenProvider: 'tavily',
    frozenOperation: 'search',
    sourceRevisionId: 'src-rev-1',
    artifactRevisionId: 'art-rev-1',
    artifactVersion: ARTIFACT_VERSION,
    sourceAvailabilityStatus: null,
    sourceAvailabilityCheckedAt: null,
    ...overrides,
  };
}

function provenance(overrides: Partial<MissionProvenanceDetail> = {}): MissionProvenanceDetail {
  return {
    provenanceId: 'prov-1',
    runId: RUN,
    rootRunId: RUN,
    artifactId: ARTIFACT_ID,
    artifactRevisionId: 'art-rev-1',
    artifactVersion: ARTIFACT_VERSION,
    producingStepKey: 'step-1',
    producingChildRunId: null,
    generationTime: '2026-08-24T10:05:00.000Z',
    citedSourceRevisionIds: ['src-rev-1'],
    newerArtifactVersionExists: false,
    newerSourceRevisionExists: false,
    ...overrides,
  };
}

function artifactSummary(overrides: Partial<MissionArtifactSummary> = {}): MissionArtifactSummary {
  return {
    artifactId: ARTIFACT_ID,
    title: 'Research Findings',
    type: 'document',
    version: ARTIFACT_VERSION,
    artifactRevisionId: 'art-rev-1',
    citationCount: 1,
    producingRunId: RUN,
    producingStepKey: 'step-1',
    producingChildRunId: null,
    ...overrides,
  };
}

function documentContent() {
  return {
    schemaVersion: 1,
    blocks: [
      {
        type: 'heading',
        level: 2,
        spans: [{ type: 'text', text: 'Research Summary' }],
      },
      {
        type: 'paragraph',
        spans: [
          { type: 'text', text: 'According to the report, ' },
          { type: 'citation', citationId: 'cite-1' },
          { type: 'text', text: ' the findings are significant.' },
        ],
      },
    ],
  };
}

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function mockArtifactsQuery(artifacts: MissionArtifactSummary[], loading = false) {
  mocks.useMissionRunArtifacts.mockReturnValue({
    data: loading ? undefined : { artifacts },
    isLoading: loading,
    isError: false,
  });
}

function mockCitationsQuery(citations: MissionCitationDetail[], loading = false) {
  mocks.useArtifactRevisionCitations.mockReturnValue({
    data: loading ? undefined : { citations },
    isLoading: loading,
    isError: false,
  });
}

function mockProvenanceQuery(prov: MissionProvenanceDetail | null, loading = false) {
  mocks.useArtifactRevisionProvenance.mockReturnValue({
    data: loading ? undefined : prov,
    isLoading: loading,
    isError: false,
  });
}

function mockCarryForwardOutcomes(outcomes: CarryForwardOutcome[], loading = false) {
  mocks.useCarryForwardOutcomes.mockReturnValue({
    data: loading ? undefined : { outcomes, artifactId: ARTIFACT_ID, version: ARTIFACT_VERSION },
    isLoading: loading,
    isError: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.downloadArtifactRevisionExport.mockResolvedValue({ ok: true, status: 200 });
});

// ── VAL-RES-035: Stale citation after passage edit ───────────────────────

describe('VAL-RES-035: Stale citation after passage edit', () => {
  it('shows a not-carried-forward notice when a citation was not carried forward', () => {
    mockArtifactsQuery([artifactSummary()]);
    mockCitationsQuery([citation()]);
    mockProvenanceQuery(provenance({ newerArtifactVersionExists: true }));
    mockCarryForwardOutcomes([
      {
        previousCitationId: 'cite-prev-1',
        outcome: 'not_carried_forward',
        reason: 'ARTIFACT_LOCATOR_INVALID: passage changed',
        ordinal: 1,
      },
    ]);

    renderWithProviders(
      <MissionArtifactCitations
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        artifactId={ARTIFACT_ID}
        artifactVersion={ARTIFACT_VERSION}
        content={documentContent()}
      />,
    );

    expect(screen.getByTestId('stale-citation-notice')).toBeInTheDocument();
    expect(screen.getAllByText(/not carried forward/i).length).toBeGreaterThan(0);
  });

  it('does not show a stale notice when all citations were carried forward', () => {
    mockArtifactsQuery([artifactSummary()]);
    mockCitationsQuery([citation()]);
    mockProvenanceQuery(provenance());
    mockCarryForwardOutcomes([
      {
        previousCitationId: 'cite-prev-1',
        newCitationId: 'cite-1',
        outcome: 'carried_forward',
        ordinal: 1,
      },
    ]);

    renderWithProviders(
      <MissionArtifactCitations
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        artifactId={ARTIFACT_ID}
        artifactVersion={ARTIFACT_VERSION}
        content={documentContent()}
      />,
    );

    expect(screen.queryByTestId('stale-citation-notice')).not.toBeInTheDocument();
  });

  it('shows the reason for the not-carried-forward citation', () => {
    mockArtifactsQuery([artifactSummary()]);
    mockCitationsQuery([citation()]);
    mockProvenanceQuery(provenance({ newerArtifactVersionExists: true }));
    mockCarryForwardOutcomes([
      {
        previousCitationId: 'cite-prev-1',
        outcome: 'not_carried_forward',
        reason: 'ARTIFACT_LOCATOR_INVALID: passage changed',
        ordinal: 1,
      },
    ]);

    renderWithProviders(
      <MissionArtifactCitations
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        artifactId={ARTIFACT_ID}
        artifactVersion={ARTIFACT_VERSION}
        content={documentContent()}
      />,
    );

    expect(screen.getByText(/ARTIFACT_LOCATOR_INVALID/i)).toBeInTheDocument();
  });
});

// ── VAL-RES-036: Stale source notice ─────────────────────────────────────

describe('VAL-RES-036: Stale source notice', () => {
  it('shows a newer-source-revision notice in the provenance drawer', () => {
    const cite = citation();
    const prov = provenance({ newerSourceRevisionExists: true });
    renderWithProviders(
      <MissionProvenanceDrawer
        open={true}
        citation={cite}
        provenance={prov}
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('newer-source-notice')).toBeInTheDocument();
    expect(screen.getByText(/newer source/i)).toBeInTheDocument();
  });

  it('does not show a newer-source notice when no newer source exists', () => {
    const cite = citation();
    const prov = provenance({ newerSourceRevisionExists: false });
    renderWithProviders(
      <MissionProvenanceDrawer
        open={true}
        citation={cite}
        provenance={prov}
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('newer-source-notice')).not.toBeInTheDocument();
  });

  it('continues to resolve to the original source revision', () => {
    const cite = citation({ sourceRevisionId: 'src-rev-1' });
    const prov = provenance({
      newerSourceRevisionExists: true,
      citedSourceRevisionIds: ['src-rev-1'],
    });
    renderWithProviders(
      <MissionProvenanceDrawer
        open={true}
        citation={cite}
        provenance={prov}
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        onClose={vi.fn()}
      />,
    );

    // The original source revision ID is still shown
    expect(screen.getByText('src-rev-1')).toBeInTheDocument();
  });
});

// ── VAL-RES-042: Source unavailable after citation ──────────────────────

describe('VAL-RES-042: Source unavailable after citation', () => {
  it('shows source unavailable status in the provenance drawer', () => {
    const cite = citation({
      sourceAvailabilityStatus: 'unavailable',
      sourceAvailabilityCheckedAt: '2026-08-25T12:00:00.000Z',
    });
    const prov = provenance();
    renderWithProviders(
      <MissionProvenanceDrawer
        open={true}
        citation={cite}
        provenance={prov}
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('source-availability-status')).toBeInTheDocument();
    expect(screen.getByText(/unavailable/i)).toBeInTheDocument();
  });

  it('shows source available status when the source is reachable', () => {
    const cite = citation({
      sourceAvailabilityStatus: 'available',
      sourceAvailabilityCheckedAt: '2026-08-25T12:00:00.000Z',
    });
    const prov = provenance();
    renderWithProviders(
      <MissionProvenanceDrawer
        open={true}
        citation={cite}
        provenance={prov}
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('source-availability-status')).toBeInTheDocument();
    expect(screen.getByText(/available/i)).toBeInTheDocument();
  });

  it('keeps the artifact reviewable with the original source revision', () => {
    mockArtifactsQuery([artifactSummary()]);
    mockCitationsQuery([
      citation({
        sourceAvailabilityStatus: 'unavailable',
        sourceAvailabilityCheckedAt: '2026-08-25T12:00:00.000Z',
      }),
    ]);
    mockProvenanceQuery(provenance());
    mockCarryForwardOutcomes([]);

    renderWithProviders(
      <MissionArtifactCitations
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        artifactId={ARTIFACT_ID}
        artifactVersion={ARTIFACT_VERSION}
        content={documentContent()}
      />,
    );

    // Artifact content is still visible
    expect(screen.getByText('Research Summary')).toBeInTheDocument();
    // Open the drawer
    fireEvent.click(screen.getByRole('button', { name: /citation 1/i }));
    // Original source revision is still shown
    expect(screen.getByText('src-rev-1')).toBeInTheDocument();
  });
});

// ── VAL-RES-043: Partial research disclosure ────────────────────────────

describe('VAL-RES-043: Partial research disclosure', () => {
  it('shows a partial-evidence warning when resultCompleteness is partial', () => {
    mockArtifactsQuery([artifactSummary()]);
    mockCitationsQuery([citation()]);
    mockProvenanceQuery(provenance());
    mockCarryForwardOutcomes([]);

    renderWithProviders(
      <MissionArtifactCitations
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        artifactId={ARTIFACT_ID}
        artifactVersion={ARTIFACT_VERSION}
        content={documentContent()}
        partialEvidence
      />,
    );

    expect(screen.getByTestId('partial-evidence-warning')).toBeInTheDocument();
    expect(screen.getByText(/partial evidence/i)).toBeInTheDocument();
  });

  it('does not show a partial-evidence warning when evidence is complete', () => {
    mockArtifactsQuery([artifactSummary()]);
    mockCitationsQuery([citation()]);
    mockProvenanceQuery(provenance());
    mockCarryForwardOutcomes([]);

    renderWithProviders(
      <MissionArtifactCitations
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        artifactId={ARTIFACT_ID}
        artifactVersion={ARTIFACT_VERSION}
        content={documentContent()}
      />,
    );

    expect(screen.queryByTestId('partial-evidence-warning')).not.toBeInTheDocument();
  });
});

// ── VAL-RES-088: Citation error recovery ────────────────────────────────

describe('VAL-RES-088: Citation error recovery', () => {
  it('shows a Retry button when citation loading fails', () => {
    mocks.useMissionRunArtifacts.mockReturnValue({
      data: { artifacts: [artifactSummary()] },
      isLoading: false,
      isError: false,
    });
    mocks.useArtifactRevisionCitations.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: vi.fn(),
    });
    mocks.useArtifactRevisionProvenance.mockReturnValue({
      data: provenance(),
      isLoading: false,
      isError: false,
    });
    mocks.useCarryForwardOutcomes.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    });

    renderWithProviders(
      <MissionArtifactCitations
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        artifactId={ARTIFACT_ID}
        artifactVersion={ARTIFACT_VERSION}
        content={documentContent()}
      />,
    );

    // Artifact content is still visible (reading remains available)
    expect(screen.getByText('Research Summary')).toBeInTheDocument();
    // Error alert is shown
    expect(screen.getByRole('alert')).toBeInTheDocument();
    // Retry button is available
    expect(screen.getByRole('button', { name: /retry.*citation/i })).toBeInTheDocument();
  });

  it('shows a Retry button when provenance loading fails', () => {
    mocks.useMissionRunArtifacts.mockReturnValue({
      data: { artifacts: [artifactSummary()] },
      isLoading: false,
      isError: false,
    });
    mocks.useArtifactRevisionCitations.mockReturnValue({
      data: { citations: [citation()] },
      isLoading: false,
      isError: false,
    });
    mocks.useArtifactRevisionProvenance.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: vi.fn(),
    });
    mocks.useCarryForwardOutcomes.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    });

    renderWithProviders(
      <MissionArtifactCitations
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        artifactId={ARTIFACT_ID}
        artifactVersion={ARTIFACT_VERSION}
        content={documentContent()}
      />,
    );

    // Artifact content is still visible
    expect(screen.getByText('Research Summary')).toBeInTheDocument();
    // Provenance error alert with retry
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry.*provenance/i })).toBeInTheDocument();
  });

  it('preserves exact artifact ID, revision, and citation focus on retry', async () => {
    const refetch = vi.fn();
    mocks.useMissionRunArtifacts.mockReturnValue({
      data: { artifacts: [artifactSummary()] },
      isLoading: false,
      isError: false,
    });
    mocks.useArtifactRevisionCitations.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch,
    });
    mocks.useArtifactRevisionProvenance.mockReturnValue({
      data: provenance(),
      isLoading: false,
      isError: false,
    });
    mocks.useCarryForwardOutcomes.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    });

    renderWithProviders(
      <MissionArtifactCitations
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        artifactId={ARTIFACT_ID}
        artifactVersion={ARTIFACT_VERSION}
        content={documentContent()}
        targetCitationId="cite-1"
      />,
    );

    const retryBtn = screen.getByRole('button', { name: /retry.*citation/i });
    fireEvent.click(retryBtn);
    expect(refetch).toHaveBeenCalled();
  });
});

// ── VAL-RES-103: Export interaction is accessible and recoverable ───────

describe('VAL-RES-103: Export interaction is accessible and recoverable', () => {
  it('names the exact revision and format in the control', () => {
    renderWithProviders(
      <MissionArtifactExport
        companyId={COMPANY}
        projectId={PROJECT}
        artifactId={ARTIFACT_ID}
        artifactVersion={ARTIFACT_VERSION}
      />,
    );

    expect(screen.getByText(/version 2/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /export.*markdown/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /export.*html/i })).toBeInTheDocument();
  });

  it('works by keyboard (Enter triggers markdown export)', async () => {
    renderWithProviders(
      <MissionArtifactExport
        companyId={COMPANY}
        projectId={PROJECT}
        artifactId={ARTIFACT_ID}
        artifactVersion={ARTIFACT_VERSION}
      />,
    );

    const mdBtn = screen.getByRole('button', { name: /export.*markdown/i });
    mdBtn.focus();
    fireEvent.keyDown(mdBtn, { key: 'Enter' });

    await waitFor(() => {
      expect(mocks.downloadArtifactRevisionExport).toHaveBeenCalledWith(
        COMPANY,
        PROJECT,
        ARTIFACT_ID,
        ARTIFACT_VERSION,
        'markdown',
      );
    });
  });

  it('exposes pending status without duplicate download', async () => {
    let resolveDownload: ((v: { ok: true; status: number }) => void) | null = null;
    mocks.downloadArtifactRevisionExport.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDownload = resolve;
        }),
    );

    renderWithProviders(
      <MissionArtifactExport
        companyId={COMPANY}
        projectId={PROJECT}
        artifactId={ARTIFACT_ID}
        artifactVersion={ARTIFACT_VERSION}
      />,
    );

    const mdBtn = screen.getByRole('button', { name: /export.*markdown/i });
    fireEvent.click(mdBtn);

    // Pending status is shown
    await waitFor(() => {
      expect(screen.getByText(/exporting/i)).toBeInTheDocument();
    });

    // Clicking again while pending does NOT trigger a second download
    fireEvent.click(mdBtn);
    expect(mocks.downloadArtifactRevisionExport).toHaveBeenCalledTimes(1);

    // Resolve
    resolveDownload!({ ok: true, status: 200 });

    await waitFor(() => {
      expect(screen.getByText(/downloaded/i)).toBeInTheDocument();
    });
  });

  it('shows an alert plus Retry on failure while remaining pinned to that revision', async () => {
    mocks.downloadArtifactRevisionExport.mockRejectedValue(new Error('Export failed: 500'));

    renderWithProviders(
      <MissionArtifactExport
        companyId={COMPANY}
        projectId={PROJECT}
        artifactId={ARTIFACT_ID}
        artifactVersion={ARTIFACT_VERSION}
      />,
    );

    const mdBtn = screen.getByRole('button', { name: /export.*markdown/i });
    fireEvent.click(mdBtn);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/export failed/i)).toBeInTheDocument();
    });

    // Retry button is available and pinned to the same revision
    const retryBtn = screen.getByRole('button', { name: /retry.*markdown/i });
    expect(retryBtn).toBeInTheDocument();

    // Retry uses the same revision
    mocks.downloadArtifactRevisionExport.mockResolvedValue({ ok: true, status: 200 });
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(mocks.downloadArtifactRevisionExport).toHaveBeenCalledTimes(2);
      expect(mocks.downloadArtifactRevisionExport).toHaveBeenLastCalledWith(
        COMPANY,
        PROJECT,
        ARTIFACT_ID,
        ARTIFACT_VERSION,
        'markdown',
      );
    });
  });

  it('remains pinned to the exact revision after a newer edit', () => {
    renderWithProviders(
      <MissionArtifactExport
        companyId={COMPANY}
        projectId={PROJECT}
        artifactId={ARTIFACT_ID}
        artifactVersion={3}
      />,
    );

    expect(screen.getByText(/version 3/i)).toBeInTheDocument();
  });
});
