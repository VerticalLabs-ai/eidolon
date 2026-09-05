import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MissionArtifactCitations,
  MissionCitationMark,
  MissionProvenanceDrawer,
} from '../src/components/projects/MissionArtifactCitations';
import {
  MissionSourceList,
  MissionResearchProgress,
} from '../src/components/projects/MissionResearchSources';
import type {
  MissionArtifactSummary,
  MissionCitationDetail,
  MissionProvenanceDetail,
  MissionSourceSummary,
  MissionReplayEvent,
  CarryForwardOutcome,
} from '../src/lib/api';

const mocks = vi.hoisted(() => ({
  useMissionRunSources: vi.fn(),
  useMissionRunArtifacts: vi.fn(),
  useArtifactRevisionCitations: vi.fn(),
  useArtifactRevisionProvenance: vi.fn(),
  useCarryForwardOutcomes: vi.fn(),
  useArtifactRevisionContent: vi.fn(),
}));

vi.mock('@/lib/hooks', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/hooks');
  return {
    ...actual,
    useMissionRunSources: mocks.useMissionRunSources,
    useMissionRunArtifacts: mocks.useMissionRunArtifacts,
    useArtifactRevisionCitations: mocks.useArtifactRevisionCitations,
    useArtifactRevisionProvenance: mocks.useArtifactRevisionProvenance,
    useCarryForwardOutcomes: mocks.useCarryForwardOutcomes,
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

const COMPANY = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const RUN = '44444444-4444-4444-8444-444444444444';
const ARTIFACT_ID = '55555555-5555-4555-8555-555555555555';
const ARTIFACT_VERSION = 2;

function citation(o: Partial<MissionCitationDetail> = {}): MissionCitationDetail {
  return {
    citationId: 'cite-1',
    ordinal: 1,
    quote: 'The quick brown fox.',
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
    ...o,
  };
}

function provenance(o: Partial<MissionProvenanceDetail> = {}): MissionProvenanceDetail {
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
    newerSourceRevisionExists: false,
    ...o,
  };
}

function artifactSummary(o: Partial<MissionArtifactSummary> = {}): MissionArtifactSummary {
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
        spans: [
          { type: 'text', text: 'According to the report, ' },
          { type: 'citation', citationId: 'cite-1' },
          { type: 'text', text: ' the findings are significant.' },
        ],
      },
    ],
  };
}

function evt(seq: number, type: string, p: Record<string, unknown>): MissionReplayEvent {
  return {
    sequence: seq,
    type,
    schemaVersion: 1,
    payload: p,
    commandId: null,
    actorType: 'system',
    actorId: null,
    traceId: null,
    occurredAt: '2026-08-24T10:00:00.000Z',
  };
}

function src(o: Partial<MissionSourceSummary> = {}): MissionSourceSummary {
  return {
    sourceRevisionId: 'src-rev-1',
    sourceId: 'src-1',
    runId: RUN,
    canonicalUrl: 'https://example.com/report',
    contentHash: 'c'.repeat(64),
    byteCount: 4096,
    retrievedAt: '2026-08-24T10:01:00.000Z',
    rank: 0,
    relevanceScore: 0.92,
    status: 'available',
    provider: 'tavily',
    operation: 'search',
    injectionRiskLabels: [],
    warnings: [],
    excluded: false,
    exclusionReason: null,
    selected: true,
    latestAvailabilityStatus: null,
    latestAvailabilityCheckedAt: null,
    ...o,
  };
}

