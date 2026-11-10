import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CostDashboard, changePct, formatUsd } from '../src/components/analytics/CostDashboard';
import type { CostBreakdown } from '../src/lib/api';

const mocks = vi.hoisted(() => ({
  useCostBreakdown: vi.fn(),
  useAnalyticsOverview: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock('@/lib/hooks', () => ({
  useCostBreakdown: mocks.useCostBreakdown,
  useAnalyticsOverview: mocks.useAnalyticsOverview,
}));

const COMPANY = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const THREAD = '33333333-3333-4333-8333-333333333333';
const RUN = '44444444-4444-4444-8444-444444444444';
const AGENT = '55555555-5555-4555-8555-555555555555';

function breakdown(overrides: Partial<CostBreakdown> = {}): CostBreakdown {
  return {
    range: { days: 7, from: '2026-11-03T00:00:00.000Z', to: '2026-11-10T00:00:00.000Z' },
    totals: { costCents: 12_000, inputTokens: 900_000, outputTokens: 100_000, callCount: 40 },
    previous: { costCents: 8_000, callCount: 31 },
    daily: [
      { date: '2026-11-03', costCents: 1_000, callCount: 4 },
      { date: '2026-11-04', costCents: 0, callCount: 0 },
      { date: '2026-11-05', costCents: 2_000, callCount: 6 },
      { date: '2026-11-06', costCents: 500, callCount: 1 },
      { date: '2026-11-07', costCents: 6_000, callCount: 20 },
      { date: '2026-11-08', costCents: 1_500, callCount: 5 },
      { date: '2026-11-09', costCents: 1_000, callCount: 4 },
    ],
    byAgent: [
      {
        agentId: AGENT,
        name: 'Atlas',
        role: 'ceo',
        status: 'idle',
        budgetMonthlyCents: 90_000,
        costCents: 9_000,
        inputTokens: 700_000,
        outputTokens: 80_000,
        callCount: 30,
      },
      {
        agentId: null,
        name: null,
        role: null,
        status: null,
        budgetMonthlyCents: 0,
        costCents: 3_000,
        inputTokens: 200_000,
        outputTokens: 20_000,
        callCount: 10,
      },
    ],
    byModel: [
      {
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        costCents: 12_000,
        inputTokens: 900_000,
        outputTokens: 100_000,
        callCount: 40,
      },
    ],
    runs: {
      totalCount: 1,
      costCents: 4_500,
      items: [
        {
          runId: RUN,
          projectId: PROJECT,
          projectThreadId: THREAD,
          projectName: 'GuardXChange launch',
          summary: 'Compare background-check vendors',
          status: 'awaiting_approval',
          mode: 'deep_work',
          chargedRunCount: 3,
          lastChargeAt: '2026-11-09T12:00:00.000Z',
          costCents: 4_500,
          inputTokens: 300_000,
          outputTokens: 40_000,
          callCount: 12,
        },
      ],
    },
    ...overrides,
  };
}

function query(data: CostBreakdown | undefined, state: Record<string, unknown> = {}) {
  return {
    data,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: mocks.refetch,
    ...state,
  };
}

function renderDashboard() {
  return render(
    <MemoryRouter initialEntries={[`/company/${COMPANY}/analytics`]}>
      <Routes>
        <Route path="/company/:companyId/analytics" element={<CostDashboard />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('changePct', () => {
  it('compares against the previous window', () => {
    expect(changePct(12_000, 8_000)).toBe(50);
    expect(changePct(4_000, 8_000)).toBe(-50);
    expect(changePct(8_000, 8_000)).toBe(0);
  });

  it('declines to compare against nothing', () => {
    expect(changePct(500, 0)).toBeNull();
  });
});

describe('formatUsd', () => {
  it('formats cents as dollars', () => {
    expect(formatUsd(123_456)).toBe('$1,234.56');
    expect(formatUsd(0)).toBe('$0.00');
  });
});

describe('CostDashboard', () => {
  beforeEach(() => {
    mocks.useCostBreakdown.mockReset();
    mocks.useAnalyticsOverview.mockReset();
    mocks.refetch.mockReset();
    mocks.useAnalyticsOverview.mockReturnValue({
      data: { costs: { budgetCents: 250_000, spentThisMonthCents: 50_000 } },
    });
  });

  it('shows totals, the change against the prior window and month-to-date budget', () => {
    mocks.useCostBreakdown.mockReturnValue(query(breakdown()));
    renderDashboard();

    const spend = within(screen.getByTestId('cost-stat-spend'));
    expect(spend.getByText('$120.00')).toBeInTheDocument();
    expect(spend.getByText('+50%')).toBeInTheDocument();

    expect(within(screen.getByTestId('cost-stat-daily')).getByText('$17.14')).toBeInTheDocument();
    expect(within(screen.getByTestId('cost-stat-tokens')).getByText('1M')).toBeInTheDocument();
    const month = within(screen.getByTestId('cost-stat-month'));
    expect(month.getByText('$500.00')).toBeInTheDocument();
    expect(month.getByText('20% of $2,500.00 budget')).toBeInTheDocument();
  });

  it('says so when there is no prior spend to compare against', () => {
    mocks.useCostBreakdown.mockReturnValue(
      query(breakdown({ previous: { costCents: 0, callCount: 0 } })),
    );
    renderDashboard();

    expect(screen.getByText('No spend in the prior 7 days')).toBeInTheDocument();
  });

  it('labels figures with the window they came from while the next one loads', async () => {
    mocks.useCostBreakdown.mockReturnValue(query(breakdown(), { isFetching: true }));
    renderDashboard();

    // 30 days is selected by default; the data on screen is still a 7-day window.
    expect(
      within(screen.getByTestId('cost-stat-spend')).getByText('Spend, 7 days'),
    ).toBeInTheDocument();
    expect(within(screen.getByTestId('cost-stat-daily')).getByText('$17.14')).toBeInTheDocument();
  });

  it('requests the selected window', async () => {
    mocks.useCostBreakdown.mockReturnValue(query(breakdown()));
    renderDashboard();

    expect(mocks.useCostBreakdown).toHaveBeenLastCalledWith(COMPANY, 30);
    expect(screen.getByRole('button', { name: '30 days' })).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(screen.getByRole('button', { name: '90 days' }));

    expect(mocks.useCostBreakdown).toHaveBeenLastCalledWith(COMPANY, 90);
    expect(screen.getByRole('button', { name: '90 days' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '30 days' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('exposes the daily series to assistive technology as a table', () => {
    mocks.useCostBreakdown.mockReturnValue(query(breakdown()));
    renderDashboard();

    expect(
      screen.getByRole('img', {
        name: 'Daily spend from Nov 3 to Nov 9. Peak $60.00 on Nov 7.',
      }),
    ).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Daily spend' });
    expect(within(table).getAllByRole('row')).toHaveLength(8);
    expect(within(table).getByRole('row', { name: 'Nov 7 $60.00 20' })).toBeInTheDocument();
  });

  it('lists agents with their share and names spend that has no billing agent', () => {
    mocks.useCostBreakdown.mockReturnValue(query(breakdown()));
    renderDashboard();

    const agents = within(screen.getByTestId('cost-by-agent'));
    expect(agents.getByRole('link', { name: 'Atlas' })).toHaveAttribute(
      'href',
      `/company/${COMPANY}/agents/${AGENT}`,
    );
    expect(agents.getByText('CEO · $900.00 monthly budget')).toBeInTheDocument();
    expect(agents.getByText('75% · 30 calls')).toBeInTheDocument();
    expect(agents.getByText('Not billed to an agent')).toBeInTheDocument();
    expect(agents.getByText('25% · 10 calls')).toBeInTheDocument();
  });

  it('links each Mission run to its thread and shows its state in words', () => {
    mocks.useCostBreakdown.mockReturnValue(query(breakdown()));
    renderDashboard();

    const runs = within(screen.getByTestId('cost-by-run'));
    const link = runs.getByRole('link', { name: 'Compare background-check vendors' });
    expect(link).toHaveAttribute(
      'href',
      `/company/${COMPANY}/projects/${PROJECT}?tab=work&thread=${THREAD}&mission=${RUN}`,
    );
    expect(runs.getByText('Needs approval')).toBeInTheDocument();
    expect(runs.getByText('GuardXChange launch · Deep work · 3 runs in tree')).toBeInTheDocument();
    expect(screen.getByText('$45.00 across 1 run')).toBeInTheDocument();
  });

  it('omits the Mission section when cost monitoring is off for the company', () => {
    mocks.useCostBreakdown.mockReturnValue(query(breakdown({ runs: null })));
    renderDashboard();

    expect(screen.queryByText('Mission runs')).not.toBeInTheDocument();
    expect(screen.getByTestId('cost-by-agent')).toBeInTheDocument();
  });

  it('shows an empty state instead of empty charts when nothing was spent', () => {
    mocks.useCostBreakdown.mockReturnValue(
      query(
        breakdown({
          totals: { costCents: 0, inputTokens: 0, outputTokens: 0, callCount: 0 },
          previous: { costCents: 0, callCount: 0 },
          byAgent: [],
          byModel: [],
          runs: { items: [], totalCount: 0, costCents: 0 },
        }),
      ),
    );
    renderDashboard();

    expect(screen.getByText('No spend in the last 7 days')).toBeInTheDocument();
    expect(screen.queryByText('Daily spend')).not.toBeInTheDocument();
  });

  it('fails visibly and offers a retry', async () => {
    mocks.useCostBreakdown.mockReturnValue(query(undefined, { isError: true }));
    renderDashboard();

    expect(screen.getByText('Spend could not be loaded')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });
});
