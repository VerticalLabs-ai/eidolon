import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MissionArtifactCitations,
  MissionCitationMark,
  MissionProvenanceDrawer,
  MissionSourceLink,
  validateExternalSourceUrl,
} from '../src/components/projects/MissionArtifactCitations';
import type {
  MissionArtifactSummary,
  MissionCitationDetail,
  MissionProvenanceDetail,
} from '../src/lib/api';

// ── Mocks ────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  useMissionRunArtifacts: vi.fn(),
  useArtifactRevisionCitations: vi.fn(),
  useArtifactRevisionProvenance: vi.fn(),
}));

vi.mock('@/lib/hooks', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/hooks');
  return {
    ...actual,
    useMissionRunArtifacts: mocks.useMissionRunArtifacts,
    useArtifactRevisionCitations: mocks.useArtifactRevisionCitations,
    useArtifactRevisionProvenance: mocks.useArtifactRevisionProvenance,
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
    section: undefined,
    charStart: undefined,
    charEnd: undefined,
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
    approvedPlanRevisionId: 'plan-rev-1',
    approvedPlanHash: 'a'.repeat(64),
    policyHash: 'b'.repeat(64),
    producingStepKey: 'step-1',
    producingChildRunId: null,
    generationTime: '2026-08-24T10:05:00.000Z',
    citedSourceRevisionIds: ['src-rev-1'],
    newerArtifactVersionExists: false,
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
    citationCount: 2,
    producingRunId: RUN,
    producingStepKey: 'step-1',
    producingChildRunId: null,
    ...overrides,
  };
}

/** EvidenceDocumentV1 content with two inline citation marks. */
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
          { type: 'text', text: ' the findings are significant. Another source ' },
          { type: 'citation', citationId: 'cite-2' },
          { type: 'text', text: ' confirms this.' },
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