function renderWP(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function setupMocks(
  opts: {
    citations?: MissionCitationDetail[];
    provenance?: MissionProvenanceDetail | null;
    carryForward?: CarryForwardOutcome[];
  } = {},
) {
  mocks.useMissionRunArtifacts.mockReturnValue({
    data: { artifacts: [artifactSummary()] },
    isLoading: false,
    isError: false,
  });
  mocks.useArtifactRevisionCitations.mockReturnValue({
    data: { citations: opts.citations ?? [citation()] },
    isLoading: false,
    isError: false,
  });
  mocks.useArtifactRevisionProvenance.mockReturnValue({
    data: opts.provenance ?? provenance(),
    isLoading: false,
    isError: false,
  });
  mocks.useCarryForwardOutcomes.mockReturnValue({
    data: { outcomes: opts.carryForward ?? [] },
    isLoading: false,
    isError: false,
  });
  mocks.useArtifactRevisionContent.mockReturnValue({
    data: { content: doc() },
    isLoading: false,
    isError: false,
  });
}

function mockSources(s: MissionSourceSummary[], loading = false, error = false) {
  mocks.useMissionRunSources.mockReturnValue({
    data: loading ? undefined : { sources: s, runId: RUN },
    isLoading: loading,
    isError: error,
    isFetching: loading,
    refetch: vi.fn(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setupMocks();
});

// -- VAL-RES-080: Keyboard-only research review ---------------------------

describe('VAL-RES-080: Keyboard-only research review', () => {
  it('keyboard-only navigation through research progress and sources', () => {
    const events = [
      evt(1, 'research.started', {}),
      evt(2, 'research.source_discovered', { sourceRevisionId: 'src-rev-1' }),
      evt(3, 'research.source_retrieved', { sourceRevisionId: 'src-rev-1' }),
      evt(4, 'research.completed', { sourceCount: 1 }),
    ];
    mockSources([src()]);
    renderWP(
      <>
        <MissionResearchProgress events={events} runId={RUN} />
        <MissionSourceList
          companyId={COMPANY}
          projectId={PROJECT}
          runId={RUN}
          events={events}
          partialResultPolicy="require_all"
          runStatus="completed"
        />
      </>,
    );
    expect(screen.getByRole('list', { name: 'Research progress' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Research sources' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Research progress' })).getAllByRole('listitem')
        .length,
    ).toBeGreaterThan(0);
    expect(
      within(screen.getByRole('list', { name: 'Research sources' })).getAllByRole('listitem')
        .length,
    ).toBeGreaterThan(0);
  });

  it('opens and closes provenance drawer using only keyboard', () => {
    setupMocks();
    renderWP(
      <MissionArtifactCitations
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        artifactId={ARTIFACT_ID}
        artifactVersion={ARTIFACT_VERSION}
        content={doc()}
      />,
    );
    const mark = screen.getByRole('button', { name: /citation 1/i });
    mark.focus();
    fireEvent.keyDown(mark, { key: 'Enter' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

// -- VAL-RES-081: Accessible research semantics --------------------------

describe('VAL-RES-081: Accessible research semantics', () => {
  it('citation marks have aria-expanded and aria-controls referencing the drawer', () => {
    setupMocks();
    renderWP(
      <MissionArtifactCitations
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        artifactId={ARTIFACT_ID}
        artifactVersion={ARTIFACT_VERSION}
        content={doc()}
      />,
    );
    const mark = screen.getByRole('button', { name: /citation 1/i });
    expect(mark).toHaveAttribute('aria-expanded', 'false');
    expect(mark).toHaveAttribute('aria-controls');
    fireEvent.click(mark);
    expect(mark).toHaveAttribute('aria-expanded', 'true');
  });
});

// -- VAL-RES-082: Research live-region behavior ---------------------------

describe('VAL-RES-082: Research live-region behavior', () => {
  it('has a polite live region for source state changes', () => {
    mockSources([src({ sourceRevisionId: 's-1' })]);
    renderWP(
      <MissionSourceList
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        events={[]}
        partialResultPolicy="require_all"
        runStatus="running"
      />,
    );
    expect(document.querySelector('[aria-live="polite"]')).toBeInTheDocument();
  });
});

// -- VAL-RES-083: Mobile artifact provenance (320px) ----------------------

describe('VAL-RES-083: Mobile artifact provenance at 320px', () => {
  it('provenance drawer reflows to full width', () => {
    setupMocks();
    renderWP(
      <MissionProvenanceDrawer
        open={true}
        citation={citation()}
        provenance={provenance()}
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('dialog').className).toContain('w-full');
  });

  it('source cards use break-words to prevent horizontal overflow', () => {
    mockSources([src()]);
    renderWP(
      <MissionSourceList
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        events={[]}
        partialResultPolicy="require_all"
        runStatus="running"
      />,
    );
    within(screen.getByRole('list', { name: 'Research sources' }))
      .getAllByRole('listitem')
      .forEach((item) => {
        expect(item.className).toContain('break-words');
      });
  });
});

// -- VAL-RES-084: Mobile long-content resilience --------------------------

describe('VAL-RES-084: Mobile long-content resilience', () => {
  it('wraps long canonical URLs with break-all', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(200);
    mockSources([src({ canonicalUrl: longUrl })]);
    renderWP(
      <MissionSourceList
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        events={[]}
        partialResultPolicy="require_all"
        runStatus="running"
      />,
    );
    const urlEl = screen.getByTestId('source-canonical-url');
    expect(urlEl.className).toContain('break-all');
    expect(urlEl).toHaveTextContent(longUrl);
  });

  it('wraps long quotes in provenance drawer with break-words', () => {
    const longQuote = 'A'.repeat(500);
    setupMocks({ citations: [citation({ quote: longQuote })] });
    renderWP(
      <MissionProvenanceDrawer
        open={true}
        citation={citation({ quote: longQuote })}
        provenance={provenance()}
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        onClose={vi.fn()}
      />,
    );
    const quoteEl = within(screen.getByRole('dialog')).getByText(longQuote);
    expect(quoteEl.closest('.break-words')).not.toBeNull();
  });

  it('wraps long source revision IDs with break-all', () => {
    const longId = 'src-rev-' + 'x'.repeat(100);
    setupMocks({ citations: [citation({ sourceRevisionId: longId })] });
    renderWP(
      <MissionProvenanceDrawer
        open={true}
        citation={citation({ sourceRevisionId: longId })}
        provenance={provenance()}
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        onClose={vi.fn()}
      />,
    );
    expect(within(screen.getByRole('dialog')).getByText(longId).className).toContain('break-all');
  });

  it('wraps long provider error messages with break-words', () => {
    const longError = 'E'.repeat(300);
    mockSources([]);
    renderWP(
      <MissionSourceList
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        events={[
          evt(1, 'research.failed', {
            failureCategory: 'provider_transient',
            failureCode: 'RESEARCH_TIMEOUT',
            safeErrorMessage: longError,
          }),
        ]}
        partialResultPolicy="require_all"
        runStatus="failed"
      />,
    );
    expect(screen.getByText(longError).className).toContain('break-words');
  });
});

// -- VAL-RES-085: Reduced-motion research UI ------------------------------

describe('VAL-RES-085: Reduced-motion research UI', () => {
  it('citation mark has motion-reduce transition class', () => {
    renderWP(
      <MissionCitationMark ordinal={1} citationId="cite-1" onSelect={vi.fn()} isTarget={true} />,
    );
    expect(screen.getByRole('button', { name: /citation 1/i }).className).toContain(
      'motion-reduce',
    );
  });

  it('source loading spinner respects reduced motion', () => {
    mockSources([], true);
    renderWP(
      <MissionSourceList
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        events={[]}
        partialResultPolicy="require_all"
        runStatus="running"
      />,
    );
    expect(document.querySelector('.animate-pulse')?.getAttribute('class')).toContain(
      'motion-reduce',
    );
  });

  it('provenance drawer does not use nonessential animation', () => {
    setupMocks();
    renderWP(
      <MissionProvenanceDrawer
        open={true}
        citation={citation()}
        provenance={provenance()}
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        onClose={vi.fn()}
      />,
    );
    const drawer = screen.getByRole('dialog');
    expect(drawer.className).not.toContain('animate-');
    expect(drawer.className).not.toContain('transition-');
  });
});

// -- VAL-RES-086: Accessible unavailable and stale states ----------------

describe('VAL-RES-086: Accessible unavailable and stale states', () => {
  it('communicates unavailable sources with explicit text and check time', () => {
    mockSources([
      src({
        sourceRevisionId: 's-unav',
        latestAvailabilityStatus: 'unavailable',
        latestAvailabilityCheckedAt: '2026-08-24T10:02:00.000Z',
      }),
    ]);
    renderWP(
      <MissionSourceList
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        events={[]}
        partialResultPolicy="require_all"
        runStatus="running"
      />,
    );
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByText(/Last availability check/i)).toBeInTheDocument();
  });

  it('stale citations show explicit text and a clear next action', () => {
    const stale: CarryForwardOutcome[] = [
      {
        previousCitationId: 'cite-old-1',
        ordinal: 1,
        outcome: 'not_carried_forward',
        reason: 'passage changed',
      },
    ];
    setupMocks({ carryForward: stale });
    renderWP(
      <MissionArtifactCitations
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        artifactId={ARTIFACT_ID}
        artifactVersion={ARTIFACT_VERSION}
        content={doc()}
      />,
    );
    expect(screen.getByTestId('stale-citation-notice')).toBeInTheDocument();
    expect(screen.getAllByText(/not carried forward/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/prior revision remains fully resolvable/i)).toBeInTheDocument();
  });

  it('unavailable source aria-label includes state text', () => {
    mockSources([
      src({
        sourceRevisionId: 's-unav',
        latestAvailabilityStatus: 'unavailable',
        latestAvailabilityCheckedAt: '2026-08-24T10:02:00.000Z',
      }),
    ]);
    renderWP(
      <MissionSourceList
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        events={[]}
        partialResultPolicy="require_all"
        runStatus="running"
      />,
    );
    expect(
      within(screen.getByRole('list', { name: 'Research sources' }))
        .getByRole('listitem')
        .getAttribute('aria-label'),
    ).toContain('Unavailable');
  });
});

// -- VAL-RES-087: Mobile external-link safety ------------------------------

describe('VAL-RES-087: Mobile external-link safety', () => {
  it('external source link opens in a new tab preserving Mission context', () => {
    setupMocks();
    renderWP(
      <MissionProvenanceDrawer
        open={true}
        citation={citation()}
        provenance={provenance()}
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        onClose={vi.fn()}
      />,
    );
    const link = screen.getByRole('link', { name: /view source.*opens in a new tab/i });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  });
});

// -- VAL-RES-104: Provenance focus and citation relationships --------------

describe('VAL-RES-104: Provenance focus and citation relationships', () => {
  it('opening a citation focuses the drawer close button', () => {
    setupMocks();
    renderWP(
      <MissionArtifactCitations
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        artifactId={ARTIFACT_ID}
        artifactVersion={ARTIFACT_VERSION}
        content={doc()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /citation 1/i }));
    expect(screen.getByRole('button', { name: /close provenance drawer/i })).toHaveFocus();
  });

  it('Escape closes the drawer and restores focus to the citation mark', () => {
    setupMocks();
    renderWP(
      <MissionArtifactCitations
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        artifactId={ARTIFACT_ID}
        artifactVersion={ARTIFACT_VERSION}
        content={doc()}
      />,
    );
    const mark = screen.getByRole('button', { name: /citation 1/i });
    fireEvent.click(mark);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mark).toHaveFocus();
  });

  it('drawer has aria-modal=true', () => {
    setupMocks();
    renderWP(
      <MissionProvenanceDrawer
        open={true}
        citation={citation()}
        provenance={provenance()}
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  });
});

// -- VAL-RES-106: Research UI reflows and retains contrast ----------------

describe('VAL-RES-106: Research UI reflows and retains contrast', () => {
  it('research sections use w-full and break-words', () => {
    const events = [evt(1, 'research.started', {})];
    mockSources([src()]);
    renderWP(
      <>
        <MissionResearchProgress events={events} runId={RUN} />
        <MissionSourceList
          companyId={COMPANY}
          projectId={PROJECT}
          runId={RUN}
          events={events}
          partialResultPolicy="require_all"
          runStatus="running"
        />
      </>,
    );
    const prog = screen.getByTestId('mission-research-progress');
    expect(prog.className).toContain('w-full');
    expect(prog.className).toContain('break-words');
    const srcs = screen.getByTestId('mission-sources');
    expect(srcs.className).toContain('w-full');
    expect(srcs.className).toContain('break-words');
  });

  it('source card headers use flex-wrap', () => {
    mockSources([src()]);
    renderWP(
      <MissionSourceList
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        events={[]}
        partialResultPolicy="require_all"
        runStatus="running"
      />,
    );
    const header = document.querySelector(
      '[data-testid="source-provider-metadata"]',
    )?.parentElement;
    expect(header?.className).toContain('flex-wrap');
  });

  it('focus indicators present on interactive elements', () => {
    mockSources([src()]);
    renderWP(
      <MissionSourceList
        companyId={COMPANY}
        projectId={PROJECT}
        runId={RUN}
        events={[]}
        partialResultPolicy="require_all"
        runStatus="running"
      />,
    );
    document.querySelectorAll('button').forEach((btn) => {
      expect(btn.className).toContain('focus-visible:ring');
    });
  });
});