// ── Tests ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MissionCitationMark', () => {
  it('renders a stable ordinal in reading order (VAL-RES-027)', () => {
    renderWithProviders(<MissionCitationMark ordinal={1} citationId="cite-1" onSelect={vi.fn()} />);
    const mark = screen.getByRole('button', { name: /citation 1/i });
    expect(mark).toBeInTheDocument();
    expect(mark).toHaveTextContent('[1]');
  });

  it('is keyboard accessible and opens provenance on Enter (VAL-RES-028)', () => {
    const onSelect = vi.fn();
    renderWithProviders(
      <MissionCitationMark ordinal={1} citationId="cite-1" onSelect={onSelect} />,
    );
    const mark = screen.getByRole('button', { name: /citation 1/i });
    mark.focus();
    fireEvent.keyDown(mark, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('cite-1');
  });

  it('is keyboard accessible on Space key (VAL-RES-028)', () => {
    const onSelect = vi.fn();
    renderWithProviders(
      <MissionCitationMark ordinal={2} citationId="cite-2" onSelect={onSelect} />,
    );
    const mark = screen.getByRole('button', { name: /citation 2/i });
    mark.focus();
    fireEvent.keyDown(mark, { key: ' ' });
    expect(onSelect).toHaveBeenCalledWith('cite-2');
  });

  it('does not fire on non-activation keys', () => {
    const onSelect = vi.fn();
    renderWithProviders(
      <MissionCitationMark ordinal={1} citationId="cite-1" onSelect={onSelect} />,
    );
    const mark = screen.getByRole('button', { name: /citation 1/i });
    fireEvent.keyDown(mark, { key: 'Tab' });
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('MissionSourceLink', () => {
  it('renders a safe external link with target and rel attributes (VAL-RES-029)', () => {
    renderWithProviders(<MissionSourceLink url="https://example.com/report" label="View source" />);
    const link = screen.getByRole('link', { name: /view source.*opens in a new tab/i });
    expect(link).toHaveAttribute('href', 'https://example.com/report');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  });

  it('announces that it opens a new context (VAL-RES-029)', () => {
    renderWithProviders(
      <MissionSourceLink url="https://example.com/report" label="Example Report" />,
    );
    const link = screen.getByRole('link', { name: /example report.*opens in a new tab/i });
    expect(link).toBeInTheDocument();
  });

  it('rejects unsafe URL schemes (VAL-RES-029)', () => {
    renderWithProviders(<MissionSourceLink url="javascript:alert(1)" label="Bad" />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  const CRED_URL = (() => {
    const u = new URL('https://example.com/report');
    u.username = 'a';
    u.password = 'b';
    return u.href;
  })();
  it('rejects URLs with credentials (VAL-RES-029)', () => {
    renderWithProviders(<MissionSourceLink url={CRED_URL} label="Bad" />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('validateExternalSourceUrl', () => {
  it('accepts valid HTTPS URLs', () => {
    expect(validateExternalSourceUrl('https://example.com/report')).toBe(true);
    expect(validateExternalSourceUrl('https://sub.example.com/path?q=1')).toBe(true);
  });

  it('rejects non-HTTPS schemes', () => {
    expect(validateExternalSourceUrl('http://example.com')).toBe(false);
    expect(validateExternalSourceUrl('ftp://example.com')).toBe(false);
    expect(validateExternalSourceUrl('javascript:alert(1)')).toBe(false);
    expect(validateExternalSourceUrl('data:text/html,<script>')).toBe(false);
  });

  it('rejects URLs with credentials', () => {
    expect(
      validateExternalSourceUrl(
        (() => {
          const u = new URL('https://example.com');
          u.username = 'a';
          u.password = 'b';
          return u.href;
        })(),
      ),
    ).toBe(false);
    expect(
      validateExternalSourceUrl(
        (() => {
          const u = new URL('https://example.com');
          u.username = 'a';
          return u.href;
        })(),
      ),
    ).toBe(false);
  });

  it('rejects URLs with fragments', () => {
    expect(validateExternalSourceUrl('https://example.com#frag')).toBe(false);
  });

  it('rejects non-443 ports', () => {
    expect(validateExternalSourceUrl('https://example.com:8080')).toBe(false);
    expect(validateExternalSourceUrl('https://example.com:443')).toBe(true);
  });
});

describe('MissionProvenanceDrawer', () => {
  it('shows all required provenance fields (VAL-RES-030)', () => {
    const cite = citation();
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
    const drawer = screen.getByRole('dialog', { name: /provenance.*citation 1/i });
    // Citation key/ordinal
    expect(within(drawer).getByText(/Key 1/i)).toBeInTheDocument();
    // Source title/domain
    expect(within(drawer).getByText(/Example Report/i)).toBeInTheDocument();
    expect(within(drawer).getByText(/example\.com/i)).toBeInTheDocument();
    // Exact quote
    expect(within(drawer).getByText(/The quick brown fox/i)).toBeInTheDocument();
    // Retrieval time
    expect(within(drawer).getByText(/Retrieved:/i)).toBeInTheDocument();
    // Provider/operation
    expect(within(drawer).getByText(/tavily/i)).toBeInTheDocument();
    expect(within(drawer).getByText(/search/i)).toBeInTheDocument();
    // Source revision
    expect(within(drawer).getByText(/src-rev-1/i)).toBeInTheDocument();
    // Artifact version
    expect(within(drawer).getByText(/version 2/i)).toBeInTheDocument();
    // Producing run/step
    expect(within(drawer).getByText(/step-1/i)).toBeInTheDocument();
    expect(within(drawer).getByText(RUN)).toBeInTheDocument();
  });

  it('shows a newer-revision notice when a newer version exists (VAL-RES-031, VAL-CROSS-041)', () => {
    const cite = citation();
    const prov = provenance({ newerArtifactVersionExists: true });
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
    expect(screen.getByText(/newer revision exists/i)).toBeInTheDocument();
  });

  it('does not show newer-revision notice for the latest revision (VAL-RES-031)', () => {
    const cite = citation();
    const prov = provenance({ newerArtifactVersionExists: false });
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
    expect(screen.queryByText(/newer revision exists/i)).not.toBeInTheDocument();
  });

  it('provides a return link to the producing Mission (VAL-CROSS-040, VAL-CROSS-047)', () => {
    const cite = citation();
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
    const returnLink = screen.getByRole('link', { name: /back to mission/i });
    expect(returnLink).toBeInTheDocument();
    expect(returnLink.getAttribute('href')).toContain(RUN);
  });

  it('provides an external source link (VAL-RES-029, VAL-CROSS-040)', () => {
    const cite = citation();
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
    const sourceLink = screen.getByRole('link', { name: /view source.*opens in a new tab/i });
    expect(sourceLink).toHaveAttribute('href', 'https://example.com/report');
  });

  it('closes on Escape key and restores focus (VAL-RES-028)', () => {
    const onClose = vi.fn();
    const cite = citation();
    const prov = provenance();
    renderWithProviders(
      <MissionProvenanceDrawer
        open={true}
        citation={cite}
        provenance={prov}
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        onClose={onClose}
      />,
    );
    const drawer = screen.getByRole('dialog');
    fireEvent.keyDown(drawer, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('renders safely with null provenance (graceful degradation)', () => {
    const cite = citation();
    renderWithProviders(
      <MissionProvenanceDrawer
        open={true}
        citation={cite}
        provenance={null}
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        onClose={vi.fn()}
      />,
    );
    // Still shows citation details
    expect(screen.getByText(/The quick brown fox/i)).toBeInTheDocument();
    // Shows a notice that provenance is unavailable
    expect(screen.getByText(/provenance unavailable/i)).toBeInTheDocument();
  });
});

describe('MissionArtifactCitations', () => {
  it('renders inline citation marks with stable ordinals in reading order (VAL-RES-027)', () => {
    mockArtifactsQuery([artifactSummary({ citationCount: 2 })]);
    mockCitationsQuery([
      citation({ citationId: 'cite-1', ordinal: 1 }),
      citation({ citationId: 'cite-2', ordinal: 2, quote: 'Second quote.' }),
    ]);
    mockProvenanceQuery(provenance());

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

    const marks = screen.getAllByRole('button', { name: /citation \d/i });
    expect(marks).toHaveLength(2);
    expect(marks[0]).toHaveTextContent('[1]');
    expect(marks[1]).toHaveTextContent('[2]');
  });

  it('opens provenance drawer when an inline mark is clicked (VAL-RES-028, VAL-CROSS-040)', () => {
    mockArtifactsQuery([artifactSummary()]);
    mockCitationsQuery([citation()]);
    mockProvenanceQuery(provenance());

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

    const mark = screen.getByRole('button', { name: /citation 1/i });
    fireEvent.click(mark);

    // Drawer should be open
    expect(screen.getByRole('dialog', { name: /provenance/i })).toBeInTheDocument();
  });

  it('opens provenance drawer via keyboard (VAL-RES-028)', () => {
    mockArtifactsQuery([artifactSummary()]);
    mockCitationsQuery([citation()]);
    mockProvenanceQuery(provenance());

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

    const mark = screen.getByRole('button', { name: /citation 1/i });
    mark.focus();
    fireEvent.keyDown(mark, { key: 'Enter' });

    expect(screen.getByRole('dialog', { name: /provenance/i })).toBeInTheDocument();
  });

  it('preserves artifact reading position when drawer opens (VAL-RES-028)', () => {
    mockArtifactsQuery([artifactSummary()]);
    mockCitationsQuery([citation()]);
    mockProvenanceQuery(provenance());

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

    const mark = screen.getByRole('button', { name: /citation 1/i });
    fireEvent.click(mark);

    // The artifact content should still be visible (not unmounted)
    expect(screen.getByText('Research Summary')).toBeInTheDocument();
    expect(screen.getByText(/According to the report/i)).toBeInTheDocument();
  });

  it('focuses a specific citation when targetCitationId is provided (VAL-RES-037, VAL-CROSS-041)', () => {
    mockArtifactsQuery([artifactSummary()]);
    mockCitationsQuery([citation()]);
    mockProvenanceQuery(provenance());

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

    // The citation mark should have focus
    const mark = screen.getByRole('button', { name: /citation 1/i });
    expect(mark).toHaveAttribute('data-citation-target', 'true');
  });

  it('shows the exact artifact version, not the latest (VAL-RES-037, VAL-CROSS-041)', () => {
    mockArtifactsQuery([artifactSummary({ version: 2 })]);
    mockCitationsQuery([citation({ artifactVersion: 2 })]);
    mockProvenanceQuery(provenance({ artifactVersion: 2, newerArtifactVersionExists: true }));

    renderWithProviders(
      <MissionArtifactCitations
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        artifactId={ARTIFACT_ID}
        artifactVersion={2}
        content={documentContent()}
      />,
    );

    // Should show version 2 explicitly in the header
    expect(screen.getByTestId('mission-artifact-citations')).toHaveTextContent(/Version 2/i);
    // Should show newer-revision notice outside the drawer
    expect(screen.getByTestId('artifact-newer-revision-notice')).toBeInTheDocument();
    expect(screen.getByText(/newer revision exists/i)).toBeInTheDocument();
  });

  it('provides a return link to the producing Mission (VAL-CROSS-047)', () => {
    mockArtifactsQuery([artifactSummary()]);
    mockCitationsQuery([citation()]);
    mockProvenanceQuery(provenance());

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

    const returnLink = screen.getByRole('link', { name: /back to mission/i });
    expect(returnLink).toBeInTheDocument();
    expect(returnLink.getAttribute('href')).toContain(RUN);
  });

  it('renders a safe external source link for each citation (VAL-RES-029)', () => {
    mockArtifactsQuery([artifactSummary()]);
    mockCitationsQuery([citation()]);
    mockProvenanceQuery(provenance());

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

    // Open the drawer to see the source link
    const mark = screen.getByRole('button', { name: /citation 1/i });
    fireEvent.click(mark);

    const sourceLink = screen.getByRole('link', { name: /view source.*opens in a new tab/i });
    expect(sourceLink).toHaveAttribute('href', 'https://example.com/report');
    expect(sourceLink).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  });

  it('renders inert text for untrusted content (no HTML injection)', () => {
    mockArtifactsQuery([artifactSummary()]);
    mockCitationsQuery([
      citation({
        frozenTitle: '<script>alert("xss")</script>',
        quote: '<img src=x onerror=alert(1)>',
      }),
    ]);
    mockProvenanceQuery(provenance());

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

    // Open the drawer
    fireEvent.click(screen.getByRole('button', { name: /citation 1/i }));

    // No script tags should be injected
    expect(document.querySelectorAll('script')).toHaveLength(0);
    expect(document.querySelectorAll('img')).toHaveLength(0);
  });

  it('shows a loading state while citations are loading', () => {
    mockArtifactsQuery([artifactSummary()]);
    mockCitationsQuery([], true);
    mockProvenanceQuery(provenance());

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

    // Citation marks should not render while loading; content should still be visible
    expect(screen.getByText('Research Summary')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /citation/i })).not.toBeInTheDocument();
  });

  it('renders content blocks without citations when no citations exist', () => {
    mockArtifactsQuery([artifactSummary({ citationCount: 0 })]);
    mockCitationsQuery([]);
    mockProvenanceQuery(provenance());

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

    expect(screen.getByText('Research Summary')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /citation/i })).not.toBeInTheDocument();
  });

  it('renders an error state when citation loading fails', () => {
    mocks.useMissionRunArtifacts.mockReturnValue({
      data: { artifacts: [artifactSummary()] },
      isLoading: false,
      isError: false,
    });
    mocks.useArtifactRevisionCitations.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });
    mocks.useArtifactRevisionProvenance.mockReturnValue({
      data: provenance(),
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

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/could not load citations/i)).toBeInTheDocument();
  });
});
